import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';

const FIXED = 'Managed PostgreSQL init preflight refused; no changes were made.';

async function runManaged(args: string[], home: string): Promise<{ logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const oldHome = process.env.GBRAIN_HOME;
  const oldDirectUrl = process.env.GBRAIN_DIRECT_DATABASE_URL;
  process.env.GBRAIN_HOME = home;
  process.env.GBRAIN_DIRECT_DATABASE_URL = 'postgresql://user:SECRET@invalid/private';
  const log = spyOn(console, 'log').mockImplementation((...values: unknown[]) => { logs.push(values.join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...values: unknown[]) => { errors.push(values.join(' ')); });
  try { await expect(runInit(args)).resolves.toBeUndefined(); }
  finally {
    log.mockRestore(); error.mockRestore();
    if (oldHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = oldHome;
    if (oldDirectUrl === undefined) delete process.env.GBRAIN_DIRECT_DATABASE_URL;
    else process.env.GBRAIN_DIRECT_DATABASE_URL = oldDirectUrl;
    _resetCliExitVerdictForTests();
    process.exitCode = 0;
  }
  return { logs, errors };
}

describe('managed init immediate CLI boundary', () => {
  test('interactive and explicit noninteractive/JSON lanes stop before ordinary init', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'gbrain-init-boundary-'));
    const home = join(temp, 'home');
    try {
      const before = readdirSync(temp);
      const interactive = await runManaged(['--managed-postgres'], home);
      expect(interactive.errors).toEqual([FIXED]);
      expect(interactive.logs).toEqual([]);
      const noninteractive = await runManaged(['--managed-postgres', '--yes', '--non-interactive'], home);
      expect(noninteractive.errors).toEqual([FIXED]);
      expect(noninteractive.logs).toEqual([]);
      const json = await runManaged(['--managed-postgres', '--yes', '--json'], home);
      expect(json.errors).toEqual([]);
      expect(json.logs).toEqual([JSON.stringify({ status: 'error', reason: 'preflight_refused', stage: 'preflight', message: FIXED })]);
      expect(existsSync(home)).toBe(false);
      expect(readdirSync(temp)).toEqual(before);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  test('help remains an early non-exiting lane', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    try {
      await expect(runInit(['--help', '--managed-postgres'])).resolves.toBeUndefined();
      expect(exit).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); error.mockRestore(); exit.mockRestore(); }
  });
});
