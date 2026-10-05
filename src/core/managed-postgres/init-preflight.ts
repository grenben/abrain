import { isAbsolute, relative, sep } from 'node:path';
import type { OwnerMetadata, SetupPhase } from './ownership.ts';
import { validateManagedPostgresReference } from '../engine-target.ts';

export type InitConfigObservation =
  /** Absence from the no-follow final reread; the parent ancestry was checked. */
  | { kind: 'absent'; path: string; ancestrySafe: boolean; finalReread: boolean }
  /** A regular, non-symlink file read again at the final preflight boundary. */
  | { kind: 'valid'; path: string; fileType: 'regular'; ancestrySafe: boolean; finalReread: boolean; config: unknown }
  | { kind: 'malformed' | 'unreadable' | 'symlink' | 'dangling-symlink' | 'nonregular' | 'ambiguous'; path: string };

export interface ManagedInitPreflightPaths {
  configDir: string;
  configFile: string;
  root: string;
  owner: string;
  lock: string;
  credentials: string;
  receipt: string;
  data: string;
  log: string;
  socket: string;
}

export type ManagedInitArtifactObservation = {
  path: string;
  canonical: boolean;
  state: 'absent' | 'present' | 'ambiguous';
};

export type ManagedInitRootObservation =
  | { kind: 'absent'; path: string; ancestrySafe: boolean }
  | { kind: 'directory'; path: string; ancestrySafe: boolean; safe: boolean; entries: readonly string[] }
  | { kind: 'ambiguous'; path: string };

export type ManagedInitOwnerObservation =
  | { kind: 'absent'; path: string }
  | { kind: 'malformed' | 'unsafe' | 'ambiguous'; path: string }
  | {
    kind: 'valid';
    path: string;
    owner: OwnerMetadata;
    credentials: 'complete' | 'incomplete';
    receipt: 'complete' | 'absent' | 'incomplete';
    configProvenance: 'complete' | 'incomplete';
    socketProvenance: 'complete' | 'incomplete';
    data: 'empty' | 'initialized' | 'ambiguous';
  };

export type ManagedInitLockObservation = { path: string; state: 'absent' | 'present' | 'ambiguous' };

export interface ManagedInitPreflightInput {
  fileConfig: InitConfigObservation;
  /** True only for an accepted effective URL; cwd-dotenv-untrusted values are omitted. */
  acceptedEnvironmentUrl: boolean;
  canonicalPgliteArtifacts: readonly ManagedInitArtifactObservation[];
  paths: ManagedInitPreflightPaths;
  uid: number;
  root: ManagedInitRootObservation;
  owner: ManagedInitOwnerObservation;
  lock: ManagedInitLockObservation;
}

export type ManagedInitPreflightResult =
  | { kind: 'fresh' }
  | { kind: 'owned-resume'; phase: SetupPhase; evidence: 'structural-only' }
  | { kind: 'published-resume'; phase: SetupPhase; evidence: 'structural-only' };

export const MANAGED_INIT_PREFLIGHT_REFUSAL_CODE = 'managed_init_preflight_refused' as const;
export const MANAGED_INIT_PREFLIGHT_REFUSAL_MESSAGE = 'Managed PostgreSQL init preflight refused; no changes were made.';

export class ManagedInitPreflightRefusal extends Error {
  readonly code = MANAGED_INIT_PREFLIGHT_REFUSAL_CODE;
  constructor() {
    super(MANAGED_INIT_PREFLIGHT_REFUSAL_MESSAGE);
    this.name = 'ManagedInitPreflightRefusal';
  }
}

const TARGET_DECLARATIONS = ['engine', 'database_url', 'database_path', 'managed_postgres', 'remote_mcp', 'thin_client', 'thin_client_url', 'topology'] as const;
const ROOT_ENTRIES = new Set(['owner.json', 'credentials.json', 'init-receipt.json', 'data', 'log', 'socket', 'pgpass', 'pwfile']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_OWNER_BYTES = 32 * 1024;
const MAX_CREDENTIALS_BYTES = 16 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_SECRET_FILE_BYTES = 8 * 1024;
const MAX_MARKER_BYTES = 512;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_PG_VERSION_BYTES = 32;

function refuse(): never { throw new ManagedInitPreflightRefusal(); }

function isWithin(path: string, parent: string): boolean {
  const fromParent = relative(parent, path);
  return fromParent === '' || (fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent));
}

function inspectConfig(observation: InitConfigObservation, paths: ManagedInitPreflightPaths): string | null {
  if (observation.path !== paths.configFile || !isAbsolute(observation.path)) refuse();
  if (observation.kind === 'absent') {
    if (!observation.ancestrySafe || !observation.finalReread) refuse();
    return null;
  }
  if (observation.kind !== 'valid' || observation.fileType !== 'regular' || !observation.ancestrySafe || !observation.finalReread ||
      !observation.config || typeof observation.config !== 'object' || Array.isArray(observation.config)) refuse();
  const config = observation.config as Readonly<Record<string, unknown>>;
  const hasManaged = Object.hasOwn(config, 'managed_postgres');
  if (!hasManaged) {
    if (TARGET_DECLARATIONS.some((key) => Object.hasOwn(config, key))) refuse();
    return null;
  }
  if (config.engine !== 'postgres' || !Object.hasOwn(config, 'engine') || Object.hasOwn(config, 'database_url') || Object.hasOwn(config, 'database_path') || Object.hasOwn(config, 'remote_mcp') ||
      Object.hasOwn(config, 'thin_client') || Object.hasOwn(config, 'thin_client_url') || Object.hasOwn(config, 'topology')) refuse();
  try { return validateManagedPostgresReference(config.managed_postgres).cluster_id; }
  catch { return refuse(); }
}

function validOwner(input: ManagedInitPreflightInput, observed: Extract<ManagedInitOwnerObservation, { kind: 'valid' }>): boolean {
  const owner = observed.owner;
  return observed.path === input.paths.owner && owner.formatVersion === 1 && owner.managerId === 'gbrain-managed-postgres' &&
    UUID.test(owner.clusterId) && owner.uid === input.uid && owner.configPath === input.paths.configDir &&
    owner.rootPath === input.paths.root && owner.dataPath === input.paths.data && owner.pgMajor === 17 &&
    owner.controller === 'manual' && ['allocated', 'initialized', 'provisioned'].includes(owner.phase) &&
    Number.isInteger(owner.port) && owner.port >= 1024 && owner.port <= 65535 && ![5432, 5434, 6543].includes(owner.port) &&
    isAbsolute(owner.binaryPrefix) && typeof owner.binaryVersion === 'string' && owner.binaryVersion.length > 0 &&
    typeof owner.pgvectorVersion === 'string' && owner.pgvectorVersion.length > 0 && owner.database === 'gbrain' &&
    owner.role === 'gbrain' && isAbsolute(owner.socketPath) &&
    (owner.systemIdentifier === null || /^\d+$/.test(owner.systemIdentifier)) &&
    (owner.phase === 'allocated' || typeof owner.systemIdentifier === 'string' && /^\d+$/.test(owner.systemIdentifier)) &&
    (owner.lastFailure === undefined || owner.lastFailure === 'startup_failure');
}

function structurallyComplete(input: ManagedInitPreflightInput, owner: Extract<ManagedInitOwnerObservation, { kind: 'valid' }>): boolean {
  const metadata = owner.owner;
  const entries = new Set((input.root as Extract<ManagedInitRootObservation, { kind: 'directory' }>).entries);
  if ([...entries].some((entry) => !ROOT_ENTRIES.has(entry)) || !entries.has('owner.json') || !entries.has('credentials.json') ||
      !entries.has('data') || !entries.has('log')) return false;
  if (owner.credentials !== 'complete' || owner.configProvenance !== 'complete' || owner.socketProvenance !== 'complete') return false;
  if (metadata.socketPath === input.paths.socket && !entries.has('socket')) return false;
  if (metadata.phase === 'allocated') {
    if (owner.data === 'empty') return owner.receipt === 'absent' && metadata.systemIdentifier === null;
    if (owner.data !== 'initialized' || owner.receipt !== 'complete' || !entries.has('init-receipt.json')) return false;
  } else if (owner.data !== 'initialized' || owner.receipt !== 'complete' || !entries.has('init-receipt.json')) return false;
  if ((metadata.phase === 'initialized' || metadata.phase === 'provisioned') && !entries.has('pgpass')) return false;
  return true;
}

/** Pure structural classifier. It consumes read-only observations and has no mutation-capable dependencies. */
function classifyObservedManagedInit(input: ManagedInitPreflightInput): ManagedInitPreflightResult {
  if (input.acceptedEnvironmentUrl || !Number.isInteger(input.uid) || input.uid < 0) refuse();
  const { paths } = input;
  if (Object.values(paths).some((path) => !isAbsolute(path)) || paths.configFile !== `${paths.configDir}/config.json` ||
      paths.root === paths.configDir || !isWithin(paths.root, paths.configDir) ||
      paths.owner !== `${paths.root}/owner.json` || paths.lock !== `${paths.root}/.lifecycle.lock` ||
      paths.credentials !== `${paths.root}/credentials.json` || paths.receipt !== `${paths.root}/init-receipt.json` ||
      paths.data !== `${paths.root}/data` || paths.log !== `${paths.root}/log` || paths.socket !== `${paths.root}/socket`) refuse();
  const managedClusterId = inspectConfig(input.fileConfig, paths);
  for (const artifact of input.canonicalPgliteArtifacts) {
    if (!artifact.canonical || !isAbsolute(artifact.path) || !isWithin(artifact.path, paths.configDir) || artifact.state !== 'absent') refuse();
  }
  if (input.lock.path !== paths.lock || input.lock.state !== 'absent') refuse();
  if (input.root.path !== paths.root || input.owner.path !== paths.owner) refuse();
  if (input.root.kind === 'ambiguous' || input.owner.kind === 'malformed' || input.owner.kind === 'unsafe' || input.owner.kind === 'ambiguous') refuse();
  if (!input.root.ancestrySafe || input.root.kind === 'directory' && !input.root.safe) refuse();

  if (input.root.kind === 'absent') {
    if (input.owner.kind !== 'absent' || managedClusterId !== null) refuse();
    return { kind: 'fresh' };
  }
  if (input.root.entries.length === 0) {
    if (input.owner.kind !== 'absent' || managedClusterId !== null) refuse();
    return { kind: 'fresh' };
  }
  if (input.owner.kind !== 'valid' || !validOwner(input, input.owner) || !structurallyComplete(input, input.owner)) refuse();
  if (managedClusterId !== null && managedClusterId !== input.owner.owner.clusterId) refuse();
  if (managedClusterId !== null && input.owner.owner.phase !== 'provisioned') refuse();
  return {
    kind: managedClusterId === null ? 'owned-resume' : 'published-resume',
    phase: input.owner.owner.phase,
    evidence: 'structural-only',
  };
}

export function classifyManagedInitPreflight(input: ManagedInitPreflightInput): ManagedInitPreflightResult {
  try { return classifyObservedManagedInit(input); }
  catch (error) {
    if (error instanceof ManagedInitPreflightRefusal) throw error;
    return refuse();
  }
}

export interface InspectManagedInitPreflightInput {
  configDir: string;
  root: string;
  uid: number;
  acceptedEnvironmentUrl: boolean;
  /** Canonical, known local PGLite artifact paths; no recursive search is performed. */
  canonicalPgliteArtifactPaths: readonly string[];
}
