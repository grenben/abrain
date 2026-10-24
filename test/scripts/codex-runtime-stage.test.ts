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

  test('new protected directories stay traversable under umask 0077 without changing existing modes', () => {
    withFixture(directory => {
      // Simulate root ownership and redirect only the root directory descriptor.
      // Permission effects use real unprivileged files inside this fixture.
      const probe = String.raw`
import hashlib, importlib.util, json, os, pathlib, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('stage', sys.argv[1])
stage = importlib.util.module_from_spec(spec); spec.loader.exec_module(stage)
root = pathlib.Path(sys.argv[2]); os.chmod(root, 0o755)
existing = root / 'existing'; existing.mkdir(mode=0o700)
os.chmod(existing, 0o700)
runtime = root / 'codex'; runtime.write_bytes(b'synthetic runtime fixture')
os.chmod(runtime, 0o500)
stage.SHA256 = hashlib.sha256(runtime.read_bytes()).hexdigest()
real_open, real_fstat = os.open, os.fstat
def rooted_open(path, flags, *args, **kwargs):
    return real_open(root if str(path) == '/' else path, flags, *args, **kwargs)
def root_owned(fd):
    fields = list(real_fstat(fd)); fields[4] = 0
    return os.stat_result(fields)
old_mask = os.umask(0o077)
try:
    with patch.object(stage.os, 'open', rooted_open), patch.object(stage.os, 'fstat', root_owned):
        fd = stage.protected_directory(pathlib.Path('/created')); os.close(fd)
        refused = False
        try:
            fd = stage.protected_directory(pathlib.Path('/existing')); os.close(fd)
        except ValueError:
            refused = True
        runtime_refused = False
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            stage.verify_destination(fd)
        except ValueError:
            runtime_refused = True
        finally:
            os.close(fd)
finally:
    os.umask(old_mask)
print(json.dumps({'created_mode': (root / 'created').stat().st_mode & 0o777,
                  'existing_mode': existing.stat().st_mode & 0o777,
                  'existing_refused': refused, 'runtime_refused': runtime_refused,
                  'runtime_mode': runtime.stat().st_mode & 0o777}))
`;
      const result = spawnSync('python3', ['-I', '-c', probe, script, directory], { encoding: 'utf8', timeout: 5_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ created_mode: 0o755, existing_mode: 0o700,
        existing_refused: true, runtime_refused: true, runtime_mode: 0o500 });
    });
  });
});
