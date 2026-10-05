import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';
import { findCliCommand } from '../src/cli/command-table.ts';
import { runPreConnectGuard } from '../src/cli/pre-connect-guard.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { loadSupportedMigrationSourceConfig } from '../src/commands/migrate-engine.ts';

const managedId = '01234567-89ab-cdef-0123-456789abcdef';
const homes: string[] = [];
function configHome(config: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-migrate-source-'));
  homes.push(home);
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
  return home;
}

afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

async function dispatchMigrateWithStub(args: string[]): Promise<string> {
  const record = findCliCommand('migrate')!;
  const engine = new Proxy({} as BrainEngine, {
    get: (_target, property) => {
      if (property === 'getConfig') return async () => null;
      if (property === 'getHealth') return async () => ({ missing_embeddings: 0 });
      if (property === 'countChunklessPagesWithContent') return async () => 0;
      if (property === 'executeRaw') return async () => [];
      return undefined;
    },
  });
  const output: string[] = [];
  const oldLog = console.log;
  const oldExit = process.exit;
  const oldWrite = process.stdout.write;
  const exit = Symbol('stub exit');
  console.log = (...values: unknown[]) => output.push(values.join(' '));
  process.exit = ((code?: number) => { if (code === 0) throw exit; throw new Error(`unexpected exit ${code}`); }) as never;
  process.stdout.write = ((chunk: string | Uint8Array) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    runPreConnectGuard(record.preConnectGuard, args);
    const module = await record.load() as { run(engine: BrainEngine, args: string[], ctx: never): Promise<void> };
    try { await module.run(engine, args, {} as never); }
    catch (error) { if (error !== exit) throw error; }
  } finally {
    console.log = oldLog;
    process.exit = oldExit;
    process.stdout.write = oldWrite;
  }
  return output.join('\n');
}

describe('migrate engine pre-connect source guard', () => {
  test('durable managed file target is refused despite an environment URL override', async () => {
    expect(findCliCommand('migrate')).toMatchObject({ phase: 'post-connect', preConnectGuard: 'migrate-source' });
    const home = configHome({ engine: 'postgres', managed_postgres: {
      manager_id: 'gbrain-managed-postgres', cluster_id: managedId,
    } });
    const configPath = join(home, '.gbrain', 'config.json');
    const originalConfig = readFileSync(configPath, 'utf8');
    await withEnv({ GBRAIN_HOME: home, GBRAIN_DATABASE_URL: 'postgresql://user:SECRET@override.invalid/db', DATABASE_URL: undefined }, async () => {
      expect(() => runPreConnectGuard(findCliCommand('migrate')?.preConnectGuard, ['--to', 'pglite']))
        .toThrow(/Managed PostgreSQL references are not supported/);
      const result = spawnSync('bun', ['src/cli.ts', 'migrate', '--to', 'pglite'], {
        cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status).not.toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('Managed PostgreSQL references are not supported');
      expect(output).not.toContain('SECRET');
      expect(output).not.toContain(managedId);
      expect(output).not.toContain('Connecting to target');
      expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
      expect(readdirSync(join(home, '.gbrain'))).toEqual(['config.json']);
      expect(existsSync(join(home, '.gbrain', 'migrate-manifest.json'))).toBe(false);
    });
  });

  test('managed config bypasses engine-source refusal for the embedding status and help lanes', async () => {
    const home = configHome({ engine: 'postgres', managed_postgres: {
      manager_id: 'gbrain-managed-postgres', cluster_id: managedId,
    } });
    await withEnv({ GBRAIN_HOME: home, GBRAIN_DATABASE_URL: 'postgresql://user:SECRET@override.invalid/db', DATABASE_URL: undefined }, async () => {
      const status = await dispatchMigrateWithStub(['embeddings', '--status', '--json']);
      expect(JSON.parse(status).status).toBe('status');
      const help = await dispatchMigrateWithStub(['embeddings', '--help']);
      expect(help).toContain('gbrain migrate embeddings --status --json');
    });
  });

  test('ordinary URL and PGLite configs pass the same pre-connect guard', async () => {
    const command = findCliCommand('migrate');
    expect(command?.phase).toBe('post-connect');
    expect(command?.load.toString()).toContain('./commands/migrate.ts');
    for (const config of [
      { engine: 'postgres', database_url: 'postgresql://ordinary.invalid/db' },
      { engine: 'pglite', database_path: '/tmp/brain.pglite' },
    ]) {
      const home = configHome(config);
      await withEnv({ GBRAIN_HOME: home, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, async () => {
        expect(() => runPreConnectGuard(command?.preConnectGuard, ['--to', 'pglite'])).not.toThrow();
      });
    }
  });

  test('effective Postgres env source wins over a durable PGLite source for engine conversion', async () => {
    const home = configHome({ engine: 'pglite', database_path: '/tmp/durable-brain.pglite' });
    await withEnv({ GBRAIN_HOME: home, GBRAIN_DATABASE_URL: 'postgresql://selected.invalid/db', DATABASE_URL: undefined }, async () => {
      const source = loadSupportedMigrationSourceConfig();
      expect(source?.engine).toBe('postgres');
      expect(source?.database_url).toBe('postgresql://selected.invalid/db');
      expect(source?.engine).not.toBe('pglite');
    });
  });
});
