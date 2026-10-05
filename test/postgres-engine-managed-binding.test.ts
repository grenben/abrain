import { afterEach, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { ConnectionManager } from '../src/core/connection-manager.ts';
import { ManagedPostgresSingleton } from '../src/core/managed-postgres-singleton.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { createManagedPostgresCandidate, ManagedPostgresPoolError } from '../src/core/managed-postgres-pool.ts';
import { managedInstanceOptions, managedModuleOptions, type ManagedEngineDependencies } from '../src/core/postgres-engine-managed.ts';
import type { EngineConfig } from '../src/core/types.ts';
import * as db from '../src/core/db.ts';

const target = { manager_id: 'gbrain-managed-postgres' as const, cluster_id: '00000000-0000-4000-8000-000000000001' };
const identity = `postgres-managed:v1:gbrain-managed-postgres:${target.cluster_id}`;
const config = (parentConnectionManager?: ConnectionManager): EngineConfig & { parentConnectionManager?: ConnectionManager } => ({ engine: 'postgres', managed_postgres: target, ...(parentConnectionManager ? { parentConnectionManager } : {}) });
const engines: PostgresEngine[] = [];
afterEach(async () => { await Promise.all(engines.splice(0).map(engine => engine.disconnect())); });
function fakePool(name: string) {
  let notifyClosed!: () => void;
  const closed = new Promise<void>(resolve => { notifyClosed = resolve; });
  const value = { name, closes: 0, closed, end: async () => { value.closes++; notifyClosed(); }, unsafe: async () => [] };
  return value as unknown as ReturnType<typeof postgres> & typeof value;
}
function harness(build: ManagedEngineDependencies['createCandidate'], overrides: Partial<ManagedEngineDependencies> = {}) {
  const closed: unknown[] = [];
  const deps: ManagedEngineDependencies = {
    createCandidate: build,
    closePool: async value => { closed.push(value); await value.end({ timeout: 2 }); },
    createManager: options => new ConnectionManager(options),
    ...overrides,
  };
  const create = () => { const engine = new PostgresEngine(deps); engines.push(engine); return engine; };
  return { create, closed, deps };
}
function candidate(value: ReturnType<typeof fakePool>, id = identity) { return { pool: value, identity: id }; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function productionHarness(build: ManagedEngineDependencies['createCandidate'], overrides: Partial<ManagedEngineDependencies> = {}) {
  const deps: ManagedEngineDependencies = {
    createCandidate: build,
    closePool: async pool => { await pool.end({ timeout: 2 }); },
    createManager: options => new ConnectionManager(options),
    acquireManaged: db.acquireManaged,
    beginManagedRelease: db.beginManagedRelease,
    ...overrides,
  };
  const create = () => { const engine = new PostgresEngine(deps); engines.push(engine); return engine; };
  return { create, deps };
}
function callableUrlPool(_name: string, query: () => Promise<unknown> = async () => []): ReturnType<typeof postgres> & { closes: number } {
  const tagged = (() => query()) as unknown as ReturnType<typeof postgres>;
  const state = { closes: 0 };
  Object.assign(tagged, { end: async () => { state.closes++; }, unsafe: async () => [], closes: 0 });
  Object.defineProperty(tagged, 'closes', { get: () => state.closes });
  return tagged as ReturnType<typeof postgres> & { closes: number };
}

describe('managed binding real composition', () => {
  test('coalesces acquisitions, gives one exact owner, and late proof after owner disconnect closes once', async () => {
    const proof = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>(); let builds = 0;
    const h = harness(async () => { builds++; return proof.promise; });
    const owner = h.create(), borrower = h.create();
    const first = owner.connect(config()), second = borrower.connect(config());
    const firstResult = first.catch(error => error);
    const secondResult = second.catch(error => error);
    await Promise.resolve();
    expect(builds).toBe(1);
    await owner.disconnect();
    const late = fakePool('late'); proof.resolve(candidate(late));
    expect(await firstResult).toBeInstanceOf(ManagedPostgresPoolError);
    expect(await secondResult).toBeInstanceOf(ManagedPostgresPoolError);
    await late.closed;
    expect(late.closes).toBe(1);
    expect(borrower.connectionManager).toBeNull();
  });

  test('refreshes one stable manager and switches owner and child reads after proof', async () => {
    const old = fakePool('old'), replacement = fakePool('replacement'); let builds = 0;
    const h = harness(async () => candidate(++builds === 1 ? old : replacement));
    const owner = h.create(); await owner.connect(config());
    const child = h.create(); await child.connect(config(owner.connectionManager!));
    const manager = owner.connectionManager;
    await Promise.all([owner.reconnect(), child.reconnect()]);
    expect(owner.connectionManager).toBe(manager);
    expect(owner.connectionManager?.read()).toBe(replacement);
    expect(child.connectionManager?.read()).toBe(replacement);
    expect(old.closes).toBe(1);
    await child.disconnect();
    expect(replacement.closes).toBe(0);
  });

  test('exact healthy same-config managed connect is idempotent and preserves manager and pool', async () => {
    const pool = fakePool('idempotent-managed'); let builds = 0;
    const h = harness(async () => { builds++; return candidate(pool); });
    const engine = h.create(), applied = config();
    await engine.connect(applied);
    const manager = engine.connectionManager;
    await engine.connect(applied);
    expect(builds).toBe(1);
    expect(engine.connectionManager).toBe(manager);
    expect(engine.sql).toBe(pool);
    expect((engine as unknown as { _savedConfig: EngineConfig })._savedConfig).toBe(applied);
  });

  test('production adapter: disconnected borrower refuses sql while module owner remains usable', async () => {
    const pool = fakePool('production-shared');
    const ownerHarness = productionHarness(async () => candidate(pool));
    const borrowerHarness = productionHarness(async () => { throw new Error('borrower must not build'); });
    const owner = ownerHarness.create(), borrower = borrowerHarness.create();
    await owner.connect(config()); await borrower.connect(config());
    await borrower.disconnect();
    expect(() => borrower.sql).toThrow(ManagedPostgresPoolError);
    expect(owner.sql).toBe(pool);
    expect(db.getConnection()).toBe(pool);
  });

  test('production adapter: disconnected instance refuses even when unrelated module singleton exists', async () => {
    const modulePool = fakePool('unrelated-module');
    const moduleHarness = productionHarness(async () => candidate(modulePool));
    const instanceHarness = productionHarness(async () => candidate(fakePool('independent-instance')));
    const owner = moduleHarness.create(), instance = instanceHarness.create();
    await owner.connect(config());
    await instance.connect({ ...config(), poolSize: 2 });
    await instance.disconnect();
    expect(() => instance.sql).toThrow(ManagedPostgresPoolError);
    expect(owner.sql).toBe(modulePool);
    expect(db.getConnection()).toBe(modulePool);
  });

  test('production adapter: failed borrower manager attachment refuses singleton fallback', async () => {
    const pool = fakePool('manager-owner');
    const ownerHarness = productionHarness(async () => candidate(pool));
    const failedHarness = productionHarness(async () => { throw new Error('borrower must not build'); }, {
      createManager: () => { throw new Error('injected manager failure'); },
    });
    const owner = ownerHarness.create(), failed = failedHarness.create();
    await owner.connect(config());
    await expect(failed.connect(config())).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(() => failed.sql).toThrow(ManagedPostgresPoolError);
    expect(owner.sql).toBe(pool);
  });

  test('production adapter: delayed old disconnect never routes through a newer module binding', async () => {
    const oldPool = fakePool('delayed-old-module'), newPool = fakePool('new-module');
    const oldHarness = productionHarness(async () => candidate(oldPool), { teardownTimeoutMs: 100 });
    const newHarness = productionHarness(async () => candidate(newPool));
    const oldEngine = oldHarness.create(), newEngine = newHarness.create();
    await oldEngine.connect(config());
    const hook = deferred<void>();
    oldEngine.registerBeforeDisconnect(() => hook.promise);
    const closing = oldEngine.disconnect();
    await newEngine.connect(config());
    expect(() => oldEngine.sql).toThrow(ManagedPostgresPoolError);
    expect(newEngine.sql).toBe(newPool);
    hook.resolve(); await closing;
    expect(() => oldEngine.sql).toThrow(ManagedPostgresPoolError);
    expect(newEngine.sql).toBe(newPool);
  });

  test('production adapter: security revocation requires disconnect before URL mode can publish', async () => {
    const first = fakePool('revoked-source'), replacement = fakePool('unrelated-managed-owner');
    let builds = 0, urlAttempts = 0;
    const urlProof = deferred<void>(), madeUrlPool = deferred<void>();
    const urlPools: { connected?: ReturnType<typeof postgres> & { closes: number }; failed?: ReturnType<typeof postgres> & { closes: number } } = {};
    const revokedHarness = productionHarness(async () => {
      if (++builds === 1) return candidate(first);
      throw new ManagedPostgresPoolError('target_unverified');
    }, {
      createUrlPool: () => {
        urlAttempts++;
        if (urlAttempts === 1) {
          urlPools.failed = callableUrlPool('failed-url', async () => { throw new Error('stubbed URL attach failure'); });
          return urlPools.failed!;
        }
        urlPools.connected = callableUrlPool('url-after-reset', async () => { await urlProof.promise; return []; });
        madeUrlPool.resolve();
        return urlPools.connected!;
      },
    });
    const engine = revokedHarness.create();
    await engine.connect(config());
    await expect(engine.reconnect()).rejects.toMatchObject({ kind: 'target_unverified' });
    const ownerHarness = productionHarness(async () => candidate(replacement));
    const owner = ownerHarness.create(); await owner.connect(config());
    const urlConfig = { engine: 'postgres' as const, database_url: 'postgresql://user:secret@localhost/brain', poolSize: 2 };
    await expect(engine.connect(urlConfig)).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(urlAttempts).toBe(0);
    await engine.disconnect();
    await expect(engine.connect(urlConfig)).rejects.toThrow('stubbed URL attach failure');
    expect(() => engine.sql).toThrow(ManagedPostgresPoolError);
    expect(urlPools.failed?.closes).toBe(1);
    expect(owner.sql).toBe(replacement);
    const connectingUrl = engine.connect(urlConfig);
    await madeUrlPool.promise;
    expect(() => engine.sql).toThrow(ManagedPostgresPoolError);
    urlProof.resolve();
    await connectingUrl;
    expect(engine.sql).toBe(urlPools.connected!);
    expect(owner.sql).toBe(replacement);
  });

  test('same-engine concurrent reconnect joins the deferred refresh outcome', async () => {
    const old = fakePool('same-engine-old'), replacement = fakePool('same-engine-new');
    const proof = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>();
    let builds = 0;
    const h = harness(async () => ++builds === 1 ? candidate(old) : (builds === 2 ? proof.promise : candidate(replacement)));
    const engine = h.create(); await engine.connect(config());
    const first = engine.reconnect(), second = engine.reconnect();
    await Promise.resolve();
    expect(builds).toBe(2);
    let settled = false;
    void second.then(() => { settled = true; });
    expect(settled).toBe(false);
    proof.resolve(candidate(replacement));
    await Promise.all([first, second]);
    expect(engine.sql).toBe(replacement);
    expect(builds).toBe(2);
  });

  test('completed refresh clears bookkeeping before old close so the next classified refresh is independent', async () => {
    const poolA = fakePool('refresh-A'), poolB = fakePool('refresh-B');
    const releaseA = deferred<void>(), closeStarted = deferred<void>();
    let builds = 0;
    const h = harness(async () => {
      builds++;
      if (builds === 1) return candidate(poolA);
      if (builds === 2) return candidate(poolB);
      throw new ManagedPostgresPoolError('target_unverified');
    }, {
      closePool: async pool => {
        if (pool === poolA) { closeStarted.resolve(); await releaseA.promise; }
        await pool.end({ timeout: 2 });
      },
    });
    const engine = h.create(); await engine.connect(config());
    await engine.reconnect();
    await closeStarted.promise;
    expect(engine.connectionManager?.read()).toBe(poolB);
    let secondSettled = false;
    const second = engine.reconnect().then(() => { secondSettled = true; }, error => { secondSettled = true; return error; });
    await poolB.closed;
    expect(builds).toBe(3);
    expect(secondSettled).toBe(false);
    expect(() => engine.sql).toThrow(ManagedPostgresPoolError);
    releaseA.resolve();
    await poolA.closed;
    const failure = await second;
    expect(failure).toBeInstanceOf(ManagedPostgresPoolError);
    expect(poolA.closes).toBe(1);
    expect(poolB.closes).toBe(1);
  });

  test('owner, independent borrower and descendant coalesce concurrent refresh and route every read to replacement', async () => {
    const old = fakePool('coalesced-old'), replacement = fakePool('coalesced-new');
    const proof = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>();
    let builds = 0;
    const h = harness(async () => ++builds === 1 ? candidate(old) : proof.promise);
    const owner = h.create(), borrower = h.create();
    await owner.connect(config()); await borrower.connect(config());
    const child = h.create(); await child.connect(config(owner.connectionManager!));
    const reconnects = [owner.reconnect(), borrower.reconnect(), child.reconnect()];
    await Promise.resolve();
    expect(builds).toBe(2);
    expect(owner.sql).toBe(old);
    proof.resolve(candidate(replacement));
    await Promise.all(reconnects);
    expect(owner.connectionManager?.read()).toBe(replacement);
    expect(borrower.connectionManager?.read()).toBe(replacement);
    expect(child.connectionManager?.read()).toBe(replacement);
  });

  test('unavailable keeps old pool; security failure revokes views with fixed classification', async () => {
    const old = fakePool('old'); let attempt = 0;
    const h = harness(async () => { if (++attempt === 1) return candidate(old); if (attempt === 2) throw new ManagedPostgresPoolError('unavailable'); return candidate(fakePool('foreign'), `${identity}:foreign`); });
    const engine = h.create(); await engine.connect(config()); const manager = engine.connectionManager;
    await expect(engine.reconnect()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(engine.connectionManager).toBe(manager); expect(engine.sql).toBe(old);
    await expect(engine.reconnect()).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(old.closes).toBe(1); expect(engine.connectionManager).toBeNull();
  });

  test('real candidate signature mismatch revokes the established managed session', async () => {
    const old = fakePool('signature-old'), failed = fakePool('signature-failed');
    let attempts = 0, queries = 0;
    const h = harness(async engineConfig => createManagedPostgresCandidate(engineConfig, {}, {
      configDir: () => '/private/test-config',
      resolve: (() => ({
        identity,
        options: { path: '/private/socket/.s.PGSQL.5432', user: 'gbrain', database: 'brain', port: 5432, ssl: false, debug: false, password: async () => 'not-used' },
        assertPinnedState() {}, hasSecurityFailure() { return false; },
        verifyLiveIdentity(value: unknown) { return value as never; },
      })) as never,
      create: (() => ++attempts === 1 ? old : failed) as never,
      end: async pool => { await pool.end({ timeout: 2 }); },
      query: async () => {
        if (++queries === 2) throw Object.assign(new Error('must not escape'), { code: 'SASL_SIGNATURE_MISMATCH' });
        return [{ identity: { live: true } }];
      },
    }));
    const engine = h.create();
    await engine.connect(config());
    const originalManager = engine.connectionManager;
    await expect(engine.reconnect()).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(engine.connectionManager).not.toBe(originalManager);
    expect(() => engine.sql).toThrow(ManagedPostgresPoolError);
    expect(old.closes).toBe(1);
    expect(failed.closes).toBe(1);
  });

  test('target_unverified revokes owner, borrower, and descendants before pool close', async () => {
    const old = fakePool('revoked-old'); let attempt = 0;
    const h = harness(async () => {
      if (++attempt === 1) return candidate(old);
      if (attempt === 2) throw new ManagedPostgresPoolError('target_unverified');
      return candidate(fakePool('unexpected'));
    });
    const owner = h.create(), borrower = h.create();
    await owner.connect(config()); await borrower.connect(config());
    const child = h.create(); await child.connect(config(owner.connectionManager!));
    await expect(owner.reconnect()).rejects.toMatchObject({ kind: 'target_unverified', message: 'Managed PostgreSQL pool could not be constructed or verified.' });
    for (const engine of [owner, borrower, child]) {
      expect(() => engine.sql).toThrow(ManagedPostgresPoolError);
    }
    expect(old.closes).toBe(1);
  });

  test('parent disconnect invalidates child and child detach never closes parent', async () => {
    const parentPool = fakePool('parent'); const h = harness(async () => candidate(parentPool));
    const parent = h.create(); await parent.connect(config());
    const child = h.create(); await child.connect(config(parent.connectionManager!));
    await child.disconnect(); expect(parentPool.closes).toBe(0);
    const anotherChild = h.create(); await anotherChild.connect(config(parent.connectionManager!));
    await parent.disconnect();
    expect(() => anotherChild.sql).toThrow(ManagedPostgresPoolError);
    expect(parentPool.closes).toBe(1);
  });

  test('disconnected parent-mode manager has no parent route fallback', async () => {
    const pool = fakePool('parent-only');
    const h = harness(async () => candidate(pool));
    const parent = h.create(); await parent.connect(config());
    const child = h.create(); await child.connect(config(parent.connectionManager!));
    const childManager = child.connectionManager!;
    await child.disconnect();
    expect(childManager.peekReadPool()).toBeNull();
    expect(await childManager.getReadPool().catch(() => null)).toBeNull();
    expect(() => childManager.read()).toThrow();
    expect(parent.connectionManager?.read()).toBe(pool);
    expect(pool.closes).toBe(0);
    await parent.disconnect();
  });

  test('legacy singleton connect retains its real factory for engine refresh', async () => {
    const first = fakePool('legacy-first'), replacement = fakePool('legacy-replacement');
    let builds = 0;
    const singleton = new ManagedPostgresSingleton<object>(kind => new ManagedPostgresPoolError(kind), async pool => { await (pool as typeof first).end(); });
    const build = async () => candidate(++builds === 1 ? first : replacement) as unknown as { pool: object; identity: string };
    expect(await singleton.connect(identity, build)).toBe(true);
    const deps: ManagedEngineDependencies = {
      createCandidate: build as ManagedEngineDependencies['createCandidate'],
      closePool: async pool => { await pool.end({ timeout: 2 }); },
      createManager: options => new ConnectionManager(options),
      acquireManaged: singleton.acquire.bind(singleton) as typeof db.acquireManaged,
      beginManagedRelease: singleton.beginRelease.bind(singleton),
    };
    const engine = new PostgresEngine(deps); engines.push(engine);
    await engine.connect(config());
    expect(engine.connectionManager?.read()).toBe(first);
    await engine.reconnect();
    expect(builds).toBe(2);
    expect(engine.connectionManager?.read()).toBe(replacement);
    expect(first.closes).toBe(1);
    expect(replacement.closes).toBe(0);
    await engine.disconnect();
    await singleton.disconnect();
    expect(replacement.closes).toBe(1);
  });

  test('initial disconnect promptly rejects all waiters and later closes an eventual candidate once', async () => {
    const proof = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>();
    const singleton = new ManagedPostgresSingleton<ReturnType<typeof postgres>>(kind => new ManagedPostgresPoolError(kind), async pool => { await pool.end({ timeout: 2 }); });
    const deps: ManagedEngineDependencies = {
      createCandidate: async () => proof.promise,
      closePool: async pool => { await pool.end({ timeout: 2 }); },
      createManager: options => new ConnectionManager(options),
      acquireManaged: singleton.acquire.bind(singleton),
      beginManagedRelease: singleton.beginRelease.bind(singleton),
      teardownTimeoutMs: 5,
    };
    const owner = new PostgresEngine(deps), borrower = new PostgresEngine(deps); engines.push(owner, borrower);
    const ownerConnect = owner.connect(config()).then(() => 'resolved', () => 'rejected');
    const borrowerConnect = borrower.connect(config()).then(() => 'resolved', () => 'rejected');
    const closing = owner.disconnect();
    expect(await ownerConnect).toBe('rejected');
    expect(await borrowerConnect).toBe('rejected');
    await closing;
    const current = fakePool('new-after-pending');
    const next = singleton.acquire(identity, config(), async () => candidate(current));
    await next.ready;
    const late = fakePool('late-after-pending'); proof.resolve(candidate(late)); await late.closed;
    expect(late.closes).toBe(1);
    expect(singleton.getPool()).toBe(current);
    await singleton.beginRelease(next.owner!).finish();
  });

  test('disconnect promptly rejects unresolved refresh waiters and preserves a newer singleton', async () => {
    const old = fakePool('refresh-original'), late = fakePool('refresh-late'), current = fakePool('refresh-current');
    const proof = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>();
    let builds = 0;
    const singleton = new ManagedPostgresSingleton<ReturnType<typeof postgres>>(kind => new ManagedPostgresPoolError(kind), async pool => { await pool.end({ timeout: 2 }); });
    const build = async () => ++builds === 1 ? candidate(old) : proof.promise;
    const deps: ManagedEngineDependencies = {
      createCandidate: build,
      closePool: async pool => { await pool.end({ timeout: 2 }); },
      createManager: options => new ConnectionManager(options),
      acquireManaged: singleton.acquire.bind(singleton),
      beginManagedRelease: singleton.beginRelease.bind(singleton),
      teardownTimeoutMs: 5,
    };
    const owner = new PostgresEngine(deps), borrower = new PostgresEngine(deps); engines.push(owner, borrower);
    await owner.connect(config()); await borrower.connect(config());
    const reconnect1 = owner.reconnect().then(() => 'resolved', () => 'rejected');
    const reconnect2 = borrower.reconnect().then(() => 'resolved', () => 'rejected');
    await Promise.resolve();
    const closing = owner.disconnect();
    expect(await reconnect1).toBe('rejected');
    expect(await reconnect2).toBe('rejected');
    await closing;
    const newer = singleton.acquire(identity, config(), async () => candidate(current));
    await newer.ready;
    proof.resolve(candidate(late)); await late.closed;
    expect(late.closes).toBe(1);
    expect(old.closes).toBe(1);
    expect(singleton.getPool()).toBe(current);
    await singleton.beginRelease(newer.owner!).finish();
  });

  test('active URL resources reject managed connect without changing the applied connection', async () => {
    const urlPool = fakePool('url-active');
    const engine = new PostgresEngine();
    const manager = new ConnectionManager({ url: 'postgresql://localhost/brain', readPoolOwnedExternally: true });
    manager.setReadPool(urlPool);
    const state = engine as unknown as { _sql: ReturnType<typeof postgres> | null; connectionManager: ConnectionManager | null; _connectionStyle: 'instance' | 'module' | null; _savedConfig: EngineConfig | null };
    state._sql = urlPool; state.connectionManager = manager; state._connectionStyle = 'instance';
    state._savedConfig = { engine: 'postgres', database_url: 'postgresql://localhost/brain' };
    const applied = state._savedConfig;
    await expect(engine.connect(config())).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(engine.sql).toBe(urlPool);
    expect(state._savedConfig).toBe(applied);
    await engine.disconnect();
    expect(urlPool.closes).toBe(1);
  });

  test('managed attachment rejects style and parent changes while preserving saved config', async () => {
    const h = harness(async () => candidate(fakePool('style-check')));
    const engine = h.create(); await engine.connect({ ...config(), poolSize: 2 });
    const state = engine as unknown as { _savedConfig: (EngineConfig & { poolSize?: number }) | null };
    const applied = state._savedConfig;
    await expect(engine.connect({ ...config(), poolSize: 3 })).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(state._savedConfig).toBe(applied);
    expect(state._savedConfig?.poolSize).toBe(2);
    const anotherParent = h.create(); await anotherParent.connect(config());
    await expect(engine.connect(config(anotherParent.connectionManager!))).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(state._savedConfig).toBe(applied);
    await anotherParent.disconnect(); await engine.disconnect();
  });

  test('conflicting concurrent managed connect rejects before it can join or overwrite first config', async () => {
    const pool = fakePool('first-module-connect');
    const proof = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>();
    let builds = 0;
    const h = harness(async () => { builds++; return proof.promise; });
    const engine = h.create();
    const firstConfig = config();
    const first = engine.connect(firstConfig);
    await Promise.resolve();
    const conflicting = engine.connect({ ...config(), poolSize: 2 });
    await expect(conflicting).rejects.toMatchObject({ kind: 'target_unverified' });
    expect((engine as unknown as { _savedConfig: EngineConfig | null })._savedConfig).toBeNull();
    expect(builds).toBe(1);
    proof.resolve(candidate(pool));
    await first;
    expect(engine.connectionManager?.read()).toBe(pool);
    expect((engine as unknown as { _savedConfig: EngineConfig })._savedConfig).toBe(firstConfig);
    expect(builds).toBe(1);
  });

  test('parent/acquisition conflicts leave engine disconnected and retryable', async () => {
    const h = harness(async () => candidate(fakePool('retry')));
    const engine = h.create();
    const invalidParent = new ConnectionManager({ url: 'postgresql://localhost/brain' });
    await expect(engine.connect(config(invalidParent))).rejects.toMatchObject({ kind: 'target_unverified' });
    await expect(engine.connect(config())).resolves.toBeUndefined();
    expect(engine.connectionManager?.read()).toBeTruthy();
  });

  test('revoked attached session cannot make same-target connect idempotent', async () => {
    const first = fakePool('revoked-same-target'); let attempts = 0;
    const h = harness(async () => { if (++attempts === 1) return candidate(first); throw new ManagedPostgresPoolError('target_unverified'); });
    const owner = h.create(), borrower = h.create();
    await owner.connect(config()); await borrower.connect(config());
    await expect(owner.reconnect()).rejects.toMatchObject({ kind: 'target_unverified' });
    await expect(borrower.connect(config())).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(borrower.connectionManager).not.toBeNull();
    await owner.disconnect(); await borrower.disconnect();
  });

  test('manager construction failure releases only its creator lease; instance retirement is isolated', async () => {
    const first = fakePool('module'), instance = fakePool('instance'); let builds = 0, managers = 0;
    const h = harness(async () => candidate(++builds === 1 ? first : instance));
    const deps: ManagedEngineDependencies = { ...h.deps, createManager: options => { if (++managers === 2) throw new Error('/private/path secret'); return new ConnectionManager(options); } };
    const owner = new PostgresEngine(deps), failing = new PostgresEngine(deps); engines.push(owner, failing);
    await owner.connect(config());
    await expect(failing.connect(config())).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(first.closes).toBe(0);
    const independent = h.create(); await independent.connect({ ...config(), poolSize: 2 });
    await independent.disconnect();
    expect(instance.closes).toBe(1);
    expect(owner.sql).toBe(first);
    await owner.disconnect(); expect(first.closes).toBe(1);
  });

  test('creator manager failure releases its exact binding and closes its candidate once', async () => {
    const owned = fakePool('manager-failure');
    const h = harness(async () => candidate(owned), { createManager: () => { throw new Error('/private/path secret'); } });
    const engine = h.create();
    await expect(engine.connect(config())).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(owned.closes).toBe(1);
    expect(() => engine.sql).toThrow(ManagedPostgresPoolError);
  });

  test('unknown construction failures become fixed secret-free target_unverified errors', async () => {
    const h = harness(async () => { throw new Error('postgres://user:secret@host/private/socket'); });
    const engine = h.create();
    let failure: unknown;
    try { await engine.connect(config()); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ kind: 'target_unverified', message: 'Managed PostgreSQL pool could not be constructed or verified.' });
    expect(JSON.stringify(failure)).not.toMatch(/secret|private|postgres:|00000000/);
  });

  test('instance pool options always suppress notices and target identity remains opaque in errors', async () => {
    let options: Record<string, unknown> | undefined;
    const previous = process.env.GBRAIN_PG_NOTICES;
    process.env.GBRAIN_PG_NOTICES = '1';
    try {
      const h = harness(async (_config, value) => { options = value; return candidate(fakePool('instance')); });
      const engine = h.create(); await engine.connect({ ...config(), poolSize: 2 });
      expect(options?.onnotice).toBeFunction();
      expect(managedInstanceOptions({ ...config(), poolSize: 2 }).onnotice).toBeFunction();
      expect(managedModuleOptions().onnotice).toBeFunction();
      expect(db.resolvePoolNoticeHandler()).toBeUndefined();
      expect(db.resolvePoolNoticeHandler(true)).toBeFunction();
      expect(JSON.stringify(options)).not.toContain('GBRAIN_PG_NOTICES');
    } finally {
      if (previous === undefined) delete process.env.GBRAIN_PG_NOTICES;
      else process.env.GBRAIN_PG_NOTICES = previous;
    }
    expect(() => { throw new ManagedPostgresPoolError('target_unverified'); }).toThrow('Managed PostgreSQL pool could not be constructed or verified.');
  });

  test('refresh builds a fresh credential callback and observes resolver rotation', async () => {
    const pools = [fakePool('credential-first'), fakePool('credential-second')];
    let credential = 'first-value';
    let resolverCalls = 0;
    const callbacks: Array<() => Promise<string>> = [];
    const deps: ManagedEngineDependencies = {
      createCandidate: async (engineConfig, options) => createManagedPostgresCandidate(engineConfig, options, {
        configDir: () => '/private/test-config',
        resolve: (() => {
          resolverCalls++;
          return {
            identity,
            options: { path: '/private/socket/.s.PGSQL.5432', user: 'gbrain', database: 'brain', port: 5432, ssl: false, debug: false, password: async () => credential },
            assertPinnedState() {},
            hasSecurityFailure() { return false; },
            verifyLiveIdentity(value: unknown) { return value as never; },
          };
        }) as never,
        create: ((driverOptions: Record<string, unknown>) => {
          callbacks.push(driverOptions.password as () => Promise<string>);
          return pools[resolverCalls - 1];
        }) as never,
        end: async poolValue => { await poolValue.end({ timeout: 2 }); },
        query: async () => [{ identity: { data_directory: '/private/data' } }],
      }),
      closePool: async value => { await value.end({ timeout: 2 }); },
      createManager: options => new ConnectionManager(options),
    };
    const engine = new PostgresEngine(deps);
    engines.push(engine);
    await engine.connect(config());
    expect(await callbacks[0]!()).toBe('first-value');
    credential = 'rotated-value';
    await engine.reconnect();
    expect(callbacks).toHaveLength(2);
    expect(callbacks[0]).not.toBe(callbacks[1]);
    expect(await callbacks[1]!()).toBe('rotated-value');
  });

  test('instance refresh proves a fresh candidate without replacing its manager', async () => {
    const first = fakePool('instance-first'), second = fakePool('instance-second');
    let builds = 0;
    const h = harness(async () => candidate(++builds === 1 ? first : second));
    const engine = h.create();
    await engine.connect({ ...config(), poolSize: 3 });
    const manager = engine.connectionManager;
    await engine.reconnect();
    expect(builds).toBe(2);
    expect(engine.connectionManager).toBe(manager);
    expect(engine.sql).toBe(second);
    expect(first.closes).toBe(1);
  });

  test('pending managed acquisition reserves module slot against URL connection before any driver construction', async () => {
    const proof = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>();
    let builds = 0;
    const build = async () => { builds++; return proof.promise; };
    const acquisition = db.acquireManaged(identity, config(), build);
    const borrower = db.acquireManaged(identity, config(), build);
    await Promise.resolve();
    expect(builds).toBe(1);
    expect(acquisition.owner).not.toBeNull();
    expect(borrower.owner).toBeNull();
    expect(borrower.session).not.toBe(acquisition.session);
    await expect(db.connect({ engine: 'postgres', database_url: 'postgresql://user:secret@127.0.0.1/brain' } as EngineConfig))
      .rejects.toBeInstanceOf(ManagedPostgresPoolError);
    const retirement = db.beginManagedRelease(acquisition.owner!);
    await retirement.finish();
    const late = fakePool('late-db-adapter');
    proof.resolve(candidate(late)); await late.closed;
    await expect(acquisition.ready).rejects.toBeInstanceOf(ManagedPostgresPoolError);
    await expect(borrower.ready).rejects.toBeInstanceOf(ManagedPostgresPoolError);
    expect(late.closes).toBe(1);
  });

  test('repeated stale release is inert against a newer singleton binding', async () => {
    const oldProof = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>();
    const old = db.acquireManaged(identity, config(), async () => oldProof.promise);
    const retirement = db.beginManagedRelease(old.owner!);
    await retirement.finish();
    const currentPool = fakePool('current-module');
    const current = db.acquireManaged(identity, config(), async () => candidate(currentPool));
    await current.ready;
    await db.beginManagedRelease(old.owner!).finish();
    expect(db.getConnection()).toBe(currentPool);
    const latePool = fakePool('old-late-module');
    oldProof.resolve(candidate(latePool)); await latePool.closed;
    await expect(old.ready).rejects.toBeInstanceOf(ManagedPostgresPoolError);
    expect(latePool.closes).toBe(1);
    expect(db.getConnection()).toBe(currentPool);
    await db.beginManagedRelease(current.owner!).finish();
  });

  test('global shutdown snapshots the old binding before a newer same-target acquisition', async () => {
    const oldProof = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>();
    const old = db.acquireManaged(identity, config(), async () => oldProof.promise);
    const shutdown = db.beginManagedGlobalShutdown().finish();
    const currentPool = fakePool('after-global-shutdown');
    const current = db.acquireManaged(identity, config(), async () => candidate(currentPool));
    await current.ready;
    const oldPool = fakePool('late-global-candidate');
    oldProof.resolve(candidate(oldPool)); await oldPool.closed;
    await expect(old.ready).rejects.toBeInstanceOf(ManagedPostgresPoolError);
    await shutdown;
    expect(oldPool.closes).toBe(1);
    expect(db.getConnection()).toBe(currentPool);
    await db.beginManagedRelease(current.owner!).finish();
  });

  test('throwing and never-settling stop hooks cannot skip pool retirement', async () => {
    const value = fakePool('hooked');
    const h = harness(async () => candidate(value));
    const throwing = h.create(); await throwing.connect(config());
    throwing.registerBeforeDisconnect(async () => { throw new Error('stop failed'); });
    await throwing.disconnect(); expect(value.closes).toBe(1);

    const another = fakePool('hanging-hook'), h2 = harness(async () => candidate(another), { teardownTimeoutMs: 5 });
    const hanging = h2.create(); await hanging.connect(config());
    hanging.registerBeforeDisconnect(() => new Promise<void>(() => {}));
    await hanging.disconnect(); expect(another.closes).toBe(1);
  });

  test('delayed hook retirement closes only the old binding after a same-target replacement attaches', async () => {
    const old = fakePool('delayed-old'), fresh = fakePool('delayed-new');
    let builds = 0;
    const h = harness(async () => candidate(++builds === 1 ? old : fresh), { teardownTimeoutMs: 100 });
    const owner = h.create(); await owner.connect(config());
    const hook = deferred<void>();
    owner.registerBeforeDisconnect(() => hook.promise);
    const closing = owner.disconnect();
    const replacement = h.create(); await replacement.connect(config());
    expect(replacement.sql).toBe(fresh);
    hook.resolve();
    await closing;
    expect(old.closes).toBe(1);
    expect(fresh.closes).toBe(0);
    expect(replacement.sql).toBe(fresh);
  });

  test('release during refresh closes a late candidate once without publishing or closing newer binding', async () => {
    const old = fakePool('refresh-old'), late = fakePool('refresh-late'), fresh = fakePool('refresh-fresh');
    const refreshProof = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>();
    let builds = 0;
    const h = harness(async () => {
      builds++;
      if (builds === 1) return candidate(old);
      if (builds === 2) return refreshProof.promise;
      return candidate(fresh);
    });
    const owner = h.create(); await owner.connect(config());
    const refreshing = owner.reconnect();
    const closing = owner.disconnect();
    const newer = h.create(); await newer.connect(config());
    refreshProof.resolve(candidate(late));
    await expect(refreshing).rejects.toMatchObject({ kind: 'target_unverified' });
    await closing;
    expect(late.closes).toBe(1);
    expect(old.closes).toBe(1);
    expect(fresh.closes).toBe(0);
    expect(newer.sql).toBe(fresh);
  });

  test('transaction clone stays bound to its transaction handle during managed refresh', async () => {
    const old = fakePool('transaction-parent'), replacement = fakePool('transaction-replacement'); let builds = 0;
    const tx = { unsafe: async () => [], end: async () => {} } as unknown as ReturnType<typeof postgres>;
    const h = harness(async () => candidate(++builds === 1 ? old : replacement));
    const engine = h.create(); await engine.connect(config());
    (old as unknown as { begin: (fn: (handle: unknown) => Promise<unknown>) => Promise<unknown> }).begin = fn => fn(tx);
    await engine.transaction(async transaction => {
      await engine.reconnect();
      const transactionEngine = transaction as import('../src/core/postgres-engine.ts').PostgresEngine;
      const transactionSql = transactionEngine.sql;
      expect(transactionSql).not.toBe(old);
      expect(transactionSql).not.toBe(replacement);
      expect(transactionEngine.connectionManager?.read()).toBe(transactionSql);
    });
  });
});
