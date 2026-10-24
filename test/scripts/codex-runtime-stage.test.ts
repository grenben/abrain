/**
 * Protect the operator staging script's read-only checks and source admission.
 * Regressions: accept arbitrary bytes, follow a source symlink, or hang on a FIFO.
 * Runtime proposal tests do not exercise this privileged copy preparation.
 * Uses real files/processes with no production seam; privileged staging is an
 * operator acceptance step, not established by these unprivileged contracts.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve(import.meta.dir, '../../scripts/codex-runtime-stage.py');

function withFixture(check: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'codex-stage-test-'));
  try { check(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function run(args: string[]) {
  return spawnSync('python3', ['-I', script, ...args], { encoding: 'utf8', timeout: 5_000 });
}

describe.skipIf(process.platform !== 'linux')('protected Codex runtime staging admission', () => {
  test('documents the default read-only operation and explicit stage switch', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Default operation is read-only');
    expect(result.stdout).toContain('--stage');
  });

  test('refuses an unexpected source digest without changing source or creating files', () => {
    withFixture(directory => {
      const source = join(directory, 'candidate');
      writeFileSync(source, 'synthetic non-runtime bytes');
      const result = run(['--source', source]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'refused', activated: false });
      expect(JSON.parse(result.stdout).error).toContain('source digest differs');
      expect(readdirSync(directory)).toEqual(['candidate']);
      expect(readFileSync(source, 'utf8')).toBe('synthetic non-runtime bytes');
    });
  });

  test('refuses relative source paths before opening them', () => {
    const result = run(['--source', 'candidate']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('source must be absolute');
  });

  test('refuses a source symlink instead of following it', () => {
    withFixture(directory => {
      writeFileSync(join(directory, 'bytes'), 'synthetic bytes');
      symlinkSync('bytes', join(directory, 'candidate'));
      const result = run(['--source', join(directory, 'candidate')]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error).not.toContain('source digest differs');
      expect(readdirSync(directory).sort()).toEqual(['bytes', 'candidate']);
    });
  });

  test('refuses a FIFO without blocking for a writer', () => {
    withFixture(directory => {
      const source = join(directory, 'pipe');
      const made = spawnSync('python3', ['-I', '-c', 'import os,sys; os.mkfifo(sys.argv[1])', source]);
      expect(made.status).toBe(0);
      const result = run(['--source', source]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error).toContain('bounded regular file');
    });
  });
});
