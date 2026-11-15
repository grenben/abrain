/**
 * PostgreSQL-only lock regression for v306. Keep this in a separate test file
 * from the PGLite full-upgrade test: the backend matrix runs this path against
 * direct PostgreSQL and transaction-mode PgBouncer, without loading or running
 * PGLite. Restricting the registry to v306 means later migrations are not
 * implicitly required to be lock-free under a ROW EXCLUSIVE lock on facts.
 */
import { describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../../src/core/migrate.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { probeDatabase } from '../helpers/schema-lock-probe.ts';
import { withEnv } from '../helpers/with-env.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const GUARDS = ['gbrain_guard_inserted_facts', 'gbrain_preserve_fact_withdrawal'];
const migration = MIGRATIONS.find(m => m.name === 'member_page_withdrawal_scope')!;

async function windBack(engine: BrainEngine): Promise<void> {
  await engine.executeRaw('CREATE OR REPLACE FUNCTION gbrain_preserve_fact_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$');
  await engine.executeRaw('CREATE OR REPLACE FUNCTION gbrain_guard_inserted_facts() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NULL; END $fn$');
  await engine.setConfig('version', String(migration.version - 1));
}

async function bounded<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const settled = (results: PromiseSettledResult<unknown>[]) =>
  results.map(r => r.status === 'fulfilled' ? 'ok' : (r.reason as Error).message);

/**
 * runMigrations is the behavior under test, but would normally continue through
 * every migration after v306. Temporarily expose only v306 to its normal runner;
 * restore the live registry even if either runner fails.
 */
async function withOnlyV306<T>(work: () => Promise<T>): Promise<T> {
  const allMigrations = [...MIGRATIONS];
  MIGRATIONS.splice(0, MIGRATIONS.length, migration);
  try {
    return await work();
  } finally {
    MIGRATIONS.splice(0, MIGRATIONS.length, ...allMigrations);
  }
}

describe.skipIf(!DATABASE_URL)(`member_page_withdrawal_scope v306 under two runners [${process.env.GBRAIN_TEST_BACKEND ?? 'postgres'}] (PostgreSQL E2E)`, () => {
  test('two runners finish while another connection holds ROW EXCLUSIVE on facts', async () => {
    expect(migration.version).toBe(306);
    expect(migration.version).toBeLessThanOrEqual(LATEST_VERSION);
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    const db = await probeDatabase(DATABASE_URL!);
    const a = new PostgresEngine();
    const b = new PostgresEngine();
    const holder = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await a.connect({ database_url: db.url, poolSize: 4 });
      await b.connect({ database_url: db.url, poolSize: 4 });
      await windBack(a);
      await withOnlyV306(async () => {
        const results = await holder.begin(async sql => {
          await sql`LOCK TABLE facts IN ROW EXCLUSIVE MODE`;
          return withEnv({ GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS: '90' }, () =>
            bounded('both v306 runners', 60_000, Promise.allSettled([runMigrations(a), runMigrations(b)])));
        });
        expect(settled(results)).toEqual(['ok', 'ok']);
      });
      expect(await a.getConfig('version')).toBe(String(migration.version));
      const rows = await a.executeRaw<{ proname: string; member_rule: boolean }>(
        "SELECT proname, position('memory/members/' in prosrc) > 0 AS member_rule FROM pg_proc WHERE proname = ANY($1::text[]) ORDER BY proname",
        [GUARDS],
      );
      expect(rows).toEqual(GUARDS.map(proname => ({ proname, member_rule: true })));
    } finally {
      await holder.end();
      await a.disconnect();
      await b.disconnect();
      await db.drop();
    }
  }, 240_000);
});
