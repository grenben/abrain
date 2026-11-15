import { describe, expect, test } from 'bun:test';
import { withInitSchemaConnection } from '../src/core/db.ts';
import type postgres from '#postgres';

function fakePool(
  unsafe: (sql: string) => Promise<Array<Record<string, unknown>>>,
) {
  const calls: string[] = [];
  let releases = 0;
  const connection = {
    unsafe: async (sql: string) => {
      calls.push(sql);
      return unsafe(sql);
    },
    release: () => { releases += 1; },
  };
  const pool = { reserve: async () => connection } as unknown as ReturnType<typeof postgres>;
  return { pool, calls, get releases() { return releases; }, connection };
}

describe('standalone initSchema connection lock', () => {
  test('uses one reserved connection for lock acquisition, schema work, and unlock', async () => {
    const fake = fakePool(async (sql) =>
      sql.includes('pg_try_advisory_lock') ? [{ locked: true }] : []);
    let workConnection: unknown;

    await withInitSchemaConnection(fake.pool, async (conn) => {
      workConnection = conn;
      await conn.unsafe('SCHEMA WORK');
    });

    expect(workConnection).toBe(fake.connection);
    expect(fake.calls[0]).toContain('pg_try_advisory_lock(42)');
    expect(fake.calls).toContain('SCHEMA WORK');
    expect(fake.calls.at(-1)).toContain('pg_advisory_unlock(42)');
    expect(fake.releases).toBe(1);
  });

  test('bounds lock waiting and releases the reservation when acquisition times out', async () => {
    const fake = fakePool(async (sql) =>
      sql.includes('pg_try_advisory_lock') ? [{ locked: false }] : [{ pid: 123 }]);
    let now = 0;

    await expect(withInitSchemaConnection(fake.pool, async () => {
      throw new Error('schema work must not run');
    }, {
      timeoutMs: 20,
      pollMs: 10,
      heartbeatMs: 1_000,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    })).rejects.toThrow('timed out');

    expect(fake.calls.filter((sql) => sql.includes('pg_try_advisory_lock'))).toHaveLength(3);
    expect(fake.calls.some((sql) => sql.includes('pg_advisory_unlock'))).toBe(false);
    expect(fake.releases).toBe(1);
  });

  test('unlocks and releases when bootstrap/schema work fails', async () => {
    const fake = fakePool(async (sql) =>
      sql.includes('pg_try_advisory_lock') ? [{ locked: true }] : []);

    await expect(withInitSchemaConnection(fake.pool, async () => {
      throw new Error('schema failed');
    })).rejects.toThrow('schema failed');

    expect(fake.calls.at(-1)).toContain('pg_advisory_unlock(42)');
    expect(fake.releases).toBe(1);
  });
});
