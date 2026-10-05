import { afterEach, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { ConnectionManager, type ConnectionManagerOpts } from '../src/core/connection-manager.ts';
import { ManagedPostgresPoolError } from '../src/core/managed-postgres-pool.ts';
import { createManagedPostgresCandidate } from '../src/core/managed-postgres-pool.ts';
import type { ManagedEngineDependencies } from '../src/core/postgres-engine-managed.ts';
import type { EngineConfig } from '../src/core/types.ts';

const ref = (id: string) => ({ manager_id: 'gbrain-managed-postgres' as const, cluster_id: `00000000-0000-4000-8000-${id.padStart(12, '0')}` });
const config = (id = '1', poolSize?: number, parentConnectionManager?: ConnectionManager): EngineConfig & { poolSize?: number; parentConnectionManager?: ConnectionManager } => ({
  engine: 'postgres', managed_postgres: ref(id), ...(poolSize ? { poolSize } : {}), ...(parentConnectionManager ? { parentConnectionManager } : {}),
});

const allEngines: PostgresEngine[] = [];
afterEach(async () => { for (const engine of allEngines.splice(0)) await engine.disconnect(); });

function pool(name: string) {
  const p = {
    name,
    endCalls: 0,
    end: async () => { p.endCalls++; },
    unsafe: async () => [],
  };
  return p as unknown as ReturnType<typeof postgres> & typeof p;
}

function setup(overrides: Partial<ManagedEngineDependencies> = {}) {
  const created: unknown[] = [], closed: unknown[] = [], candidates: Array<() => Promise<{ pool: ReturnType<typeof postgres>; identity: string }>> = [];
  const committed = pool('module');
  let moduleOwner = true, moduleDisconnects = 0, managerCalls = 0;
  const dependencies: ManagedEngineDependencies = {
    createCandidate: async (_config, options) => {
      created.push(options);
      const next = candidates.shift();
      if (!next) throw new ManagedPostgresPoolError('unavailable');
      return next();
    },
    closePool: async p => { closed.push(p); await p.end({ timeout: 2 }); },
    dbConnect: async () => { const owner = moduleOwner; moduleOwner = false; return owner; },
    dbGetConnection: () => committed,
    dbDisconnect: async () => { moduleDisconnects++; },
    createManager: (opts: ConnectionManagerOpts) => { managerCalls++; return new ConnectionManager(opts); },
    ...overrides,
  };
  const createEngine = () => { const engine = new PostgresEngine(dependencies); allEngines.push(engine); return engine; };
  return { dependencies, createEngine, created, closed, candidates, committed, moduleDisconnects: () => moduleDisconnects, managerCalls: () => managerCalls };
}

const candidateFor = (id: string, p: ReturnType<typeof postgres>) => ({ pool: p, identity: `postgres-managed:v1:gbrain-managed-postgres:${ref(id).cluster_id}` });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('PostgresEngine managed targets', () => {
  test('module creator/borrower managers wrap committed pool and only creator disconnects shared db', async () => {
    const h = setup();
    const creator = h.createEngine(), borrower = h.createEngine();
    await creator.connect(config());
    await borrower.connect(config());
    expect(creator.connectionManager?.managedIdentity).toBe(candidateFor('1', h.committed).identity);
    expect(creator.connectionManager?.peekReadPool()).toBe(h.committed);
    expect((creator as unknown as { _ownsModuleSingleton: boolean })._ownsModuleSingleton).toBe(true);
    expect((borrower as unknown as { _ownsModuleSingleton: boolean })._ownsModuleSingleton).toBe(false);
    await borrower.disconnect();
    expect(h.moduleDisconnects()).toBe(0);
    await creator.disconnect();
    expect(h.moduleDisconnects()).toBe(1);
  });

  test('module manager failure cleans up creator but never disconnects borrower singleton', async () => {
    for (const isOwner of [true, false]) {
      let disconnects = 0;
      const h = setup({
        dbConnect: async () => isOwner,
        dbDisconnect: async () => { disconnects++; },
        createManager: () => { throw new Error('hostile /private/path secret'); },
      });
      const engine = h.createEngine();
      await expect(engine.connect(config())).rejects.toMatchObject({
        kind: 'target_unverified', message: 'Managed PostgreSQL pool could not be constructed or verified.',
      });
      expect(disconnects).toBe(isOwner ? 1 : 0);
      expect(() => engine.sql).toThrow(ManagedPostgresPoolError);
    }
  });

  test('instance remains private until proof; uses standard no-URL options and manager owns no pool', async () => {
    const h = setup();
    const proof = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>();
    h.candidates.push(() => proof.promise);
    const engine = h.createEngine();
    const connecting = engine.connect(config('2', 7));
    expect(h.created).toHaveLength(1);
    const options = h.created[0] as Record<string, unknown>;
    expect(options).toMatchObject({ max: 7, idle_timeout: 20, connect_timeout: 10, types: { bigint: postgres.BigInt }, connection: { statement_timeout: '5min', idle_in_transaction_session_timeout: '5min' } });
    expect(typeof options.onnotice).toBe('function');
    expect(options).toHaveProperty('max_lifetime');
    expect(options.prepare).toBeUndefined();
    expect(options).not.toHaveProperty('url');
    expect(() => engine.sql).toThrow(ManagedPostgresPoolError);
    const candidatePool = pool('candidate');
    proof.resolve(candidateFor('2', candidatePool));
    await connecting;
    expect(engine.sql).toBe(candidatePool);
    expect(engine.connectionManager?.peekReadPool()).toBe(candidatePool);
    expect(engine.connectionManager?.isManagedMode).toBe(true);
    expect(candidatePool.endCalls).toBe(0);
  });

  test('initial manager failure closes owned candidate exactly once', async () => {
    const candidatePool = pool('candidate');
    const h = setup({ createCandidate: async () => candidateFor('3', candidatePool), createManager: () => { throw new Error('/secret'); } });
    const engine = h.createEngine();
    await expect(engine.connect(config('3', 3))).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(candidatePool.endCalls).toBe(1);
    expect(h.closed).toEqual([candidatePool]);
    expect(() => engine.sql).toThrow(ManagedPostgresPoolError);
  });

  test('matching parent shares exact pool without constructing or closing a candidate; mismatch refuses', async () => {
    const h = setup();
    const parentPool = pool('parent');
    const parent = new ConnectionManager({ managedIdentity: candidateFor('4', parentPool).identity, managedPool: parentPool });
    const child = h.createEngine();
    await child.connect(config('4', 5, parent));
    expect(child.sql).toBe(parentPool);
    const refreshed = pool('refreshed-parent');
    parent.setReadPool(refreshed);
    expect(child.sql).toBe(refreshed);
    expect(h.created).toHaveLength(0);
    await child.disconnect();
    expect(parentPool.endCalls).toBe(0);
    expect(refreshed.endCalls).toBe(0);
    const mismatch = h.createEngine();
    await expect(mismatch.connect(config('5', 5, parent))).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(h.created).toHaveLength(0);
    expect(parentPool.endCalls).toBe(0);
  });

  test('managed reconnect verifies replacement before swap and closes old pool once', async () => {
    const old = pool('old'), replacement = pool('replacement');
    let build = 0;
    const h = setup({ createCandidate: async () => candidateFor('6', ++build === 1 ? old : replacement) });
    const engine = h.createEngine();
    await engine.connect(config('6', 4));
    const oldManager = engine.connectionManager;
    await engine.reconnect();
    expect(engine.sql).toBe(replacement);
    expect(engine.connectionManager).not.toBe(oldManager);
    expect(old.endCalls).toBe(1);
    expect(replacement.endCalls).toBe(0);
  });

  test('fresh reconnect candidate uses a fresh resolver password callback and observes rotation', async () => {
    const pools = [pool('first'), pool('second')];
    let credential = 'first-credential', resolverCalls = 0;
    const callbacks: Array<() => Promise<string>> = [];
    const h = setup({
      createCandidate: async (engineConfig, options) => {
        return createManagedPostgresCandidate(engineConfig, options, {
          configDir: () => '/private/test-config',
          resolve: (() => {
            resolverCalls++;
            return {
              identity: candidateFor('12', pools[resolverCalls - 1]).identity,
              options: { path: '/private/socket/.s.PGSQL.5432', user: 'gbrain', database: 'gbrain', port: 5432, ssl: false, debug: false, password: async () => credential },
              assertPinnedState() {}, verifyLiveIdentity(value: unknown) { return value as never; },
            };
          }) as never,
          create: ((driverOptions: Record<string, unknown>) => { callbacks.push(driverOptions.password as () => Promise<string>); return pools[resolverCalls - 1]; }) as never,
          end: async p => { await p.end({ timeout: 2 }); },
          query: async () => [{ identity: { data_directory: '/private/data' } }],
        });
      },
    });
    const engine = h.createEngine();
    await engine.connect(config('12', 2));
    expect(await callbacks[0]()).toBe('first-credential');
    credential = 'rotated-credential';
    await engine.reconnect();
    expect(callbacks).toHaveLength(2);
    expect(callbacks[0]).not.toBe(callbacks[1]);
    expect(await callbacks[1]()).toBe('rotated-credential');
  });

  test('unavailable reconnect retains exact pool and manager; target mismatch invalidates both', async () => {
    const old = pool('old');
    let attempt = 0;
    const h = setup({ createCandidate: async () => {
      attempt++;
      if (attempt === 1) return candidateFor('7', old);
      if (attempt === 2) throw new ManagedPostgresPoolError('unavailable');
      return candidateFor('8', pool('wrong-target'));
    } });
    const engine = h.createEngine();
    await engine.connect(config('7', 4));
    const manager = engine.connectionManager;
    await expect(engine.reconnect()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(engine.sql).toBe(old);
    expect(engine.connectionManager).toBe(manager);
    await expect(engine.reconnect()).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(old.endCalls).toBe(1);
    expect(engine.connectionManager).toBeNull();
    expect(() => engine.sql).toThrow();
  });

  test('disconnect during initial connect or reconnect prevents late publication and closes late candidate once', async () => {
    const firstProof = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>();
    const h = setup();
    h.candidates.push(() => firstProof.promise);
    const connecting = h.createEngine();
    const initial = connecting.connect(config('9', 2));
    await connecting.disconnect();
    const late = pool('late-initial');
    firstProof.resolve(candidateFor('9', late));
    await expect(initial).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(late.endCalls).toBe(1);
    expect(connecting.connectionManager).toBeNull();

    const old = pool('old-reconnect'), lateReconnect = pool('late-reconnect');
    const reconnectProof = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>();
    let count = 0;
    const h2 = setup({ createCandidate: async () => ++count === 1 ? candidateFor('10', old) : reconnectProof.promise });
    const engine = h2.createEngine();
    await engine.connect(config('10', 2));
    const reconnecting = engine.reconnect();
    await engine.disconnect();
    reconnectProof.resolve(candidateFor('10', lateReconnect));
    await expect(reconnecting).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(lateReconnect.endCalls).toBe(1);
    expect(old.endCalls).toBe(1);
    expect(engine.connectionManager).toBeNull();
  });

  test('managed failures are fixed and do not reflect candidate diagnostics', async () => {
    const h = setup({ createCandidate: async () => { throw new Error('postgres://user:topsecret@/private/socket'); } });
    const engine = h.createEngine();
    await expect(engine.connect(config('11', 2))).rejects.toMatchObject({
      kind: 'target_unverified', message: 'Managed PostgreSQL pool could not be constructed or verified.',
    });
  });

  test('manager identity mismatch during reconnect invalidates and closes old trust', async () => {
    const old = pool('old'), next = pool('next');
    let builds = 0, managers = 0;
    const h = setup({
      createCandidate: async () => candidateFor('13', ++builds === 1 ? old : next),
      createManager: (opts: ConnectionManagerOpts) => {
        if (++managers === 2) throw new Error('hostile manager target');
        return new ConnectionManager(opts);
      },
    });
    const engine = h.createEngine();
    await engine.connect(config('13', 3));
    await expect(engine.reconnect()).rejects.toMatchObject({ kind: 'target_unverified', message: 'Managed PostgreSQL pool could not be constructed or verified.' });
    expect(next.endCalls).toBe(1);
    expect(old.endCalls).toBe(1);
    expect(engine.connectionManager).toBeNull();
    expect(() => engine.sql).toThrow();
  });

  test('late initial candidate cannot overwrite a newer managed generation', async () => {
    const staleProof = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>(), current = pool('current'), stale = pool('stale');
    const h = setup();
    h.candidates.push(() => staleProof.promise, async () => candidateFor('15', current));
    const engine = h.createEngine();
    const oldConnect = engine.connect(config('14', 2));
    await engine.disconnect();
    await engine.connect(config('15', 2));
    staleProof.resolve(candidateFor('14', stale));
    await expect(oldConnect).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(engine.sql).toBe(current);
    expect(stale.endCalls).toBe(1);
    expect(current.endCalls).toBe(0);
  });

  test('module connect detached by disconnect cleans only a late creator token', async () => {
    for (const owner of [true, false]) {
      const result = deferred<boolean>();
      let disconnects = 0;
      const h = setup({ dbConnect: () => result.promise, dbDisconnect: async () => { disconnects++; } });
      const engine = h.createEngine();
      const connecting = engine.connect(config());
      await engine.disconnect();
      result.resolve(owner);
      await expect(connecting).rejects.toMatchObject({ kind: 'target_unverified' });
      expect(disconnects).toBe(owner ? 1 : 0);
      expect(engine.connectionManager).toBeNull();
    }
  });

  test('same-target new module generation receives a stale creator token for later teardown', async () => {
    const oldResult = deferred<boolean>(), newResult = deferred<boolean>();
    let calls = 0, disconnects = 0;
    const h = setup({
      dbConnect: () => ++calls === 1 ? oldResult.promise : newResult.promise,
      dbDisconnect: async () => { disconnects++; },
    });
    const engine = h.createEngine();
    const oldConnect = engine.connect(config('18'));
    await engine.disconnect();
    const newConnect = engine.connect(config('18'));
    oldResult.resolve(true);
    await expect(oldConnect).rejects.toMatchObject({ kind: 'target_unverified' });
    newResult.resolve(false);
    await newConnect;
    expect((engine as unknown as { _ownsModuleSingleton: boolean })._ownsModuleSingleton).toBe(true);
    expect(engine.connectionManager?.managedIdentity).toBe(candidateFor('18', h.committed).identity);
    await engine.disconnect();
    expect(disconnects).toBe(1);
  });

  test('stale owner never disconnects a newer different-identity module generation', async () => {
    const oldResult = deferred<boolean>();
    let disconnects = 0;
    let calls = 0;
    const h = setup({ dbConnect: () => ++calls === 1 ? oldResult.promise : Promise.resolve(false), dbDisconnect: async () => { disconnects++; } });
    const engine = h.createEngine();
    const oldConnect = engine.connect(config('19'));
    await engine.disconnect();
    // New identity connects as a borrower while the old creator is still pending.
    const newerConnect = engine.connect(config('20'));
    oldResult.resolve(true);
    await expect(oldConnect).rejects.toMatchObject({ kind: 'target_unverified' });
    await newerConnect;
    expect((engine as unknown as { _ownsModuleSingleton: boolean })._ownsModuleSingleton).toBe(false);
    expect(disconnects).toBe(0);
    expect(engine.connectionManager?.managedIdentity).toBe(candidateFor('20', h.committed).identity);
  });

  test('module reconnect unavailable retains manager/pool/ownership; unverified invalidates and closes only owner', async () => {
    for (const kind of ['unavailable', 'target_unverified'] as const) {
      for (const owner of [true, false]) {
        let calls = 0, disconnects = 0;
        const h = setup({
          dbConnect: async () => {
            if (++calls === 1) return owner;
            throw new ManagedPostgresPoolError(kind);
          },
          dbDisconnect: async () => { disconnects++; },
        });
        const engine = h.createEngine();
        await engine.connect(config('21'));
        const manager = engine.connectionManager;
        await expect(engine.reconnect()).rejects.toMatchObject({
          kind, message: 'Managed PostgreSQL pool could not be constructed or verified.',
        });
        if (kind === 'unavailable') {
          expect(engine.connectionManager).toBe(manager);
          expect(engine.sql).toBe(h.committed);
          expect((engine as unknown as { _ownsModuleSingleton: boolean })._ownsModuleSingleton).toBe(owner);
          expect(disconnects).toBe(0);
        } else {
          expect(engine.connectionManager).toBeNull();
          expect(() => engine.sql).toThrow(ManagedPostgresPoolError);
          expect(disconnects).toBe(owner ? 1 : 0);
        }
      }
    }
  });

  test('late reconnect cannot overwrite a newer connection generation', async () => {
    const old = pool('old'), pendingReplacement = deferred<{ pool: ReturnType<typeof postgres>; identity: string }>(), newer = pool('newer');
    let builds = 0;
    const h = setup({ createCandidate: async () => {
      builds++;
      if (builds === 1) return candidateFor('16', old);
      if (builds === 2) return pendingReplacement.promise;
      return candidateFor('17', newer);
    } });
    const engine = h.createEngine();
    await engine.connect(config('16', 2));
    const reconnecting = engine.reconnect();
    await engine.disconnect();
    await engine.connect(config('17', 2));
    const stale = pool('stale-replacement');
    pendingReplacement.resolve(candidateFor('16', stale));
    await expect(reconnecting).rejects.toMatchObject({ kind: 'target_unverified' });
    expect(engine.sql).toBe(newer);
    expect(stale.endCalls).toBe(1);
    expect(old.endCalls).toBe(1);
    expect(newer.endCalls).toBe(0);
  });

  test('managed module disconnect detaches local access synchronously before shared close', async () => {
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const h = setup({ dbDisconnect: async () => wait });
    const engine = h.createEngine();
    await engine.connect(config());
    const closing = engine.disconnect();
    expect(engine.connectionManager).toBeNull();
    expect(() => engine.sql).toThrow();
    finish();
    await closing;
  });
});
