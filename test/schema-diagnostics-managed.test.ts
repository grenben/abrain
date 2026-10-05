import { describe, expect, it, spyOn } from 'bun:test';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { migrationNotice } from '../src/core/schema-migrations/helpers.ts';
import { v002 } from '../src/core/schema-migrations/v002-slugify-existing-pages.ts';
import { v179 } from '../src/core/schema-migrations/v179-persistence-request-sync-run-indexes.ts';
import { adaptManagedInitEngine } from '../src/commands/init-managed-postgres.ts';
import { managedSchemaDiagnosticSink } from '../src/core/schema-diagnostics.ts';
import { parseExpectedColumns, verifySchema } from '../src/core/schema-verify.ts';
import type { SchemaDiagnosticContext } from '../src/core/schema-diagnostics.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { setAuditEnabled } from '../src/core/connection-audit.ts';

const hostile = 'query=ALTER secret timestamp=2026-01-02T03:04Z url=postgresql://u:p@host/db path=/private/secret uuid=01234567-89ab-cdef-0123-456789abcdef';
const hostileIndex = 'index-private-uuid-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const hostileTable = 'table-private-path';

type ZombieCase = 'probe_failure' | 'active' | 'drop_success' | 'drop_failure';
function actualInitSchemaEngine(zombieCase: ZombieCase): { engine: PostgresEngine; drops: string[] } {
  const drops: string[] = [];
  const sql = Object.assign(
    async (_strings: TemplateStringsArray, ..._values: unknown[]) => [],
    {
      unsafe: async (query: string) => query.includes('pg_try_advisory_lock') ? [{ locked: true }] : [],
    },
  );
  const mutable: any = Object.create(PostgresEngine.prototype);
  mutable.kind = 'postgres';
  mutable._managedRuntime = { routingMode: 'instance' };
  mutable._sql = sql;
  mutable._connectionStyle = 'instance';
  mutable.connectionManager = null;
  mutable.applyForwardReferenceBootstrap = async () => {};
  mutable.getConfig = async (key: string) => key === 'version' ? String(LATEST_VERSION) : null;
  mutable.executeRaw = async (query: string) => {
    if (query.includes('ix.indisvalid = false')) {
      if (zombieCase === 'probe_failure') throw new Error(hostile);
      return [{ indexname: hostileIndex, tablename: hostileTable }];
    }
    if (query.includes('FROM pg_stat_activity')) {
      return zombieCase === 'active' ? [{ pid: 918273, query: hostile, application_name: hostile }] : [];
    }
    if (query.startsWith('DROP INDEX')) {
      drops.push(query);
      if (zombieCase === 'drop_failure') throw new Error(hostile);
      return [];
    }
    if (query.includes('SELECT EXISTS (SELECT 1 FROM information_schema.tables')) return [{ present: false }];
    return [];
  };
  return { engine: mutable as PostgresEngine, drops };
}

function migrationEngine(options: { failMigration?: boolean } = {}): BrainEngine {
  const engine = {
    kind: 'postgres',
    getConfig: async () => String(LATEST_VERSION - 2),
    setConfig: async () => {},
    executeRaw: async (sql: string) => {
      if (sql.includes('pg_stat_activity')) return [{ pid: 741, state: 'idle in transaction', query_start: hostile, query: hostile }];
      if (sql.includes('pg_index') || sql.includes('pg_class')) return [];
      return [];
    },
    transaction: async (fn: (engine: BrainEngine) => Promise<unknown>) => fn(engine),
    runMigration: async () => {
      if (options.failMigration) throw Object.assign(new Error(hostile), { code: '57014' });
    },
    withReservedConnection: async (fn: (conn: { executeRaw(sql: string): Promise<unknown[]> }) => Promise<unknown>) => fn({ executeRaw: async () => [] }),
  } as unknown as BrainEngine;
  return engine;
}

describe('managed schema diagnostic policy on real helpers', () => {
  it('actual PostgresEngine.initSchema routes each zombie-sweep outcome to fixed managed events only', async () => {
    const expected: Record<ZombieCase, string[]> = {
      probe_failure: ['Schema cleanup probe failed.\n'],
      active: ['Schema cleanup skipped an active index build.\n'],
      drop_success: ['Invalid schema index removed.\n', 'Schema cleanup completed.\n'],
      drop_failure: ['Invalid schema index could not be removed.\n'],
    };
    for (const outcome of Object.keys(expected) as ZombieCase[]) {
      const { engine, drops } = actualInitSchemaEngine(outcome);
      const events: string[] = [];
      const context = managedSchemaDiagnosticSink(line => events.push(line));
      const stdout = spyOn(console, 'log').mockImplementation(() => {});
      const consoleWarn = spyOn(console, 'warn').mockImplementation(() => {});
      const consoleError = spyOn(console, 'error').mockImplementation(() => {});
      const stdoutStream = spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderrStream = spyOn(process.stderr, 'write').mockImplementation(() => true);
      setAuditEnabled(false);
      try {
        await engine.initSchema(context);
        expect(events).toEqual(expected[outcome]);
        expect(events.join(' ')).not.toMatch(/index-private|table-private|918273|query=|timestamp=|postgresql:|private|01234567|aaaaaaaa/);
        expect([stdout.mock.calls, consoleWarn.mock.calls, consoleError.mock.calls, stdoutStream.mock.calls, stderrStream.mock.calls].flat()).toEqual([]);
        expect(drops).toHaveLength(outcome === 'active' || outcome === 'probe_failure' ? 0 : 1);
      } finally {
        setAuditEnabled(true);
        stdout.mockRestore(); consoleWarn.mockRestore(); consoleError.mockRestore();
        stdoutStream.mockRestore(); stderrStream.mockRestore();
      }
    }
  });

  it('production adapter forwards managed context into real verifier and stderr sink', async () => {
    const events: string[] = [];
    const expected = parseExpectedColumns().filter(column => column.table === 'pages' && column.column !== 'content_hash');
    let forwarded = false;
    const engine = {
      connect: async () => {}, disconnect: async () => {},
      initSchema: async (context?: SchemaDiagnosticContext) => {
        forwarded = context?.managedSafe === true;
        const verifyEngine = {
          executeRaw: async (sql: string) => sql.includes('information_schema.tables')
            ? [{ table_name: 'pages' }]
            : expected.map(column => ({ table_name: 'pages', column_name: column.column })),
          runMigration: async () => {},
        } as unknown as BrainEngine;
        await verifySchema(verifyEngine, context);
      },
    } as unknown as BrainEngine;
    const adapter = adaptManagedInitEngine(engine);
    await adapter.initSchema(managedSchemaDiagnosticSink(line => events.push(line)));
    expect(forwarded).toBe(true);
    expect(events).toEqual(['Schema self-heal started.\n', 'Schema self-heal completed.\n']);
  });

  it('masks hostile blocker rows while preserving migration execution', async () => {
    const events: string[] = [];
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const result = await runMigrations(migrationEngine(), { managedSafe: true, emit: event => events.push(event) });
      expect(result.applied).toBe(2);
      expect(events).toContain('migration_warning');
      expect(events.every(event => /^[a-z_]+$/.test(event))).toBe(true);
      expect(String(stderr.mock.calls) + String(stdout.mock.calls) + String(warn.mock.calls) + String(error.mock.calls) + events.join(' ')).not.toContain(hostile);
      expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { stderr.mockRestore(); stdout.mockRestore(); warn.mockRestore(); error.mockRestore(); }
  });

  it('routes v179 build-index notices through migrationNotice only when an index needs building', async () => {
    const events: string[] = [];
    const context = { managedSafe: true, emit: (event: string) => events.push(event) };
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const builds: string[] = [];
    const engine = {
      kind: 'postgres',
      executeRaw: async (sql: string) => {
        if (sql.includes('SELECT indisvalid AS valid FROM pg_index')) return [{ valid: true }];
        if (sql.includes('pg_index')) return [];
        if (sql.includes('pg_class')) return [{ rows: 10 }];
        throw new Error(`unexpected query ${sql}`);
      },
      withReservedConnection: async (fn: (conn: { executeRaw(sql: string): Promise<unknown[]> }) => Promise<unknown>) => fn({
        executeRaw: async sql => { builds.push(sql); return []; },
      }),
    } as unknown as BrainEngine;
    try {
      await v179.handler!(engine, context);
      expect(builds).toHaveLength(2);
      expect(events).toEqual(['migration_notice', 'migration_notice']);
      expect(String(stderr.mock.calls) + String(stdout.mock.calls) + events.join(' ')).not.toMatch(/persistence_requests|rows|private|postgresql:|01234567/);
    } finally { stderr.mockRestore(); stdout.mockRestore(); }
  });

  it('propagates hostile statement-timeout failure without writing its details', async () => {
    const oldBackoff = process.env.GBRAIN_MIGRATE_BACKOFF_MS;
    process.env.GBRAIN_MIGRATE_BACKOFF_MS = '0';
    const events: string[] = [];
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      let failure: unknown;
      try { await runMigrations(migrationEngine({ failMigration: true }), { managedSafe: true, emit: event => events.push(event) }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(hostile);
      expect(events).toContain('migration_warning');
      expect((String(stderr.mock.calls) + String(stdout.mock.calls) + String(warn.mock.calls) + String(consoleError.mock.calls) + events.join(' '))).not.toContain(hostile);
      expect(warn).not.toHaveBeenCalled(); expect(consoleError).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore(); stdout.mockRestore(); warn.mockRestore(); consoleError.mockRestore();
      if (oldBackoff === undefined) delete process.env.GBRAIN_MIGRATE_BACKOFF_MS; else process.env.GBRAIN_MIGRATE_BACKOFF_MS = oldBackoff;
    }
  });

  it('routes a real v002 handler and migrationNotice to fixed managed events', async () => {
    const events: string[] = [];
    const context = { managedSafe: true, emit: (event: string) => events.push(event) };
    const error = new Error(hostile);
    const log = spyOn(console, 'error').mockImplementation(() => {});
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await v002.handler!({
        listPages: async () => [{ slug: '/private/Secret Name.md' }],
        updateSlug: async () => { throw error; },
      } as unknown as BrainEngine, context);
      migrationNotice(hostile, context);
      expect(events).toEqual(['migration_warning', 'migration_notice']);
      expect(log).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(events.join(' ')).not.toContain(hostile);
    } finally { log.mockRestore(); stderr.mockRestore(); }
  });
});
