import postgres from '#postgres';
import type { EngineConfig } from './types.ts';
import { resolveManagedPostgresConnection, type ManagedPostgresConnectionResolution } from './managed-postgres/connection.ts';
import { MANAGED_IDENTITY_QUERY } from './managed-postgres/identity.ts';
import { normalizeEngineTarget } from './engine-target.ts';

export class ManagedPostgresPoolError extends Error {
  constructor() {
    super('Managed PostgreSQL pool could not be constructed or verified.');
    this.name = 'ManagedPostgresPoolError';
  }
}

type Pool = ReturnType<typeof postgres>;
export interface ManagedPostgresPoolDependencies {
  readonly resolve: typeof resolveManagedPostgresConnection;
  readonly create: typeof postgres;
  readonly end: (pool: Pool) => Promise<void>;
  readonly configDir: () => string;
  readonly query?: (pool: Pool, query: string) => Promise<unknown>;
}

export interface ManagedPostgresCandidate {
  pool: Pool;
  identity: string;
}

function normalizeIdentityRows(result: unknown): unknown {
  if (!Array.isArray(result) || result.length !== 1) throw new Error();
  const row = result[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
  const keys = Object.keys(row);
  if (keys.length !== 1 || keys[0] !== 'identity') throw new Error();
  const payload = (row as Record<string, unknown>).identity;
  if (typeof payload === 'string') return JSON.parse(payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
  return payload;
}

/** Construct privately and prove live ownership before returning the pool. */
export async function createManagedPostgresCandidate(
  config: EngineConfig,
  poolOptions: Record<string, unknown>,
  deps: ManagedPostgresPoolDependencies,
): Promise<ManagedPostgresCandidate> {
  let pool: Pool | null = null;
  try {
    const target = normalizeEngineTarget(config);
    if (target.kind !== 'postgres-managed') throw new Error();
    const resolution: ManagedPostgresConnectionResolution = deps.resolve(
      target.managed_postgres,
      { configDir: deps.configDir() },
    );
    // Resolver-owned connection fields deliberately override any shared options.
    pool = deps.create({ ...poolOptions, ...resolution.options } as never);
    const result = deps.query
      ? await deps.query(pool, MANAGED_IDENTITY_QUERY)
      : await pool.unsafe(MANAGED_IDENTITY_QUERY);
    const identity = normalizeIdentityRows(result);
    resolution.verifyLiveIdentity(identity);
    return { pool, identity: resolution.identity };
  } catch {
    if (pool) await deps.end(pool).catch(() => {});
    throw new ManagedPostgresPoolError();
  }
}
