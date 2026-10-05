import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { managedPostgresIdentity, validateManagedPostgresReference } from '../engine-target.ts';
import { renderManagedPostgresConfig, verifyManagedPostgresLiveIdentity, type LiveIdentity } from './identity.ts';
import { assertPrivateFile, managedPaths, readCredentials, readInitializationReceipt, readOwner, validateManagedDirectories, type ManagedPaths, type OwnerMetadata } from './ownership.ts';

export class ManagedPostgresConnectionError extends Error {
  readonly code = 'target_unverified' as const;
  constructor() {
    super('Managed PostgreSQL connection target is unavailable or could not be verified.');
    this.name = 'ManagedPostgresConnectionError';
  }
}

export interface ManagedPostgresDriverOptions {
  path: string;
  port: number;
  database: string;
  user: string;
  ssl: false;
  debug: false;
  password: () => Promise<string>;
}

export interface ManagedPostgresConnectionResolution {
  identity: string;
  reference: { manager_id: 'gbrain-managed-postgres'; cluster_id: string };
  options: ManagedPostgresDriverOptions;
  assertPinnedState(): void;
  hasSecurityFailure(): boolean;
  verifyLiveIdentity(value: unknown): LiveIdentity;
}

function proveConnectionState(reference: unknown, configDir: string, uid: number): { owner: OwnerMetadata; password: string; paths: ManagedPaths } {
  const validReference = validateManagedPostgresReference(reference);
  const paths = managedPaths(configDir);
  const owner = readOwner(paths, uid);
  validateManagedDirectories(paths, owner.socketPath, uid, configDir);
  if (owner.managerId !== validReference.manager_id || owner.clusterId !== validReference.cluster_id || owner.uid !== uid ||
      owner.configPath !== paths.configDir || owner.rootPath !== paths.root || owner.dataPath !== paths.data ||
      owner.phase !== 'provisioned' || owner.systemIdentifier === null) throw new Error();

  const receipt = readInitializationReceipt(paths, owner, uid);
  if (receipt.systemIdentifier !== owner.systemIdentifier) throw new Error();
  const config = renderManagedPostgresConfig(owner, paths);
  assertPrivateFile(join(paths.data, 'postgresql.conf'), uid, config.config);
  assertPrivateFile(join(paths.data, 'pg_hba.conf'), uid, config.hba);
  assertPrivateFile(join(paths.data, 'postgresql.auto.conf'), uid, '');
  assertPrivateFile(join(paths.data, 'PG_VERSION'), uid, '17\n');
  const global = lstatSync(join(paths.data, 'global'));
  if (!global.isDirectory() || global.isSymbolicLink() || global.uid !== uid || (global.mode & 0o777) !== 0o700) throw new Error();
  assertPrivateFile(join(paths.data, 'global', 'pg_control'), uid);
  for (const name of ['pg_wal', 'pg_tblspc']) {
    const stat = lstatSync(join(paths.data, name));
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) throw new Error();
    if (name === 'pg_tblspc' && readdirSync(join(paths.data, name)).length !== 0) throw new Error();
  }
  const { password } = readCredentials(paths, uid);
  return { owner, password, paths };
}

function samePinnedOwner(current: OwnerMetadata, pinned: Omit<OwnerMetadata, 'lastFailure'>): boolean {
  const { lastFailure: _ignored, ...currentIdentity } = current;
  return (Object.keys(pinned) as Array<keyof typeof pinned>).every(key => currentIdentity[key] === pinned[key]);
}

/** Resolve an already-provisioned managed cluster without starting, repairing, or mutating it. */
export function resolveManagedPostgresConnection(
  reference: unknown,
  context: { configDir: string; uid?: number },
): ManagedPostgresConnectionResolution {
  try {
    const validReference = validateManagedPostgresReference(reference);
    const configDir = context.configDir;
    const uid = context.uid ?? process.getuid?.() ?? -1;
    const initial = proveConnectionState(validReference, configDir, uid);
    // Pin provenance as well as connection fields; lastFailure is diagnostic and may change independently.
    const { lastFailure: _ignoredFailure, ...pinnedOwner } = initial.owner;
    const readPinnedState = () => {
      try {
        const current = proveConnectionState(validReference, configDir, uid);
        if (!samePinnedOwner(current.owner, pinnedOwner)) throw new Error();
        return current;
      } catch { throw new ManagedPostgresConnectionError(); }
    };
    let securityFailure = false;
    const assertPinnedState = (): void => { readPinnedState(); };
    const hasSecurityFailure = (): boolean => securityFailure;
    const verifyLiveIdentity = (value: unknown): LiveIdentity => {
      readPinnedState();
      try {
        const verified = verifyManagedPostgresLiveIdentity(value, pinnedOwner, initial.paths, pinnedOwner.database);
        if (!verified) throw new Error();
        return verified;
      } catch { throw new ManagedPostgresConnectionError(); }
    };
    const password = async (): Promise<string> => {
      try { return readPinnedState().password; }
      catch (error) { securityFailure = true; throw error; }
    };
    return {
      identity: managedPostgresIdentity(validReference), reference: validReference, assertPinnedState, hasSecurityFailure, verifyLiveIdentity,
      options: {
        path: join(initial.owner.socketPath, `.s.PGSQL.${initial.owner.port}`), port: initial.owner.port,
        database: initial.owner.database, user: initial.owner.role, ssl: false, debug: false, password,
      },
    };
  } catch { throw new ManagedPostgresConnectionError(); }
}
