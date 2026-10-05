import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string, timeoutMs: number): Promise<void> {
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${expected}`)), remaining)),
    ]);
    if (next.done) throw new Error(`child exited before ${expected}: ${text}`);
    text += new TextDecoder().decode(next.value);
    if (text.includes(expected)) return;
  }
  throw new Error(`timed out waiting for ${expected}: ${text}`);
}

describe('managed init shutdown settlement', () => {
  test('actual SIGTERM handler waits for the registered managed coordinator promise', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'init-managed-postgres-shutdown-child.ts')], {
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const reader = child.stdout.getReader();
    let exited = false;
    const exit = child.exited.finally(() => { exited = true; });
    try {
      await readUntil(reader, 'READY', 5_000);
      child.kill('SIGTERM');
      await readUntil(reader, 'ABORT_OBSERVED', 5_000);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(exited).toBe(false);
      child.stdin.write('release\n');
      child.stdin.end();
      await readUntil(reader, 'COORDINATOR_SETTLED', 5_000);
      await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('child did not exit after settlement')), 5_000))]);
      expect(await exit).toBe(143);
    } finally {
      if (!exited) child.kill('SIGKILL');
      await exit;
      reader.releaseLock();
    }
  });
});
