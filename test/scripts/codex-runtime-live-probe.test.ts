/**
 * Live acceptance must refuse mutable or unrelated executables before dispatch.
 * A synthetic executable records launch and returns a valid transport response;
 * the original probe executed it and reported success despite unprotected bytes.
 * These real CLI refusals use empty credential-free homes. They do not qualify
 * the privileged runtime or make a model call. Production transport contracts
 * cannot cover a standalone operator script that bypasses their admission path.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const probe = resolve(import.meta.dir, '../../scripts/codex-runtime-live-synthetic-probe.ts');
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

function withFixture(check: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'codex-live-admission-'));
  try { check(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function run(root: string, bin: string) {
  return spawnSync(process.execPath, [probe, '--live', bin, 'synthetic-model'], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: root, GBRAIN_HOME: root, TMPDIR: root },
  });
}

describe.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)('live Codex probe admission', () => {
  test('refuses a user-owned executable before it can run, even if it would return valid JSON', () => {
    withFixture(root => {
      const bin = join(root, 'candidate');
      const marker = join(root, 'executed');
      const answer = JSON.stringify({ evidence_hash: 'synthetic-hash', synopsis: 'A red cube.',
        source_quote: 'The cube is red.', image_note: 'A synthetic pixel.' });
      const events = [
        { type: 'thread.started', thread_id: 'synthetic' }, { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: answer } },
        { type: 'turn.completed' },
      ].map(event => JSON.stringify(event));
      writeFileSync(bin, `#!/bin/sh
touch ${quote(marker)}
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output-last-message ]; then shift; answer_path=$1; fi
  shift
done
printf '%s\\n' ${quote(answer)} > "$answer_path"
printf '%s\\n' ${events.map(quote).join(' ')}
`);
      chmodSync(bin, 0o755);
      const result = run(root, bin);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('mutable Codex executable');
      expect(existsSync(marker)).toBe(false);
    });
  });

  test('refuses an unrelated root-owned executable by digest before launching it', () => {
    withFixture(root => {
      const result = run(root, '/usr/bin/true');
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('runtime digest differs from inspected build');
    });
  });

  test('refuses a candidate symlink instead of following it', () => {
    withFixture(root => {
      const bin = join(root, 'candidate');
      symlinkSync('/usr/bin/true', bin);
      const result = run(root, bin);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ELOOP');
    });
  });
});
