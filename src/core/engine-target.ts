import type { EngineConfig, ManagedPostgresReference } from './types.ts';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MANAGED_IDENTITY = new RegExp(`^postgres-managed:v1:gbrain-managed-postgres:${CANONICAL_UUID.source.slice(1, -1)}$`);

export type NormalizedEngineTarget =
  | { kind: 'pglite'; database_path?: string }
  | { kind: 'postgres-url'; database_url?: string }
  | { kind: 'postgres-managed'; managed_postgres: ManagedPostgresReference };

export type EngineTargetInput = EngineConfig & {
  remote_mcp?: unknown;
  thin_client?: unknown;
  thin_client_url?: unknown;
};

export class EngineTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineTargetError';
  }
}

export function validateManagedPostgresReference(value: unknown): ManagedPostgresReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EngineTargetError('managed_postgres must be an object with manager_id and cluster_id');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'manager_id') || !Object.hasOwn(record, 'cluster_id')) {
    throw new EngineTargetError('managed_postgres must contain only manager_id and cluster_id');
  }
  if (record.manager_id !== 'gbrain-managed-postgres') {
    throw new EngineTargetError('managed_postgres manager_id is invalid');
  }
  if (typeof record.cluster_id !== 'string' || !CANONICAL_UUID.test(record.cluster_id)) {
    throw new EngineTargetError('managed_postgres cluster_id must be a canonical lowercase UUID');
  }
  return { manager_id: 'gbrain-managed-postgres', cluster_id: record.cluster_id };
}

export function managedPostgresIdentity(reference: unknown): string {
  const valid = validateManagedPostgresReference(reference);
  return validateManagedPostgresIdentity(`postgres-managed:v1:${valid.manager_id}:${valid.cluster_id}`);
}

/** Validate the stable, non-secret identity used to bind managed pool targets. */
export function validateManagedPostgresIdentity(value: unknown): string {
  if (typeof value !== 'string') throw new EngineTargetError('managed PostgreSQL identity is invalid');
  if (!MANAGED_IDENTITY.test(value)) {
    throw new EngineTargetError('managed PostgreSQL identity is invalid');
  }
  return value;
}

/** Pure normalization: does not consult environment variables or the filesystem. */
export function normalizeEngineTarget(config: EngineTargetInput): NormalizedEngineTarget {
  const managedValue = config.managed_postgres;
  if (managedValue !== undefined) {
    const managed_postgres = validateManagedPostgresReference(managedValue);
    const forbidden = ['database_url', 'database_path', 'remote_mcp', 'thin_client', 'thin_client_url'];
    const fields = config as EngineTargetInput & Record<string, unknown>;
    if (config.engine !== 'postgres' || forbidden.some((key) => fields[key] !== undefined)) {
      throw new EngineTargetError('managed_postgres requires engine postgres and cannot be combined with another target');
    }
    return { kind: 'postgres-managed', managed_postgres };
  }
  if (config.database_url) return { kind: 'postgres-url', database_url: config.database_url };
  if (config.engine === 'pglite' || config.database_path) {
    return { kind: 'pglite', ...(config.database_path ? { database_path: config.database_path } : {}) };
  }
  return { kind: 'postgres-url' };
}

export function validateManagedTargetConfig(config: EngineTargetInput): void {
  if (config.managed_postgres !== undefined) normalizeEngineTarget(config);
}
