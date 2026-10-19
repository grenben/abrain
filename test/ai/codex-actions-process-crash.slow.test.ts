import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function verifyCrashRecovery(writeMode: boolean): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-codex-action-kill-'));
  const home = join(root, 'home');
  const bin = join(root, 'fake-codex.mjs');
  const calls = join(root, 'calls.jsonl');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(calls, '');
  const script = `#!${Bun.which('node')}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
readFileSync(0, 'utf8');
const count = readFileSync(${JSON.stringify(calls)}, 'utf8').split('\\n').filter(Boolean).length;
const response = count === 0
  ? { kind: 'tool', name: 'brain_get_page', arguments: { slug: 'notes/one' } }
  : ${writeMode ? `count === 1
    ? { kind: 'tool', name: 'brain_put_page', arguments: { slug: 'notes/new', content: '---\\ntitle: Reviewed evidence\\ntype: note\\n---\\n\\n## Summary\\n\\nThe synthetic evidence supports careful review.\\n' } }
    : ` : ''}{ kind: 'final', answer: 'The synthetic note says to check evidence.' };
const text = JSON.stringify({ response });
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ count }) + '\\n');
writeFileSync(arg('--output-last-message'), text);
for (const event of [
  { type: 'thread.started', thread_id: 'fixture' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text } },
  { type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 2, output_tokens: 15 } },
]) console.log(JSON.stringify(event));
`;
  writeFileSync(bin, script, { mode: 0o700 });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ private_codex: { mode: 'strict', model: 'codex-cli:gpt-test', bin } }));
  const env = { ...process.env, HOME: home, GBRAIN_HOME: home, CODEX_HOME: home, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' };
  const helper = join(import.meta.dir, '../helpers/codex-actions-process-crash.ts');
  const launch = (mode: string) => Bun.spawn([process.execPath, helper, mode + (writeMode ? '-write' : ''), root, createHash('sha256').update(script).digest('hex')],
    { env, stdout: 'pipe', stderr: 'pipe' });
  try {
    const seed = launch('seed');
    const seeded = await new Response(seed.stderr).text();
    expect(await seed.exited, seeded).toBe(0);

    const child = launch('crash');
    const stderr = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    try {
      while (!output.includes('ACTION_RETAINED')) {
        const next = await reader.read();
        if (next.done) break;
        output += new TextDecoder().decode(next.value);
      }
      if (!output.includes('ACTION_RETAINED')) throw new Error(`Crash child exited before retention: ${await stderr}`);
      child.kill('SIGKILL');
      expect(await child.exited).toBe(137);
      expect(child.signalCode).toBe('SIGKILL');
    } finally { clearTimeout(timer); child.kill(); }

    const recover = launch('recover');
    const recovered = await new Response(recover.stdout).text();
    const errors = await new Response(recover.stderr).text();
    expect(await recover.exited, errors).toBe(0);
    expect(recovered).toContain('ACTION_RECOVERED');
    expect(readFileSync(calls, 'utf8').split('\n').filter(Boolean)).toHaveLength(writeMode ? 3 : 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('SIGKILL after private read retention resumes the same action on a new worker', () => verifyCrashRecovery(false), 120_000);
test('SIGKILL after committed private write reconciles one canonical effect on a new worker', () => verifyCrashRecovery(true), 180_000);
