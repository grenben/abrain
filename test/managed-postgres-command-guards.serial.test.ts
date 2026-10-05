import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { ManagedPostgresUnsupportedError, MANAGED_POSTGRES_UNSUPPORTED_MESSAGE } from '../src/core/managed-postgres-unsupported.ts';
import { runConfig, tryRunConfigEngineFree } from '../src/commands/config.ts';
import { runInit } from '../src/commands/init.ts';
import { runPreferPostgresLadder } from '../src/commands/init-prefer-postgres.ts';
import { runReinitPglite } from '../src/commands/reinit-pglite.ts';
import { runDbRepair, type DbRepairDeps } from '../src/commands/db-repair.ts';
import { runEngineStatus } from '../src/commands/engine-status.ts';
import { validateInitFlags } from '../src/commands/init-flags.ts';

const managed = {
  engine: 'postgres' as const,
  managed_postgres: {
    manager_id: 'gbrain-managed-postgres' as const,
    cluster_id: '01234567-89ab-cdef-0123-456789abcdef',
  },
  memory: { auto_writeback: 'off' },
};

let home: string;
let oldHome: string | undefined;
let oldGbrainUrl: string | undefined;
let oldDatabaseUrl: string | undefined;
let oldCwd: string;

beforeEach(() => {
  oldHome = process.env.GBRAIN_HOME;
  oldGbrainUrl = process.env.GBRAIN_DATABASE_URL;
  oldDatabaseUrl = process.env.DATABASE_URL;
  oldCwd = process.cwd();
  home = mkdtempSync(join(tmpdir(), 'gbrain-managed-command-'));
  process.env.GBRAIN_HOME = home;
  delete process.env.GBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(managed, null, 2) + '\n');
});

afterEach(() => {
  process.chdir(oldCwd);
  for (const [key, value] of [
    ['GBRAIN_HOME', oldHome], ['GBRAIN_DATABASE_URL', oldGbrainUrl], ['DATABASE_URL', oldDatabaseUrl],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function configPath(): string { return join(home, '.gbrain', 'config.json'); }
function bytes(): string { return readFileSync(configPath(), 'utf8'); }

async function expectManagedRefusal(fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error('expected managed-target refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedPostgresUnsupportedError);
    const e = error as ManagedPostgresUnsupportedError;
    expect(e.code).toBe('managed_postgres_unsupported');
    expect(e.message).toBe(MANAGED_POSTGRES_UNSUPPORTED_MESSAGE);
    expect(e.message).not.toContain(managed.managed_postgres.cluster_id);
    expect(e.message).not.toContain(home);
  }
}

describe('managed-target command refusals', () => {
  test('exported init flag validator refuses target changes but permits help and migrate-only', () => {
    expect(() => validateInitFlags(['--pglite'], managed)).toThrow(ManagedPostgresUnsupportedError);
    expect(() => validateInitFlags(['--force', '--url', 'postgresql://host.invalid/db'], managed)).toThrow(ManagedPostgresUnsupportedError);
    expect(() => validateInitFlags(['--mcp-only'], managed)).toThrow(ManagedPostgresUnsupportedError);
    expect(() => validateInitFlags(['--migrate-only'], managed)).not.toThrow();
    expect(() => validateInitFlags(['--help'], managed)).not.toThrow();
    expect(() => validateInitFlags(['--migrate-only', '--url', 'postgresql://host.invalid/db'], managed)).not.toThrow();
  });

  test('init flag syntax errors take precedence over managed-target refusal', () => {
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => validateInitFlags(['--unknown-target-mode'], managed)).toThrow('exit:1');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  test('config target writes, unsets and matching patterns refuse before engine calls or writes', async () => {
    const before = bytes();
    let engineCalls = 0;
    const engine = {
      getConfig: async () => { engineCalls++; return null; },
      setConfig: async () => { engineCalls++; },
      unsetConfig: async () => { engineCalls++; return 1; },
      listConfigKeys: async () => { engineCalls++; return []; },
    } as unknown as BrainEngine;

    for (const args of [
      ['set', 'database_url', 'postgresql://user:secret@host.invalid/db'],
      ['set', 'database_path', '/private/new-brain'],
      ['set', 'managed_postgres', 'replacement'],
      ['set', 'remote_mcp.mcp_url', 'https://host.invalid/mcp'],
      ['set', 'thin_client_url', 'https://host.invalid'],
      ['set', '--force', 'database_url', 'postgresql://user:secret@host.invalid/db'],
      ['set', '--coverage-override', 'managed_postgres', 'replacement'],
      ['set', 'remote_mcp.mcp_url', 'https://host.invalid/mcp', '--yes'],
      ['unset', 'database_url'],
      ['unset', 'managed_postgres'],
      ['unset', '--pattern', 'database_'],
      ['unset', '--pattern', 'remote_mcp.'],
      ['unset', '--yes', 'database_url'],
      ['unset', '--pattern', '--force', 'database_'],
      ['unset', '--yes', '--pattern', 'remote_mcp.'],
    ]) {
      await expectManagedRefusal(() => tryRunConfigEngineFree(args));
      await expectManagedRefusal(() => runConfig(engine, args));
      expect(engineCalls).toBe(0);
      expect(bytes()).toBe(before);
    }
  });

  test('unrelated file-plane config mutation preserves managed reference', async () => {
    const engine = { setConfig: async () => { throw new Error('DB write must not run'); } } as unknown as BrainEngine;
    await runConfig(engine, ['set', '--yes', 'backup.check_enabled', 'true']);
    await runConfig(engine, ['set', 'backup.check_enabled', 'false', '--force']);
    const after = JSON.parse(bytes());
    expect(after.managed_postgres).toEqual(managed.managed_postgres);
    expect(after.backup.check_enabled).toBe(false);
  });

  test('writer-lock refusal finds keys and patterns after supported leading flags', async () => {
    writeFileSync(configPath(), JSON.stringify({ engine: 'pglite' }));
    let exits = 0;
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits++;
      throw new Error(`exit:${code}`);
    }) as never);
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const engine = { setConfig: async () => { throw new Error('unexpected DB write'); } } as unknown as BrainEngine;
    try {
      for (const args of [
        ['set', '--force', 'persistence.writer_admin_lock', 'false'],
        ['unset', '--pattern', '--yes', 'persistence.writer_'],
      ]) {
        try { await runConfig(engine, args); } catch (failure) {
          expect((failure as Error).message).toBe('exit:1');
        }
      }
      expect(exits).toBe(2);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  test('init variants, including force and thin-client init, refuse before side effects', async () => {
    const before = bytes();
    await expectManagedRefusal(() => runInit(['--pglite', '--non-interactive']));
    await expectManagedRefusal(() => runInit(['--force', '--url', 'postgresql://user:secret@host.invalid/db']));
    await expectManagedRefusal(() => runInit(['--mcp-only']));
    await expectManagedRefusal(() => runInit(['--prefer-postgres', '--non-interactive']));
    await expectManagedRefusal(() => runPreferPostgresLadder({
      jsonOutput: false, apiKey: null, customPath: null, aiOpts: {}, schemaPack: 'gbrain-base-v2',
      skipEmbedCheck: true, allowDocker: true, allowCreateDb: true, localPostgres: true,
    }));
    expect(bytes()).toBe(before);
  });

  test('reinit and db-repair refuse before backup, prompt, probes, receipts, or rewrite', async () => {
    const before = bytes();
    await expectManagedRefusal(() => runReinitPglite(['--yes', '--no-sync', '--path', '/private/brain']));
    let sideEffects = 0;
    const deps: DbRepairDeps = {
      probeAccess: async () => { sideEffects++; return null; },
      probeSchema: async () => { sideEffects++; return null; },
      withEngine: async (_cfg, fn) => { sideEffects++; throw new Error('not expected'); },
      docker: {
        available: () => { sideEffects++; return true; }, state: () => 'running', start: () => { sideEffects++; return true; },
      },
      sleep: async () => { sideEffects++; }, now: () => Date.now(),
    };
    await expectManagedRefusal(() => runDbRepair(['--yes', '--apply-rewrites', '--force'], deps));
    expect(sideEffects).toBe(0);
    expect(bytes()).toBe(before);
  });

  test('engine status refuses managed probes and only classifies configured state without probing', async () => {
    const before = bytes();
    await expectManagedRefusal(() => runEngineStatus(['status', '--probe']));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runEngineStatus(['status', '--json'])).toBe(0);
      const report = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(report.effective_engine).toBe('postgres');
      expect(report.database_url).toBeNull();
      expect(report.probe).toBeUndefined();
      expect(JSON.stringify(report)).not.toContain(managed.managed_postgres.cluster_id);
    } finally { log.mockRestore(); }
    expect(bytes()).toBe(before);
  });
});
