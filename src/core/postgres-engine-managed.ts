import postgres from '#postgres';
import { configDir } from './config.ts';
import * as db from './db.ts';
import { normalizeEngineTarget, managedPostgresIdentity } from './engine-target.ts';
import { createManagedPostgresCandidate, ManagedPostgresPoolError, type ManagedPostgresCandidate } from './managed-postgres-pool.ts';
import { resolveManagedPostgresConnection } from './managed-postgres/connection.ts';
import { ConnectionManager, type ConnectionManagerOpts } from './connection-manager.ts';
import type { EngineConfig } from './types.ts';
import { logDbDisconnect } from './audit/db-disconnect-audit.ts';
import { logPoolRecovery } from './audit/pool-recovery-audit.ts';
import { drainBackgroundWorkBeforeDisconnect } from './background-work.ts';

export type EnginePool = ReturnType<typeof postgres>;
export type ManagedCandidate = Pick<ManagedPostgresCandidate, 'pool' | 'identity'>;

export interface ManagedEngineHost {
  readonly deps: ManagedEngineDependencies;
  sql: EnginePool | null;
  manager: ConnectionManager | null;
  identity: string | null;
  generation: number;
  instancePoolOwned: boolean;
  ownsModule: boolean;
  style: 'instance' | 'module' | null;
  reconnecting: boolean;
  stops: ReadonlySet<() => Promise<void>>;
}

export interface ManagedEngineDependencies {
  readonly createCandidate: (config: EngineConfig, options: Record<string, unknown>) => Promise<ManagedCandidate>;
  readonly closePool: (pool: EnginePool) => Promise<void>;
  readonly dbConnect: (config: EngineConfig) => Promise<boolean>;
  readonly dbGetConnection: () => EnginePool;
  readonly dbDisconnect: () => Promise<void>;
  readonly createManager: (options: ConnectionManagerOpts) => ConnectionManager;
}

export const DEFAULT_MANAGED_ENGINE_DEPENDENCIES: ManagedEngineDependencies = Object.freeze({
  createCandidate: (config: EngineConfig, options: Record<string, unknown>) => createManagedPostgresCandidate(config, options, {
    resolve: resolveManagedPostgresConnection, create: postgres, end: db.endPoolBounded, configDir,
  }),
  closePool: db.endPoolBounded,
  dbConnect: db.connect,
  dbGetConnection: db.getConnection,
  dbDisconnect: db.disconnect,
  createManager: (options: ConnectionManagerOpts) => new ConnectionManager(options),
});

export async function connectManagedIfTarget(host: ManagedEngineHost, config: EngineConfig & { poolSize?: number; parentConnectionManager?: ConnectionManager }): Promise<boolean> {
  let target;
  try { target = normalizeEngineTarget(config); }
  catch (error) { if (config.managed_postgres !== undefined) throw new ManagedPostgresPoolError('target_unverified'); throw error; }
  if (target.kind !== 'postgres-managed') return false;
  await connectManaged(host, config, target.managed_postgres);
  return true;
}

export async function connectManaged(host: ManagedEngineHost, config: EngineConfig & { poolSize?: number; parentConnectionManager?: ConnectionManager }, reference: { manager_id: 'gbrain-managed-postgres'; cluster_id: string }): Promise<void> {
  const identity = managedPostgresIdentity(reference); host.identity = identity;
  const generation = ++host.generation;
  if (config.poolSize) await connectManagedInstance(host, config, identity, generation);
  else await connectManagedModule(host, config, identity, generation);
}

export function managedInstanceOptions(config: EngineConfig & { poolSize?: number }): Record<string, unknown> {
  const timeouts = db.resolveSessionTimeouts();
  const options: Record<string, unknown> = {
    max: Math.min(config.poolSize!, db.resolvePoolSize(config.poolSize)),
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: db.resolveMaxLifetimeSeconds(),
    types: { bigint: postgres.BigInt },
    onnotice: process.env.GBRAIN_PG_NOTICES === '1' ? undefined : () => {},
  };
  if (Object.keys(timeouts).length > 0) options.connection = timeouts;
  return options;
}

export function managedManager(
  identity: string,
  pool: EnginePool | null,
  parent: ConnectionManager | undefined,
  deps: ManagedEngineDependencies,
): ConnectionManager {
  try {
    const options: ConnectionManagerOpts = parent
      ? { managedIdentity: identity, parent }
      : { managedIdentity: identity, managedPool: pool! };
    return deps.createManager(options);
  } catch {
    throw new ManagedPostgresPoolError('target_unverified');
  }
}

export async function buildManagedInstance(
  config: EngineConfig & { poolSize: number; parentConnectionManager?: ConnectionManager },
  identity: string,
  deps: ManagedEngineDependencies,
): Promise<{ pool: EnginePool; manager: ConnectionManager; borrowed: boolean }> {
  const parent = config.parentConnectionManager;
  if (parent) {
    if (!parent.isManagedMode || parent.managedIdentity !== identity || !parent.peekReadPool()) {
      throw new ManagedPostgresPoolError('target_unverified');
    }
    const pool = parent.peekReadPool()!;
    return { pool, manager: managedManager(identity, pool, parent, deps), borrowed: true };
  }

  let candidate: ManagedCandidate;
  try { candidate = await deps.createCandidate(config, managedInstanceOptions(config)); }
  catch (error) { throw classifyManagedError(error); }
  if (candidate.identity !== identity) {
    await closeQuietly(candidate.pool, deps);
    throw new ManagedPostgresPoolError('target_unverified');
  }
  try {
    const manager = managedManager(identity, candidate.pool, undefined, deps);
    return { pool: candidate.pool, manager, borrowed: false };
  } catch {
    await closeQuietly(candidate.pool, deps);
    throw new ManagedPostgresPoolError('target_unverified');
  }
}

export function classifyManagedError(error: unknown): ManagedPostgresPoolError {
  return error instanceof ManagedPostgresPoolError
    ? error
    : new ManagedPostgresPoolError('target_unverified');
}

export function managedEnginePool(identity: string, manager: ConnectionManager | null): EnginePool {
  if (!manager?.isManagedMode || manager.managedIdentity !== identity) throw new ManagedPostgresPoolError('target_unverified');
  try { return manager.read() as EnginePool; }
  catch { throw new ManagedPostgresPoolError('target_unverified'); }
}

export async function closeQuietly(pool: EnginePool, deps: ManagedEngineDependencies): Promise<void> {
  try { await deps.closePool(pool); } catch { /* managed teardown is best-effort */ }
}

export async function connectManagedInstance(host: ManagedEngineHost, config: EngineConfig & { poolSize?: number; parentConnectionManager?: ConnectionManager }, identity: string, generation: number): Promise<void> {
  let built: Awaited<ReturnType<typeof buildManagedInstance>>;
  try { built = await buildManagedInstance(config as EngineConfig & { poolSize: number; parentConnectionManager?: ConnectionManager }, identity, host.deps); }
  catch (error) { throw classifyManagedError(error); }
  if (host.generation !== generation || host.identity !== identity) {
    await disconnectManagerQuietly(built.manager);
    if (!built.borrowed) await closeQuietly(built.pool, host.deps);
    throw new ManagedPostgresPoolError('target_unverified');
  }
  host.sql = built.pool;
  host.manager = built.manager;
  host.instancePoolOwned = !built.borrowed;
  host.style = 'instance';
}

export async function connectManagedModule(host: ManagedEngineHost, config: EngineConfig & { parentConnectionManager?: ConnectionManager }, identity: string, generation: number): Promise<void> {
  const parent = config.parentConnectionManager;
  if (parent) {
    const pool = parent.peekReadPool();
    const manager = managedManager(identity, pool, parent, host.deps);
    if (host.generation !== generation || host.identity !== identity) {
      await disconnectManagerQuietly(manager);
      throw new ManagedPostgresPoolError('target_unverified');
    }
    host.sql = pool;
    host.instancePoolOwned = false;
    host.manager = manager;
    host.style = 'instance';
    return;
  }
  let owner = false;
  try {
    owner = await host.deps.dbConnect(config);
    const pool = host.deps.dbGetConnection();
    const manager = managedManager(identity, pool, undefined, host.deps);
    if (host.generation !== generation || host.identity !== identity) {
      await disconnectManagerQuietly(manager);
      await settleStaleModuleOwner(host, identity, generation, owner);
      throw new ManagedPostgresPoolError('target_unverified');
    }
    host.manager = manager;
    host.sql = null;
    host.instancePoolOwned = false;
    host.ownsModule = host.ownsModule || owner;
    host.style = 'module';
  } catch (error) {
    if (owner && host.generation === generation) {
      try { await host.deps.dbDisconnect(); } catch { /* fixed failure remains authoritative */ }
    }
    throw classifyManagedError(error);
  }
}

export async function disconnectManaged(host: ManagedEngineHost): Promise<void> {
  const style = host.style, manager = host.manager, pool = host.sql;
  const ownsModule = host.ownsModule, ownsPool = host.instancePoolOwned;
  host.generation++;
  host.sql = null;
  host.manager = null;
  host.identity = null;
  host.instancePoolOwned = false;
  host.ownsModule = false;
  host.style = 'instance';
  for (const stop of host.stops) await stop();
  try { logDbDisconnect('postgres', style ?? 'unknown'); } catch { /* best-effort */ }
  if (manager || pool || style === 'module') await drainBackgroundWorkBeforeDisconnect();
  if (manager) await disconnectManagerQuietly(manager);
  const teardown: Promise<void>[] = [];
  if (style === 'module' && ownsModule) teardown.push(host.deps.dbDisconnect());
  if (pool && ownsPool) teardown.push(host.deps.closePool(pool));
  await Promise.all(teardown.map(promise => promise.catch(() => {})));
}

/**
 * Reconnect-policy companion for PostgresEngine.reconnect(); its URL branches
 * intentionally remain there. Module-singleton engines share db.ts's `sql`
 * (#1745), so calling db.disconnect() during recovery would null the pool under
 * concurrent operations (other dream-cycle phases and minion-queue
 * `promoteDelayed`) and make them fail in the disconnect→connect window.
 * postgres.js replaces dead sockets inside its pool, so transient blips recover
 * without teardown. URL recovery therefore calls db.connect() idempotently and
 * refreshes the ConnectionManager read pool; it fixes the singleton-null window,
 * not a genuinely wedged-but-live pool (db.connect() correctly no-ops there).
 *
 * URL instance pools are isolated worker pools: build-then-swap is correct, and
 * their reconnect path records reap/reconnect audit events for pool_reap_health
 * (#1685 GAP B). `ctx.error` is classified as a reap only for CONNECTION_ENDED;
 * all other or absent errors are reconnect_other. Auditing is best-effort
 * (CODEX #8), and a failed rebuild restores the prior pool and manager.
 */
export async function reconnectManaged(host: ManagedEngineHost, config: EngineConfig & { poolSize?: number; parentConnectionManager?: ConnectionManager }): Promise<void> {
  if (host.reconnecting) return;
  host.reconnecting = true;
  try { await reconnectManagedWork(host, config); }
  finally { host.reconnecting = false; }
}

async function reconnectManagedWork(host: ManagedEngineHost, config: EngineConfig & { poolSize?: number; parentConnectionManager?: ConnectionManager }): Promise<void> {
  if (!host.identity) {
    const target = normalizeEngineTarget(config);
    if (target.kind !== 'postgres-managed') throw new ManagedPostgresPoolError('target_unverified');
    host.identity = managedPostgresIdentity(target.managed_postgres);
  }
  const identity = host.identity, generation = host.generation;
  const oldPool = host.sql, oldManager = host.manager, oldPoolOwned = host.instancePoolOwned;
  let newlyOwnedSingleton = false;
  try {
    if (config.parentConnectionManager) {
      const parent = config.parentConnectionManager;
      const pool = parent.peekReadPool();
      if (!parent.isManagedMode || parent.managedIdentity !== identity || !pool) {
        throw new ManagedPostgresPoolError('target_unverified');
      }
      if (host.generation !== generation) throw new ManagedPostgresPoolError('target_unverified');
      host.sql = pool;
      if (!host.manager) host.manager = managedManager(identity, pool, parent, host.deps);
      host.instancePoolOwned = false;
      return;
    }
    if (!config.poolSize) {
      const owner = await host.deps.dbConnect(config);
      newlyOwnedSingleton = owner;
      const pool = host.deps.dbGetConnection();
      const manager = oldManager ?? managedManager(identity, pool, undefined, host.deps);
      if (host.generation !== generation || host.identity !== identity) {
        if (manager !== oldManager) await disconnectManagerQuietly(manager);
        await settleStaleModuleOwner(host, identity, generation, owner);
        throw new ManagedPostgresPoolError('target_unverified');
      }
      if (oldManager) oldManager.setReadPool(pool); else host.manager = manager;
      host.ownsModule = host.ownsModule || owner;
      host.style = 'module';
      return;
    }
    const built = await buildManagedInstance(config as EngineConfig & { poolSize: number; parentConnectionManager?: ConnectionManager }, identity, host.deps);
    if (host.generation !== generation || host.identity !== identity) {
      await disconnectManagerQuietly(built.manager);
      if (!built.borrowed) await closeQuietly(built.pool, host.deps);
      throw new ManagedPostgresPoolError('target_unverified');
    }
    host.sql = built.pool;
    host.manager = built.manager;
    host.instancePoolOwned = !built.borrowed;
    host.style = 'instance';
    if (oldManager) await disconnectManagerQuietly(oldManager);
    if (oldPool && oldPoolOwned) await closeQuietly(oldPool, host.deps);
    try { logPoolRecovery('reconnect_succeeded'); } catch { /* best-effort */ }
  } catch (error) {
    const managedError = classifyManagedError(error);
    if (host.generation !== generation) throw managedError;
    if (newlyOwnedSingleton) {
      host.ownsModule = false;
      try { await host.deps.dbDisconnect(); } catch { /* best-effort new-owner cleanup */ }
    }
    if (managedError.kind === 'unavailable') {
      host.sql = oldPool;
      host.manager = oldManager;
      host.instancePoolOwned = oldPoolOwned;
      throw managedError;
    }
    await invalidateManaged(host, oldPool, oldManager, oldPoolOwned, generation);
    if (!config.poolSize && host.ownsModule) {
      host.ownsModule = false;
      try { await host.deps.dbDisconnect(); } catch { /* best-effort */ }
    }
    try { logPoolRecovery('reconnect_failed', managedError); } catch { /* best-effort */ }
    throw managedError;
  }
}

async function settleStaleModuleOwner(host: ManagedEngineHost, identity: string, generation: number, owner: boolean): Promise<void> {
  if (!owner) return;
  if (host.generation > generation && host.identity === identity) {
    host.ownsModule = true;
    return;
  }
  if (host.generation === generation + 1 && host.identity === null) {
    try { await host.deps.dbDisconnect(); } catch { /* stale owner cleanup is best-effort */ }
  }
}

async function invalidateManaged(host: ManagedEngineHost, pool: EnginePool | null, manager: ConnectionManager | null, owned: boolean, generation: number): Promise<void> {
  if (host.generation !== generation) return;
  host.sql = null;
  host.manager = null;
  host.instancePoolOwned = false;
  host.style = 'instance';
  if (manager) await disconnectManagerQuietly(manager);
  if (pool && owned) await closeQuietly(pool, host.deps);
}

async function disconnectManagerQuietly(manager: ConnectionManager): Promise<void> {
  try { await manager.disconnect(); } catch { /* manager teardown cannot block owned pool cleanup */ }
}
