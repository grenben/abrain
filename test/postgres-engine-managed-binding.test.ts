import { afterEach, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { ConnectionManager } from '../src/core/connection-manager.ts';
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
function fakePool(name: string) { const value = { name, closes: 0, end: async () => { value.closes++; }, unsafe: async () => [] }; return value as unknown as ReturnType<typeof postgres> & typeof value; }
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
    proof.resolve(candidate(late));
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
    oldProof.resolve(candidate(latePool));
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
    oldProof.resolve(candidate(oldPool));
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
