import postgres from '#postgres';
import type { EngineConfig } from './types.ts';
import { resolveManagedPostgresConnection, type ManagedPostgresConnectionResolution } from './managed-postgres/connection.ts';
import { MANAGED_IDENTITY_QUERY } from './managed-postgres/identity.ts';
import { normalizeEngineTarget } from './engine-target.ts';

export class ManagedPostgresPoolError extends Error {
  readonly kind: 'unavailable' | 'target_unverified';
  constructor(kind: 'unavailable' | 'target_unverified' = 'target_unverified') {
    super('Managed PostgreSQL pool could not be constructed or verified.');
    this.name = 'ManagedPostgresPoolError';
    this.kind = kind;
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
  let target;
  try {
    target = normalizeEngineTarget(config);
    if (target.kind !== 'postgres-managed') throw new Error();
  } catch {
    throw new ManagedPostgresPoolError('target_unverified');
  }

  let resolution: ManagedPostgresConnectionResolution;
  try {
    resolution = deps.resolve(target.managed_postgres, { configDir: deps.configDir() });
  } catch {
    throw new ManagedPostgresPoolError('target_unverified');
  }

  let pool: Pool;
  try {
    // Resolver-owned connection fields deliberately override shared options.
    pool = deps.create({ ...poolOptions, ...resolution.options, onnotice: () => {} } as never);
  } catch {
    throw new ManagedPostgresPoolError('unavailable');
  }

  let result: unknown;
  try {
    result = deps.query
      ? await deps.query(pool, MANAGED_IDENTITY_QUERY)
      : await pool.unsafe(MANAGED_IDENTITY_QUERY);
  } catch {
    try { resolution.assertPinnedState(); }
    catch { await closeCandidate(pool, deps); throw new ManagedPostgresPoolError('target_unverified'); }
    await closeCandidate(pool, deps);
    throw new ManagedPostgresPoolError('unavailable');
  }

  let identity: unknown;
  try { identity = normalizeIdentityRows(result); }
  catch { await closeCandidate(pool, deps); throw new ManagedPostgresPoolError('target_unverified'); }

  try { resolution.verifyLiveIdentity(identity); }
  catch { await closeCandidate(pool, deps); throw new ManagedPostgresPoolError('target_unverified'); }
  return { pool, identity: resolution.identity };
}

async function closeCandidate(pool: Pool, deps: ManagedPostgresPoolDependencies): Promise<void> {
  try { await deps.end(pool); } catch { /* cleanup cannot alter classification */ }
}
