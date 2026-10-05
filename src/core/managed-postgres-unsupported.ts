import type { EngineConfig } from './types.ts';
import { normalizeEngineTarget } from './engine-target.ts';

export const MANAGED_POSTGRES_UNSUPPORTED_OPERATIONS = [
  'config-target-mutation',
  'init-reinit',
  'db-repair',
  'mount',
  'migration-source',
  'migration-target',
  'backup',
  'restore',
  'snapshot-replacement',
  'thin-client-retarget',
  'remote-mcp-retarget',
  'bridge-install',
  'shell-process-forwarding',
  'unsupported-target-workflow',
] as const;

export type ManagedPostgresUnsupportedOperation =
  typeof MANAGED_POSTGRES_UNSUPPORTED_OPERATIONS[number];

/** The shared target fields carried by EngineConfig and file-backed command config. */
export type ManagedPostgresTargetLike = Pick<
  EngineConfig,
  'engine' | 'database_url' | 'database_path' | 'managed_postgres'
> & {
  remote_mcp?: unknown;
  thin_client?: unknown;
  thin_client_url?: unknown;
};

export const MANAGED_POSTGRES_UNSUPPORTED_CODE = 'managed_postgres_unsupported' as const;
export const MANAGED_POSTGRES_UNSUPPORTED_MESSAGE =
  'Managed PostgreSQL references are not supported by this workflow yet; no changes were made. Use an ordinary URL/PGLite target for this operation or wait for support.';

export class ManagedPostgresUnsupportedError extends Error {
  readonly code = MANAGED_POSTGRES_UNSUPPORTED_CODE;
  readonly operation: ManagedPostgresUnsupportedOperation;

  constructor(operation: ManagedPostgresUnsupportedOperation) {
    if (!(MANAGED_POSTGRES_UNSUPPORTED_OPERATIONS as readonly string[]).includes(operation)) {
      throw new TypeError('Invalid managed workflow identifier');
    }
    super(MANAGED_POSTGRES_UNSUPPORTED_MESSAGE);
    this.name = 'ManagedPostgresUnsupportedError';
    this.operation = operation;
  }
}

/** Refuse unsupported workflows only for a valid, active managed target. */
export function assertNoManagedPostgresTarget(
  config: ManagedPostgresTargetLike,
  operation: ManagedPostgresUnsupportedOperation,
): void {
  if (normalizeEngineTarget(config).kind === 'postgres-managed') {
    throw new ManagedPostgresUnsupportedError(operation);
  }
}
