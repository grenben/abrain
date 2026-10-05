import { describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { createManagedPostgresCandidate, ManagedPostgresPoolError } from '../src/core/managed-postgres-pool.ts';
import { MANAGED_IDENTITY_QUERY } from '../src/core/managed-postgres/identity.ts';
import { ManagedPostgresSingleton } from '../src/core/managed-postgres-singleton.ts';

const identity = { data_directory: '/private/data' };
const pool = { end: async () => {}, unsafe: async () => [{ identity: JSON.stringify(identity) }] } as unknown as ReturnType<typeof postgres>;
const validConfig = { engine: 'postgres', managed_postgres: { manager_id: 'gbrain-managed-postgres', cluster_id: '00000000-0000-4000-8000-000000000001' } } as const;

function dependencies(
  result: unknown,
  optionsSeen: (value: unknown) => void,
  closed: () => void,
  overrides: {
    resolve?: (reference: unknown) => unknown; verify?: (value: unknown) => void;
    query?: () => Promise<unknown>; pinned?: () => void; create?: () => never;
  } = {},
) {
  return {
    resolve: ((reference: unknown) => {
      overrides.resolve?.(reference);
      return {
      identity: 'postgres-managed:v1:gbrain-managed-postgres:00000000-0000-4000-8000-000000000001',
      options: { path: '/private/socket/.s.PGSQL.5432', user: 'managed', database: 'app', port: 5432, password: async () => 'secret', ssl: false, debug: false },
      assertPinnedState: () => { overrides.pinned?.(); },
      verifyLiveIdentity: (value: unknown) => {
        if (overrides.verify) return overrides.verify(value);
        if (!value || typeof value !== 'object' || (value as { data_directory?: string }).data_directory !== identity.data_directory) throw new Error('hostile /private/path');
      },
    }; }) as never,
    create: ((...args: unknown[]) => { optionsSeen(args); if (overrides.create) return overrides.create(); return pool; }) as never,
    end: async () => { closed(); },
    configDir: () => '/private/config',
    query: async (_pool: unknown, query: string) => { expect(query).toBe(MANAGED_IDENTITY_QUERY); return overrides.query ? overrides.query() : result; },
  };
}

describe('managed postgres candidate', () => {
  test('constructs without a URL, resolver options win, and normalizes string identity', async () => {
    let args: unknown;
    let closes = 0;
    const sharedOptions = {
      max: 7, idle_timeout: 20, connect_timeout: 10, types: { bigint: 'bigint-type' }, onnotice: 'notice-handler',
      path: '/hostile/path', user: 'hostile-user', database: 'hostile-db', port: 9999,
      password: 'hostile-secret', ssl: 'hostile-ssl', debug: 'hostile-debug',
    };
    const candidate = await createManagedPostgresCandidate(
      validConfig,
      sharedOptions,
      dependencies([{ identity: JSON.stringify(identity) }], value => { args = value; }, () => closes++),
    );
    expect(candidate.identity).toStartWith('postgres-managed:v1:');
    expect(candidate.pool).toBe(pool);
    const [options] = args as [Record<string, unknown>];
    expect(options).toMatchObject({
      max: 7, idle_timeout: 20, connect_timeout: 10, types: sharedOptions.types, onnotice: sharedOptions.onnotice,
      path: '/private/socket/.s.PGSQL.5432', user: 'managed', database: 'app', port: 5432, ssl: false, debug: false,
    });
    expect(options.password).not.toBe(sharedOptions.password);
    expect(await (options.password as () => Promise<string>)()).toBe('secret');
    expect(closes).toBe(0);
  });

  test('accepts a plain-object identity payload', async () => {
    const result = await createManagedPostgresCandidate(validConfig, {}, dependencies([{ identity }], () => {}, () => {}));
    expect(result.pool).toBe(pool);
  });

  test('classifies malformed rows and verifier failures as target_unverified with one close', async () => {
    const malformed = [
      [], [{ identity: '{}' }, { identity: '{}' }], [{}], [{ identity: '{}', extra: 'hostile /private/path' }],
      [{ identity: null }], [{ identity: [] }], [{ identity: 42 }], [{ identity: '{hostile-secret' }],
    ];
    const cases: Array<{ query?: () => Promise<unknown>; verify?: (value: unknown) => void; result?: unknown }> = [
      ...malformed.map(result => ({ result })),
      { result: [{ identity }], verify: () => { throw new Error('/private/hostile-secret'); } },
    ];
    for (const scenario of cases) {
      let closes = 0;
      const deps = dependencies(scenario.result, () => {}, () => closes++, scenario);
      const failure = createManagedPostgresCandidate(validConfig, {}, deps);
      let error: unknown;
      try { await failure; } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(ManagedPostgresPoolError);
      expect((error as ManagedPostgresPoolError).kind).toBe('target_unverified');
      expect((error as Error).message).toBe('Managed PostgreSQL pool could not be constructed or verified.');
      expect(String(error)).not.toMatch(/private|hostile|secret/i);
      expect(closes).toBe(1);
    }
  });

  test('classifies factory, query, and resolver stages without exposing causes', async () => {
    const message = 'Managed PostgreSQL pool could not be constructed or verified.';
    const cases = [
      { stage: 'factory', kind: 'unavailable', overrides: { create: () => { throw new Error('/secret/factory-path'); } }, closes: 0 },
      { stage: 'query-valid-target', kind: 'unavailable', overrides: { query: async () => { throw new Error('/secret/query-path'); }, pinned: () => {} }, closes: 1 },
      { stage: 'query-tampered-target', kind: 'target_unverified', overrides: { query: async () => { throw new Error('/secret/query-path'); }, pinned: () => { throw new Error('/secret/tamper-path'); } }, closes: 1 },
      { stage: 'resolver', kind: 'target_unverified', overrides: { resolve: () => { throw new Error('/secret/resolver-path'); } }, closes: 0 },
    ] as const;
    for (const scenario of cases) {
      let closes = 0;
      const failure = createManagedPostgresCandidate(
        validConfig, {}, dependencies([{ identity }], () => {}, () => closes++, scenario.overrides),
      );
      let error: unknown;
      try { await failure; } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(ManagedPostgresPoolError);
      expect((error as ManagedPostgresPoolError).kind).toBe(scenario.kind);
      expect((error as Error).message).toBe(message);
      expect(String(error)).not.toMatch(/secret|path|tamper/i);
      expect(closes).toBe(scenario.closes);
    }
  });

  test('refuses non-managed or contradictory direct configs before resolver, create, or end', async () => {
    const invalid = [
      { ...validConfig, database_url: 'postgres://hostile-secret' },
      { engine: 'pglite', managed_postgres: validConfig.managed_postgres },
      { engine: 'postgres' },
      { ...validConfig, thin_client: true },
    ];
    for (const config of invalid) {
      let resolves = 0, creates = 0, closes = 0;
      const deps = dependencies([], () => { creates++; }, () => { closes++; }, { resolve: () => { resolves++; } });
      let error: unknown;
      try { await createManagedPostgresCandidate(config as never, {}, deps); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(ManagedPostgresPoolError);
      expect((error as ManagedPostgresPoolError).kind).toBe('target_unverified');
      expect((error as Error).message).toBe('Managed PostgreSQL pool could not be constructed or verified.');
      expect(String(error)).not.toMatch(/hostile|secret/i);
      expect([resolves, creates, closes]).toEqual([0, 0, 0]);
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const managedError = () => new Error('fixed managed refusal');
const candidate = (id: string, pool: object) => ({ identity: id, pool });

describe('managed singleton coordinator', () => {
  test('keeps pending pool private; coalesces same target with owner/borrower results', async () => {
    const singleton = new ManagedPostgresSingleton<object>(managedError, async () => {});
    const proof = deferred<{ identity: string; pool: object }>();
    let builds = 0;
    const build = () => { builds++; return proof.promise; };
    const owner = singleton.connect('one', build);
    const borrower = singleton.connect('one', build);
    expect(singleton.getPool()).toBeNull();
    expect(builds).toBe(1);
    const pool = {};
    proof.resolve(candidate('one', pool));
    expect(await owner).toBe(true);
    expect(await borrower).toBe(false);
    expect(singleton.getPool()).toBe(pool);
  });

  test('refuses different pending and committed targets; matching committed target borrows', async () => {
    const singleton = new ManagedPostgresSingleton<object>(managedError, async () => {});
    const proof = deferred<{ identity: string; pool: object }>();
    const owner = singleton.connect('one', () => proof.promise);
    await expect(singleton.connect('two', async () => candidate('two', {}))).rejects.toThrow('fixed managed refusal');
    const pool = {};
    proof.resolve(candidate('one', pool));
    expect(await owner).toBe(true);
    expect(await singleton.connect('one', async () => candidate('one', {}))).toBe(false);
    await expect(singleton.connect('two', async () => candidate('two', {}))).rejects.toThrow('fixed managed refusal');
    expect(singleton.getPool()).toBe(pool);
  });

  test('failure clears its own pending state and permits retry', async () => {
    const singleton = new ManagedPostgresSingleton<object>(managedError, async () => {});
    await expect(singleton.connect('one', async () => { throw new Error('/hostile/secret'); })).rejects.toThrow('fixed managed refusal');
    expect(singleton.getPool()).toBeNull();
    expect(await singleton.connect('one', async () => candidate('one', {}))).toBe(true);
  });

  test('disconnect during build closes a late success once and never publishes it', async () => {
    let closes = 0;
    const singleton = new ManagedPostgresSingleton<object>(managedError, async () => { closes++; });
    const proof = deferred<{ identity: string; pool: object }>();
    const old = singleton.connect('one', () => proof.promise);
    await singleton.disconnect();
    expect(singleton.getPool()).toBeNull();
    const pool = {};
    proof.resolve(candidate('one', pool));
    await expect(old).rejects.toThrow('fixed managed refusal');
    expect(closes).toBe(1);
    expect(singleton.getPool()).toBeNull();
  });

  test('late old success and failure cannot erase a newer committed generation', async () => {
    for (const lateFailure of [false, true]) {
      let closes = 0;
      const singleton = new ManagedPostgresSingleton<object>(managedError, async () => { closes++; });
      const oldProof = deferred<{ identity: string; pool: object }>();
      const old = singleton.connect('old', () => oldProof.promise);
      await singleton.disconnect();
      const freshPool = {};
      expect(await singleton.connect('new', async () => candidate('new', freshPool))).toBe(true);
      if (lateFailure) oldProof.reject(new Error('hostile secret')); else oldProof.resolve(candidate('old', {}));
      await expect(old).rejects.toThrow('fixed managed refusal');
      expect(singleton.getPool()).toBe(freshPool);
      expect(closes).toBe(lateFailure ? 0 : 1);
    }
  });

  test('identity mismatch closes candidate once and refuses publication', async () => {
    let closes = 0;
    const singleton = new ManagedPostgresSingleton<object>(managedError, async () => { closes++; });
    const pool = {};
    await expect(singleton.connect('expected', async () => candidate('other', pool))).rejects.toThrow('fixed managed refusal');
    expect(singleton.getPool()).toBeNull();
    expect(closes).toBe(1);
  });

  test('committed disconnect clears state before awaiting close and closes exactly once', async () => {
    let finish!: () => void;
    let closes = 0;
    const closeWait = new Promise<void>(resolve => { finish = resolve; });
    const singleton = new ManagedPostgresSingleton<object>(managedError, async () => { closes++; await closeWait; });
    const pool = {};
    await singleton.connect('one', async () => candidate('one', pool));
    const closing = singleton.disconnect();
    expect(singleton.getPool()).toBeNull();
    expect(singleton.isBusy()).toBe(false);
    expect(closes).toBe(1);
    finish();
    await closing;
    expect(closes).toBe(1);
  });
});
