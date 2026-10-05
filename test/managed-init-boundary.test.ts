import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.ts';

const FIXED = 'Managed PostgreSQL init is not available yet; no changes were made.';

async function runManaged(args: string[], home: string): Promise<{ logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const oldHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = home;
  const log = spyOn(console, 'log').mockImplementation((...values: unknown[]) => { logs.push(values.join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...values: unknown[]) => { errors.push(values.join(' ')); });
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
  try { await expect(runInit(args)).rejects.toThrow('exit:1'); }
  finally {
    log.mockRestore(); error.mockRestore(); exit.mockRestore();
    if (oldHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = oldHome;
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
      expect(json.logs).toEqual([JSON.stringify({ status: 'error', reason: 'managed_init_unavailable', message: FIXED })]);
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
