import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';

const homes: string[] = [];
const saved = new Map<string, string | undefined>();
function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
afterEach(() => {
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  saved.clear();
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
});

describe('managed init CLI dispatch', () => {
  test('managed JSON reaches the coordinator refusal before ordinary init and emits one redacted object', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-init-cli-'));
    homes.push(home);
    setEnv('GBRAIN_HOME', home);
    setEnv('GBRAIN_DIRECT_DATABASE_URL', 'postgresql://user:secret@invalid/private');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...values: unknown[]) => { stdout.push(values.join(' ')); });
    const error = spyOn(console, 'error').mockImplementation((...values: unknown[]) => { stderr.push(values.join(' ')); });
    try {
      await runInit(['--managed-postgres', '--yes', '--json']);
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0]!)).toMatchObject({ status: 'error', reason: 'preflight_refused', stage: 'preflight' });
      expect(stdout.join(' ')).not.toMatch(/secret|invalid|private|postgresql:/);
      expect(stderr).toEqual([]);
      expect(currentExitCode()).toBe(1);
    } finally { log.mockRestore(); error.mockRestore(); }
  });

  test('help is side-effect free and documents managed boundaries', async () => {
    const stdout: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...values: unknown[]) => { stdout.push(values.join(' ')); });
    try {
      await runInit(['--managed-postgres', '--help']);
      const help = stdout.join('\n');
      expect(help).toContain('--managed-postgres');
      expect(help).toContain('database-only/keyless/deferred');
      expect(help).toContain('--package-plan-fingerprint <sha256>');
      expect(help).toContain('no login-start');
      expect(help).toContain('Requires a fresh engine');
      expect(currentExitCode()).toBe(0);
    } finally { log.mockRestore(); }
  });
});
