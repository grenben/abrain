import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import type { ManagedPostgresReference } from './types.ts';
import { EngineTargetError, normalizeEngineTarget, validateManagedPostgresReference } from './engine-target.ts';
import { parseFileOnlyConfig } from './config-file-parser.ts';
import { publishConfigFile, withConfigPublicationLock, ConfigPublicationRefusedError,
  ConfigPublicationCommittedCleanupError, ConfigPublicationFailedError, ConfigPublicationUncertainError,
  type ConfigPublicationDependencies, type ConfigPublicationLockDependencies } from './config-publication.ts';

export type ConfigFileStateDependencies = Partial<{
  openSync: typeof openSync;
  fstatSync: typeof fstatSync;
  lstatSync: typeof lstatSync;
  readSync: typeof readSync;
  closeSync: typeof closeSync;
  realpathSync: typeof realpathSync;
}>;

export type ManagedPublicationDependencies = Readonly<{
  file?: ConfigFileStateDependencies;
  lock?: ConfigPublicationLockDependencies;
  publication?: Readonly<ConfigPublicationDependencies>;
}>;

const MAX_CONFIG_BYTES = 1024 * 1024;

function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameMetadata(a: Stats, b: Stats): boolean {
  return sameFile(a, b) && a.mode === b.mode && a.uid === b.uid && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function safeCanonicalDirectory(directory: string, deps: ConfigFileStateDependencies, strictRequestedPath = false): string {
  const realpath = deps.realpathSync ?? realpathSync;
  const lstat = deps.lstatSync ?? lstatSync;
  try {
    const leaf = lstat(directory);
    if (!leaf.isDirectory() || leaf.isSymbolicLink()) throw new ConfigPublicationRefusedError();
    const canonical = realpath(directory);
    if (!isAbsolute(canonical)) throw new ConfigPublicationRefusedError();
    if (strictRequestedPath) {
      if (!isAbsolute(directory)) throw new ConfigPublicationRefusedError();
      let requested = resolve(directory);
      if (requested === '/var' || requested.startsWith('/var/')) {
        try {
          if (lstat('/var').isSymbolicLink() && realpath('/var') === '/private/var') {
            requested = `/private/var${requested.slice(4)}`;
          }
        } catch { throw new ConfigPublicationRefusedError(); }
      }
      if (canonical !== requested) throw new ConfigPublicationRefusedError();
      let component = parse(requested).root;
      const components = requested.slice(component.length).split(sep).filter(Boolean);
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      const checkDirectory = (stat: Stats, final: boolean) => {
        const stickyRootWritable = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
        const groupOrWorldWritable = (stat.mode & 0o022) !== 0;
        const verifiedVarAlias = component === '/var' && stat.isSymbolicLink()
          && realpath('/var') === '/private/var';
        if ((!stat.isDirectory() || stat.isSymbolicLink()) && !verifiedVarAlias) throw new ConfigPublicationRefusedError();
        if (groupOrWorldWritable && !stickyRootWritable) throw new ConfigPublicationRefusedError();
        if (!verifiedVarAlias && uid !== undefined && stat.uid !== uid && stat.uid !== 0) {
          throw new ConfigPublicationRefusedError();
        }
        if (final && uid !== undefined && stat.uid !== uid) throw new ConfigPublicationRefusedError();
      };
      checkDirectory(lstat(component), components.length === 0);
      for (const part of components) {
        component = join(component, part);
        checkDirectory(lstat(component), component === requested);
      }
    }
    let current = parse(canonical).root;
    const rootStat = lstat(current);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new ConfigPublicationRefusedError();
    const relative = canonical.slice(current.length).split(sep).filter(Boolean);
    for (const part of relative) {
      current = join(current, part);
      const stat = lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ConfigPublicationRefusedError();
    }
    return canonical;
  } catch {
    throw new ConfigPublicationRefusedError();
  }
}

/** Strict no-follow snapshot matching loadConfigFileOnly parse/migration rules. */
export function readConfigForPublication(
  directory: string,
  destination: string,
  dependencies: ConfigFileStateDependencies = {},
  strictRequestedPath = false,
  strictFileSnapshot = false,
): Record<string, unknown> | null {
  const canonicalDir = safeCanonicalDirectory(directory, dependencies, strictRequestedPath);
  if (dirname(destination) !== directory) throw new ConfigPublicationRefusedError();
  const canonicalDestination = join(canonicalDir, 'config.json');
  const open = dependencies.openSync ?? openSync;
  const fstat = dependencies.fstatSync ?? fstatSync;
  const lstat = dependencies.lstatSync ?? lstatSync;
  const read = dependencies.readSync ?? readSync;
  const close = dependencies.closeSync ?? closeSync;
  let pathStat: Stats;
  try { pathStat = lstat(canonicalDestination); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === 'ENOENT') return null;
    throw new ConfigPublicationRefusedError();
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > MAX_CONFIG_BYTES
    || (strictFileSnapshot && ((uid !== undefined && pathStat.uid !== uid) || (pathStat.mode & 0o022) !== 0 || (pathStat.mode & 0o400) === 0))) {
    throw new ConfigPublicationRefusedError();
  }
  let fd: number;
  try { fd = open(canonicalDestination, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new ConfigPublicationRefusedError(); }
  try {
    const descriptorStat = fstat(fd);
    if (!descriptorStat.isFile() || !(strictFileSnapshot ? sameMetadata(pathStat, descriptorStat) : sameFile(pathStat, descriptorStat)) || descriptorStat.size > MAX_CONFIG_BYTES
      || (strictFileSnapshot && ((uid !== undefined && descriptorStat.uid !== uid) || (descriptorStat.mode & 0o022) !== 0 || (descriptorStat.mode & 0o400) === 0))) {
      throw new ConfigPublicationRefusedError();
    }
    const namedStat = lstat(canonicalDestination);
    if (!namedStat.isFile() || namedStat.isSymbolicLink() || !(strictFileSnapshot ? sameMetadata(descriptorStat, namedStat) : sameFile(descriptorStat, namedStat))) {
      throw new ConfigPublicationRefusedError();
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.alloc(16 * 1024);
    while (true) {
      const count = read(fd, chunk, 0, Math.min(chunk.length, MAX_CONFIG_BYTES + 1 - total), null);
      if (count === 0) break;
      total += count;
      if (total > MAX_CONFIG_BYTES) throw new ConfigPublicationRefusedError();
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    const afterRead = lstat(canonicalDestination);
    if (!afterRead.isFile() || afterRead.isSymbolicLink() || !(strictFileSnapshot ? sameMetadata(descriptorStat, afterRead) : sameFile(descriptorStat, afterRead))) {
      throw new ConfigPublicationRefusedError();
    }
    try { return parseFileOnlyConfig(strictFileSnapshot
      ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      : Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ConfigPublicationRefusedError(); }
  } finally { try { close(fd); } catch { /* preserve safe refusal/publication outcome */ } }
}

export interface ManagedInitKeylessMetadata { readonly embedding_disabled: true; }

/** Strictly publish one canonical managed reference while preserving current metadata. */
export function publishManagedInitConfigFile(
  reference: ManagedPostgresReference,
  directory: string,
  destination: string,
  dependencies: ManagedPublicationDependencies = {},
): void {
  publishManagedInitConfigFileInternal(reference, directory, destination, undefined, dependencies);
}

/** Init-only publication: the sole metadata addition is the fixed deferred-embedding sentinel. */
export function publishManagedInitConfigForInitFile(
  reference: ManagedPostgresReference,
  directory: string,
  destination: string,
  metadata: ManagedInitKeylessMetadata,
  dependencies: ManagedPublicationDependencies = {},
): void {
  if (metadata.embedding_disabled !== true || Object.keys(metadata).some((key) => key !== 'embedding_disabled')) {
    throw new ConfigPublicationRefusedError();
  }
  publishManagedInitConfigFileInternal(reference, directory, destination, metadata, dependencies);
}

function publishManagedInitConfigFileInternal(
  reference: ManagedPostgresReference,
  directory: string,
  destination: string,
  keyless: ManagedInitKeylessMetadata | undefined,
  dependencies: ManagedPublicationDependencies,
): void {
  try {
    const canonical = validateManagedPostgresReference(reference);
    const canonicalDir = safeCanonicalDirectory(directory, dependencies.file ?? {}, true);
    const canonicalDestination = join(canonicalDir, 'config.json');
    if (dirname(destination) !== directory) throw new ConfigPublicationRefusedError();
    withConfigPublicationLock(canonicalDir, () => {
        const current = readConfigForPublication(canonicalDir, canonicalDestination, dependencies.file, true, true);
      if (current) {
        if (current.managed_postgres === undefined) {
          const declarations = ['engine', 'database_url', 'database_path', 'remote_mcp', 'thin_client', 'thin_client_url', 'topology'];
          if (declarations.some((key) => Object.hasOwn(current, key))) throw new ConfigPublicationRefusedError();
        } else {
          const conflicts = ['database_url', 'database_path', 'remote_mcp', 'thin_client', 'thin_client_url', 'topology'];
          if (current.engine !== 'postgres' || conflicts.some((key) => Object.hasOwn(current, key))) throw new ConfigPublicationRefusedError();
          const existing = validateManagedPostgresReference(current.managed_postgres);
          if (existing.manager_id !== canonical.manager_id || existing.cluster_id !== canonical.cluster_id) {
            throw new ConfigPublicationRefusedError();
          }
        }
      }
      const published = {
        ...(current ?? {}),
        engine: 'postgres',
        managed_postgres: canonical,
        ...(keyless && current?.managed_postgres === undefined ? keyless : {}),
      };
      publishConfigFile(canonicalDestination, Buffer.from(JSON.stringify(published, null, 2) + '\n', 'utf8'),
        dependencies.publication, { directoryDurability: 'strict' });
    }, dependencies.lock);
  } catch (error) {
    if (error instanceof ConfigPublicationRefusedError || error instanceof ConfigPublicationUncertainError
      || error instanceof ConfigPublicationCommittedCleanupError || error instanceof ConfigPublicationFailedError) throw error;
    if (error instanceof EngineTargetError) throw new ConfigPublicationRefusedError();
    throw new ConfigPublicationFailedError();
  }
}

/** Shared save boundary: lock, reread, prevent managed-target replacement, then atomically publish. */
export function saveConfigFile(config: unknown, directory: string, destination: string,
  dependencies: Readonly<ConfigPublicationDependencies> = {}): void {
  const target = normalizeEngineTarget(config as never);
  const canonicalDir = safeCanonicalDirectory(directory, {});
  const canonicalDestination = join(canonicalDir, 'config.json');
  withConfigPublicationLock(canonicalDir, () => {
    const current = readConfigForPublication(canonicalDir, canonicalDestination);
    const existing = current?.managed_postgres === undefined
      ? undefined : validateManagedPostgresReference(current.managed_postgres);
    if (target.kind === 'postgres-managed') {
      if (!existing || target.managed_postgres.cluster_id !== existing.cluster_id
        || target.managed_postgres.manager_id !== existing.manager_id) throw new ConfigPublicationRefusedError();
    } else if (existing) {
      throw new ConfigPublicationRefusedError();
    }
    publishConfigFile(canonicalDestination, Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf8'), dependencies,
      { directoryDurability: target.kind === 'postgres-managed' ? 'strict' : 'allow-unsupported' });
  });
}
