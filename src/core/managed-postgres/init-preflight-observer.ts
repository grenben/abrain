import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { managedPaths, validateExistingManagedAncestry, type ManagedPaths, type OwnerMetadata } from './ownership.ts';
import { renderManagedPostgresConfig } from './identity.ts';
import { parseFileOnlyConfig } from '../config-file-parser.ts';
import { validateManagedPostgresReference } from '../engine-target.ts';
import {
  classifyManagedInitPreflight, ManagedInitPreflightRefusal, type InitConfigObservation,
  type ManagedInitArtifactObservation, type ManagedInitPreflightInput,
  type ManagedInitPreflightResult, type ManagedInitRootObservation,
  type ManagedInitOwnerObservation, type ManagedInitLockObservation,
} from './init-preflight.ts';

const MAX_CONFIG = 1024 * 1024;
const MAX_OWNER = 32 * 1024;
const MAX_CREDENTIALS = 16 * 1024;
const MAX_RECEIPT = 16 * 1024;
const MAX_SECRET = 8 * 1024;
const MAX_MARKER = 512;
const MAX_LOG = 1024 * 1024;
const MAX_PG_VERSION = 32;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const OWNER_ID = 'gbrain-managed-postgres';
const CLUSTER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const ROOT_ENTRIES = new Set(['owner.json', 'credentials.json', 'init-receipt.json', 'data', 'log', 'socket', 'pgpass', 'pwfile']);

export interface InspectManagedInitCommandEligibilityInput {
  configDir: string;
  uid: number;
  acceptedEnvironmentUrl: boolean;
  canonicalPgliteArtifactPaths: readonly string[];
  /** Deterministic race instrumentation for tests; production callers omit this. */
  testHooks?: ManagedInitObserverTestHooks;
}

export type ManagedInitCommandEligibility =
  | { kind: 'unpublished' }
  | { kind: 'published'; reference: { manager_id: typeof OWNER_ID; cluster_id: string } };

export interface InspectManagedInitPreflightInput {
  configDir: string;
  root: string;
  uid: number;
  acceptedEnvironmentUrl: boolean;
  canonicalPgliteArtifactPaths: readonly string[];
  /** Deterministic race instrumentation for tests; production callers omit this. */
  testHooks?: ManagedInitObserverTestHooks;
}

export interface ManagedInitObserverTestHooks {
  /** Overrides only lstat; descriptor, parsing, final checks and all omitted calls remain production implementations. */
  lstatSync?: (path: string) => Stats;
  afterInitialLstat?(path: string): void;
  afterDescriptorRead?(path: string): void;
  beforeFinalArtifactVerification?(paths: readonly string[]): void;
}

interface FileObservation { path: string; identity: Stats | null; bytes: Buffer | null; limit: number; privateMode: boolean; }
interface DirectoryObservation { path: string; identity: Stats | null; entries: readonly string[] | null; }
interface ReadSession { hooks?: ManagedInitObserverTestHooks; files: FileObservation[]; directories: DirectoryObservation[]; }
interface PinnedText { path: string; identity: Stats; bytes: Buffer; text: string; }
interface NativeReceipt {
  formatVersion: 1; managerId: string; clusterId: string; uid: number; dataPath: string; pgMajor: 17;
  systemIdentifier: string; sha256: { postgresqlConf: string; pgHbaConf: string; postgresqlAutoConf: string };
}

function refuse(): never { throw new ManagedInitPreflightRefusal(); }
function enoent(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'; }
function lstatOrAbsent(path: string, session?: ReadSession): Stats | null {
  try {
    const stat = session?.hooks?.lstatSync ? session.hooks.lstatSync(path) : lstatSync(path);
    session?.hooks?.afterInitialLstat?.(path);
    return stat;
  } catch (error) { if (enoent(error)) return null; return refuse(); }
}
function isWithin(path: string, parent: string): boolean {
  const fromParent = relative(parent, path);
  return fromParent === '' || (fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
}
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function sameMetadata(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.mode === right.mode && left.uid === right.uid && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function directoryIdentity(left: Stats | null, right: Stats | null): boolean {
  return left === null ? right === null : right !== null && sameMetadata(left, right);
}
function canonicalVarAlias(path: string): string {
  if (path !== '/var' && !path.startsWith('/var/')) return path;
  try { return realpathSync('/var') === '/private/var' ? `/private${path}` : path; } catch { return path; }
}
function assertSafeAncestry(path: string, uid?: number, hooks?: ManagedInitObserverTestHooks): void {
  if (!isAbsolute(path) || resolve(path) !== path) refuse();
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatOrAbsent(current, hooks ? { hooks, files: [], directories: [] } : undefined);
    if (!stat) continue;
    const isVerifiedVarAlias = current === '/var' && stat.isSymbolicLink() && canonicalVarAlias(current) === '/private/var';
    const stickyRootDirectory = stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if ((!stat.isDirectory() && !isVerifiedVarAlias) || (stat.mode & 0o022) !== 0 && !stickyRootDirectory ||
        uid !== undefined && stat.uid !== 0 && stat.uid !== uid || current === path && uid !== undefined && stat.uid !== uid) refuse();
    let actual: string;
    try { actual = realpathSync(current); } catch { return refuse(); }
    if (actual !== canonicalVarAlias(current)) refuse();
  }
}
function prepareHome(configDirInput: string, uid: number, hooks?: ManagedInitObserverTestHooks): string {
  if (!isAbsolute(configDirInput) || !Number.isInteger(uid) || uid < 0) refuse();
  const configDir = canonicalVarAlias(resolve(configDirInput));
  assertSafeAncestry(configDir, uid, hooks);
  return configDir;
}
function prepareFullPaths(input: InspectManagedInitPreflightInput): { configDir: string; root: string; paths: ManagedPaths & { configFile: string } } {
  const configDir = prepareHome(input.configDir, input.uid, input.testHooks);
  if (!isAbsolute(input.root)) refuse();
  const root = canonicalVarAlias(resolve(input.root));
  assertSafeAncestry(root, input.uid, input.testHooks);
  const paths = { ...managedPaths(configDir, root), configFile: join(configDir, 'config.json') };
  if (paths.configDir !== configDir || paths.root !== root) refuse();
  return { configDir, root, paths };
}
function managedAncestry(paths: ManagedPaths): string[] {
  const chain: string[] = [];
  let current = paths.root;
  while (current !== paths.configDir) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current || !isWithin(parent, paths.configDir)) refuse();
    current = parent;
  }
  chain.push(paths.configDir);
  return chain;
}
function isPrivateFile(stat: Stats, uid: number, privateMode: boolean): boolean {
  return stat.isFile() && stat.uid === uid && (privateMode ? (stat.mode & 0o777) === PRIVATE_FILE_MODE : (stat.mode & 0o022) === 0 && (stat.mode & 0o400) !== 0);
}
function decodeUtf8(bytes: Buffer): string { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }

function readPinnedText(session: ReadSession, path: string, uid: number, limit: number, optional = false, privateMode = true): PinnedText | null {
  const before = lstatOrAbsent(path, session);
  if (!before) {
    if (!optional) refuse();
    session.files.push({ path, identity: null, bytes: null, limit, privateMode });
    return null;
  }
  if (before.isSymbolicLink() || !isPrivateFile(before, uid, privateMode) || before.size > limit) refuse();
  if (typeof constants.O_NOFOLLOW !== 'number') refuse();
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0)); } catch { return refuse(); }
  try {
    const opened = fstatSync(fd);
    if (!isPrivateFile(opened, uid, privateMode) || !sameMetadata(before, opened) || opened.size > limit) refuse();
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(Math.min(16 * 1024, limit + 1));
    let total = 0;
    while (true) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, limit + 1 - total), null);
      if (!count) break;
      total += count;
      if (total > limit) refuse();
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    const bytes = Buffer.concat(chunks);
    session.hooks?.afterDescriptorRead?.(path);
    const after = lstatOrAbsent(path, session);
    if (!after || after.isSymbolicLink() || !sameMetadata(opened, after) || bytes.length !== opened.size) refuse();
    const text = decodeUtf8(bytes);
    session.files.push({ path, identity: opened, bytes, limit, privateMode });
    return { path, identity: opened, bytes, text };
  } finally { closeSync(fd); }
}

function readPinnedDirectory(session: ReadSession, path: string, uid: number, optional = false): readonly string[] | null {
  const before = lstatOrAbsent(path, session);
  if (!before) {
    if (!optional) refuse();
    session.directories.push({ path, identity: null, entries: null });
    return null;
  }
  if (before.isSymbolicLink() || !before.isDirectory() || before.uid !== uid || (before.mode & 0o777) !== PRIVATE_DIR_MODE ||
      typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_DIRECTORY !== 'number') refuse();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.uid !== uid || (opened.mode & 0o777) !== PRIVATE_DIR_MODE || !sameMetadata(before, opened)) refuse();
    const entries = readdirSync(path).sort();
    const after = lstatOrAbsent(path, session);
    if (!after || !sameMetadata(opened, after) || !sameMetadata(opened, fstatSync(fd))) refuse();
    session.directories.push({ path, identity: opened, entries });
    return entries;
  } finally { closeSync(fd); }
}

function verifySession(session: ReadSession, uid: number): void {
  for (const file of session.files) {
    if (!file.identity) { if (lstatOrAbsent(file.path, session)) refuse(); continue; }
    const verification: ReadSession = { hooks: session.hooks, files: [], directories: [] };
    const current = readPinnedText(verification, file.path, uid, file.limit, false, file.privateMode)!;
    if (!sameMetadata(file.identity, current.identity) || !file.bytes?.equals(current.bytes)) refuse();
  }
  for (const directory of session.directories) {
    if (!directory.identity) { if (lstatOrAbsent(directory.path, session)) refuse(); continue; }
    const verification: ReadSession = { hooks: session.hooks, files: [], directories: [] };
    const entries = readPinnedDirectory(verification, directory.path, uid)!;
    const current = verification.directories[0]!.identity!;
    if (!sameMetadata(directory.identity, current) || entries.length !== directory.entries!.length ||
        entries.some((entry, index) => entry !== directory.entries![index])) refuse();
  }
}

function parseObject(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return refuse(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  return value as Record<string, unknown>;
}

function observeConfig(session: ReadSession, configDir: string, uid: number): InitConfigObservation {
  const path = join(configDir, 'config.json');
  const before = lstatOrAbsent(path, session);
  if (!before) {
    session.files.push({ path, identity: null, bytes: null, limit: MAX_CONFIG, privateMode: false });
    return { kind: 'absent', path, ancestrySafe: true, finalReread: true };
  }
  if (before.isSymbolicLink()) return { kind: 'symlink', path };
  if (!before.isFile()) return { kind: 'nonregular', path };
  try {
    const pinned = readPinnedText(session, path, uid, MAX_CONFIG, false, false)!;
    return { kind: 'valid', path, fileType: 'regular', ancestrySafe: true, finalReread: true, config: parseFileOnlyConfig(pinned.text, false) };
  } catch (error) {
    return { kind: error instanceof ManagedInitPreflightRefusal ? 'ambiguous' : 'malformed', path };
  }
}

function canonicalArtifactPath(path: string, configDir: string, uid: number): string {
  if (!isAbsolute(path) || resolve(path) !== path) refuse();
  const canonical = canonicalVarAlias(path);
  if (canonical === configDir) refuse();
  const fromHome = relative(configDir, canonical);
  if (fromHome === '..' || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) refuse();
  assertSafeAncestry(dirname(canonical), uid);
  return canonical;
}
function observeArtifact(session: ReadSession, path: string, configDir: string, uid: number): ManagedInitArtifactObservation {
  const canonical = canonicalArtifactPath(path, configDir, uid);
  const stat = lstatOrAbsent(canonical, session);
  if (stat) refuse();
  session.files.push({ path: canonical, identity: null, bytes: null, limit: 0, privateMode: true });
  return { path: canonical, canonical: true, state: 'absent' };
}

function inspectConfigTarget(fileConfig: InitConfigObservation, configDir: string): string | null {
  if (fileConfig.path !== join(configDir, 'config.json')) return refuse();
  if (fileConfig.kind === 'absent') return null;
  if (fileConfig.kind !== 'valid' || !fileConfig.config || typeof fileConfig.config !== 'object' || Array.isArray(fileConfig.config)) return refuse();
  const config = fileConfig.config as Record<string, unknown>;
  const hasManaged = Object.hasOwn(config, 'managed_postgres');
  const forbidden = ['database_url', 'database_path', 'remote_mcp', 'thin_client', 'thin_client_url', 'topology'];
  if (!hasManaged) {
    if (Object.hasOwn(config, 'engine') || forbidden.some((key) => Object.hasOwn(config, key))) return refuse();
    return null;
  }
  if (config.engine !== 'postgres' || !Object.hasOwn(config, 'engine') || forbidden.some((key) => Object.hasOwn(config, key))) return refuse();
  try { return validateManagedPostgresReference(config.managed_postgres).cluster_id; } catch { return refuse(); }
}

function observeCommand(session: ReadSession, input: InspectManagedInitCommandEligibilityInput, configDir: string): {
  fileConfig: InitConfigObservation; artifacts: ManagedInitArtifactObservation[]; reference: string | null;
} {
  if (input.acceptedEnvironmentUrl) refuse();
  const fileConfig = observeConfig(session, configDir, input.uid);
  const artifacts = input.canonicalPgliteArtifactPaths.map((path) => observeArtifact(session, path, configDir, input.uid));
  const reference = inspectConfigTarget(fileConfig, configDir);
  return { fileConfig, artifacts, reference };
}

function eligibility(reference: string | null): ManagedInitCommandEligibility {
  return reference === null ? { kind: 'unpublished' } : { kind: 'published', reference: { manager_id: OWNER_ID, cluster_id: reference } };
}

export function inspectManagedInitCommandEligibility(input: InspectManagedInitCommandEligibilityInput): ManagedInitCommandEligibility {
  try {
    const configDir = prepareHome(input.configDir, input.uid, input.testHooks);
    const configIdentity = lstatOrAbsent(configDir);
    const session: ReadSession = { hooks: input.testHooks, files: [], directories: [] };
    observeCommand(session, input, configDir);
    const final = observeCommand(session, input, configDir);
    assertSafeAncestry(configDir, input.uid, input.testHooks);
    if (!directoryIdentity(configIdentity, lstatOrAbsent(configDir))) refuse();
    verifySession(session, input.uid);
    return eligibility(final.reference);
  } catch { return refuse(); }
}

function validateOwner(value: Record<string, unknown>, paths: ManagedPaths, uid: number): OwnerMetadata {
  const owner = value as unknown as OwnerMetadata;
  if (owner.formatVersion !== 1 || owner.managerId !== OWNER_ID || !CLUSTER_ID.test(owner.clusterId) || owner.uid !== uid ||
      owner.configPath !== paths.configDir || owner.rootPath !== paths.root || owner.dataPath !== paths.data || owner.pgMajor !== 17 ||
      owner.controller !== 'manual' || !['allocated', 'initialized', 'provisioned'].includes(owner.phase) ||
      !Number.isInteger(owner.port) || owner.port < 1024 || owner.port > 65535 || [5432, 5434, 6543].includes(owner.port) ||
      typeof owner.binaryPrefix !== 'string' || !isAbsolute(owner.binaryPrefix) || typeof owner.binaryVersion !== 'string' || !owner.binaryVersion ||
      typeof owner.pgvectorVersion !== 'string' || !owner.pgvectorVersion || owner.database !== 'gbrain' || owner.role !== 'gbrain' ||
      typeof owner.socketPath !== 'string' || !isAbsolute(owner.socketPath) ||
      (owner.systemIdentifier !== null && (typeof owner.systemIdentifier !== 'string' || !/^\d+$/.test(owner.systemIdentifier))) ||
      (owner.phase !== 'allocated' && !owner.systemIdentifier) || (owner.lastFailure !== undefined && owner.lastFailure !== 'startup_failure')) refuse();
  if (Buffer.byteLength(join(owner.socketPath, `.s.PGSQL.${owner.port}`)) > 103) refuse();
  return owner;
}

function validateReceipt(value: Record<string, unknown>, paths: ManagedPaths, owner: OwnerMetadata, uid: number): NativeReceipt {
  const receipt = value as unknown as NativeReceipt;
  const hashes = receipt.sha256;
  if (receipt.formatVersion !== 1 || receipt.managerId !== OWNER_ID || receipt.clusterId !== owner.clusterId || receipt.uid !== uid ||
      receipt.dataPath !== paths.data || receipt.pgMajor !== 17 || typeof receipt.systemIdentifier !== 'string' ||
      !/^\d+$/.test(receipt.systemIdentifier) || (owner.systemIdentifier !== null && owner.systemIdentifier !== receipt.systemIdentifier) ||
      !hashes || !HASH.test(hashes.postgresqlConf) || !HASH.test(hashes.pgHbaConf) || !HASH.test(hashes.postgresqlAutoConf)) refuse();
  return receipt;
}
function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

function observeOwner(session: ReadSession, paths: ManagedPaths, uid: number, rootEntries: readonly string[]): ManagedInitOwnerObservation {
  const ownerFile = readPinnedText(session, paths.owner, uid, MAX_OWNER, true);
  if (!ownerFile) return { kind: 'absent', path: paths.owner };
  const owner = validateOwner(parseObject(ownerFile.text), paths, uid);
  const credentialsFile = readPinnedText(session, paths.credentials, uid, MAX_CREDENTIALS)!;
  const credentials = parseObject(credentialsFile.text);
  if (typeof credentials.password !== 'string' || credentials.password.length < 32 || credentials.password.length > 4096) refuse();
  const password = credentials.password;

  const dataEntries = readPinnedDirectory(session, paths.data, uid)!;
  const logEntries = readPinnedDirectory(session, paths.log, uid)!;
  if (logEntries.some((name) => name !== 'postgresql.log' && name !== 'startup.log')) refuse();
  const receiptFile = readPinnedText(session, paths.receipt, uid, MAX_RECEIPT, true);
  let receipt: 'complete' | 'absent' | 'incomplete' = 'absent';
  let data: 'empty' | 'initialized' | 'ambiguous' = 'empty';
  if (dataEntries.length) {
    data = dataEntries.includes('PG_VERSION') ? 'initialized' : 'ambiguous';
    const version = readPinnedText(session, join(paths.data, 'PG_VERSION'), uid, MAX_PG_VERSION)!;
    if (data !== 'initialized' || version.text.trim() !== '17' || !receiptFile) refuse();
    const nativeReceipt = validateReceipt(parseObject(receiptFile.text), paths, owner, uid);
    receipt = 'complete';
    const rendered = renderManagedPostgresConfig(owner, paths);
    const postgresConfig = readPinnedText(session, join(paths.data, 'postgresql.conf'), uid, MAX_CONFIG)!;
    const hbaConfig = readPinnedText(session, join(paths.data, 'pg_hba.conf'), uid, MAX_CONFIG)!;
    const autoConfig = readPinnedText(session, join(paths.data, 'postgresql.auto.conf'), uid, MAX_CONFIG)!;
    if (owner.phase === 'allocated') {
      if ((sha256(postgresConfig.bytes) !== nativeReceipt.sha256.postgresqlConf && postgresConfig.text !== rendered.config) ||
          (sha256(hbaConfig.bytes) !== nativeReceipt.sha256.pgHbaConf && hbaConfig.text !== rendered.hba) ||
          (sha256(autoConfig.bytes) !== nativeReceipt.sha256.postgresqlAutoConf && autoConfig.bytes.length !== 0)) refuse();
    } else if (postgresConfig.text !== rendered.config || hbaConfig.text !== rendered.hba || autoConfig.bytes.length !== 0) refuse();
  } else if (receiptFile) refuse();

  const passText = `${owner.socketPath}:${owner.port}:*:${owner.role}:${password}\n`;
  const passFile = readPinnedText(session, join(paths.root, 'pgpass'), uid, MAX_SECRET, owner.phase === 'allocated');
  if (owner.phase !== 'allocated' && !passFile) refuse();
  if (passFile && passFile.text !== passText) refuse();
  const pwFile = readPinnedText(session, join(paths.root, 'pwfile'), uid, MAX_SECRET, true);
  if (pwFile && pwFile.text !== `${password}\n`) refuse();
  for (const name of logEntries) readPinnedText(session, join(paths.log, name), uid, MAX_LOG);

  assertSafeAncestry(canonicalVarAlias(owner.socketPath), uid);
  const socketEntries = readPinnedDirectory(session, canonicalVarAlias(owner.socketPath), uid)!;
  let socketProvenance: 'complete' | 'incomplete' = 'complete';
  if (!isWithin(canonicalVarAlias(owner.socketPath), paths.root)) {
    const marker = readPinnedText(session, join(canonicalVarAlias(owner.socketPath), '.gbrain-managed-owner'), uid, MAX_MARKER)!;
    if (marker.text !== `${OWNER_ID}:${owner.clusterId}:${uid}`) socketProvenance = 'incomplete';
  } else if (socketEntries.includes('.gbrain-managed-owner')) refuse();
  if (owner.phase === 'allocated' && data === 'empty' && owner.systemIdentifier !== null) refuse();
  if (owner.phase === 'allocated' && data === 'initialized' && receipt !== 'complete') refuse();
  if (!rootEntries.includes('owner.json') || !rootEntries.includes('credentials.json')) refuse();
  return { kind: 'valid', path: paths.owner, owner, credentials: 'complete', receipt, configProvenance: 'complete', socketProvenance, data };
}

function observeManagedState(session: ReadSession, paths: ManagedPaths, uid: number): {
  root: ManagedInitRootObservation; owner: ManagedInitOwnerObservation; lock: ManagedInitLockObservation;
} {
  validateExistingManagedAncestry(paths, uid, paths.configDir);
  const lockStat = lstatOrAbsent(paths.lock);
  session.files.push({ path: paths.lock, identity: lockStat, bytes: null, limit: 0, privateMode: true });
  const entries = readPinnedDirectory(session, paths.root, uid, true);
  const lock: ManagedInitLockObservation = { path: paths.lock, state: lockStat ? 'present' : 'absent' };
  if (!entries) return { root: { kind: 'absent', path: paths.root, ancestrySafe: true }, owner: { kind: 'absent', path: paths.owner }, lock };
  if (entries.some((entry) => !ROOT_ENTRIES.has(entry))) refuse();
  return { root: { kind: 'directory', path: paths.root, ancestrySafe: true, safe: true, entries }, owner: observeOwner(session, paths, uid, entries), lock };
}

function observeFullCommand(session: ReadSession, input: InspectManagedInitPreflightInput, configDir: string): {
  fileConfig: InitConfigObservation; artifacts: ManagedInitArtifactObservation[];
} {
  const command = observeCommand(session, {
    configDir, uid: input.uid, acceptedEnvironmentUrl: input.acceptedEnvironmentUrl,
    canonicalPgliteArtifactPaths: input.canonicalPgliteArtifactPaths, testHooks: input.testHooks,
  }, configDir);
  return { fileConfig: command.fileConfig, artifacts: command.artifacts };
}

function inspectFull(input: InspectManagedInitPreflightInput): ManagedInitPreflightResult {
  const { configDir, root, paths } = prepareFullPaths(input);
  const session: ReadSession = { hooks: input.testHooks, files: [], directories: [] };
  const ancestryIdentities = managedAncestry(paths).map((path) => [path, lstatOrAbsent(path)] as const);
  observeFullCommand(session, input, configDir);
  observeManagedState(session, paths, input.uid);
  const finalState = observeManagedState(session, paths, input.uid);
  const finalCommand = observeFullCommand(session, input, configDir);
  assertSafeAncestry(configDir, input.uid, input.testHooks);
  assertSafeAncestry(root, input.uid);
  for (const [path, identity] of ancestryIdentities) if (!directoryIdentity(identity, lstatOrAbsent(path))) refuse();
  input.testHooks?.beforeFinalArtifactVerification?.(input.canonicalPgliteArtifactPaths);
  verifySession(session, input.uid);
  const observations: ManagedInitPreflightInput = {
    fileConfig: finalCommand.fileConfig, canonicalPgliteArtifacts: finalCommand.artifacts,
    acceptedEnvironmentUrl: input.acceptedEnvironmentUrl, paths, uid: input.uid, ...finalState,
  };
  return classifyManagedInitPreflight(observations);
}

export function inspectManagedInitPreflight(input: InspectManagedInitPreflightInput): ManagedInitPreflightResult {
  try { return inspectFull(input); } catch (error) { if (error instanceof ManagedInitPreflightRefusal) throw error; return refuse(); }
}
