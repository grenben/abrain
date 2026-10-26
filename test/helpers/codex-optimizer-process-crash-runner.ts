import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type OptimizerCrashPoint = 'checkpoint' | 'result' | 'file' | 'shared-result' | 'shared-committed' | 'cycle-file' | 'cycle-complete';

/** Kill only our disposable worker after a committed production seam reports readiness. */
export async function verifyOptimizerCrashRecovery(point: OptimizerCrashPoint, databaseUrl?: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'codex-optimizer-kill-'));
  const home = join(root, 'home'), bin = join(root, 'fake-codex.mjs'), calls = join(root, 'calls.jsonl');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(calls, ''); writeFileSync(join(root, 'writes.jsonl'), '');
  const script = `#!${Bun.which('node')}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
const schema = JSON.parse(readFileSync(arg('--output-schema'), 'utf8'));
const data = JSON.parse(JSON.parse(readFileSync(0, 'utf8')).messages[0].content);
let value;
if (schema.properties.response) {
  const request = JSON.parse(data[0].content[0].text);
  value = { response: { kind: 'final', answer: request.candidate_skill.includes('Always cite evidence.') ? 'Use evidence.' : 'Prefer brevity.' } };
} else {
  value = { evidence_hash: schema.properties.evidence_hash.enum[0], edits: data.skillBodyText.includes('Prefer brevity.') ? [{ op: 'replace', target: 'Prefer brevity.', replacement: 'Always cite evidence.', reason: 'Ground the answer.' }] : [] };
}
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ model: arg('--model') }) + '\\n');
const text = JSON.stringify(value); writeFileSync(arg('--output-last-message'), text);
for (const event of [{ type: 'thread.started', thread_id: 'fixture' }, { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text } },
  { type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 2, output_tokens: 15 } }]) console.log(JSON.stringify(event));
`;
  writeFileSync(bin, script, { mode: 0o700 });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ private_codex: { mode: 'strict', bin,
    models: { utility: 'codex-cli:utility-fixture', reasoning: 'codex-cli:reasoning-fixture', deep: 'codex-cli:deep-fixture', subagent: 'codex-cli:subagent-fixture' },
    enabled_roles: ['iterative-minions', 'skillopt-optimizer', 'skillopt-judge'] } }));
  const env = { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, TMPDIR: root,
    GBRAIN_CI_DISABLE_TEST_ENV_FILE: '1', GBRAIN_MODEL_DISCOVERY: '0', CODEX_OPTIMIZER_CRASH_DATABASE_URL: databaseUrl ?? '' };
  const grouped = point.startsWith('shared-') || point.startsWith('cycle-');
  const helper = join(import.meta.dir, grouped ? 'codex-managed-cycle-process-crash.ts' : 'codex-optimizer-process-crash.ts');
  const launch = (mode: string) => Bun.spawn([process.execPath, '--no-env-file', helper, mode, point, root, createHash('sha256').update(script).digest('hex')],
    { env, stdout: 'pipe', stderr: 'pipe' });
  const complete = async (mode: string) => {
    const child = launch(mode);
    const timer = setTimeout(() => child.kill('SIGKILL'), grouped ? 300_000 : 150_000);
    try {
      const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, errors).toBe(0); return output;
    } finally { clearTimeout(timer); child.kill(); await child.exited; }
  };
  try {
    await complete('seed');
    const child = launch('crash'), errors = new Response(child.stderr).text(), reader = child.stdout.getReader();
    const timer = setTimeout(() => child.kill('SIGKILL'), grouped ? 300_000 : 150_000);
    try {
      let output = '';
      while (!output.includes('OPTIMIZER_RETAINED')) {
        const next = await reader.read(); if (next.done) break;
        output += new TextDecoder().decode(next.value);
      }
      if (!output.includes('OPTIMIZER_RETAINED')) throw new Error(`Optimizer exited before crash seam: ${await errors}`);
      child.kill('SIGKILL');
      expect(await child.exited).toBe(137); expect(child.signalCode).toBe('SIGKILL');
    } finally { clearTimeout(timer); child.kill(); await child.exited; await errors; }
    expect(await complete('recover')).toContain('OPTIMIZER_RECOVERED');
    const recorded = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const cycle = point.startsWith('cycle-');
    expect(recorded).toHaveLength(cycle ? 410 : 66);
    expect(recorded.filter(row => row.model === 'deep-fixture')).toHaveLength(cycle ? 10 : 1);
    expect(recorded.filter(row => row.model === 'subagent-fixture')).toHaveLength(cycle ? 400 : 65);
    expect(readFileSync(join(root, 'writes.jsonl'), 'utf8').trim().split('\n')).toHaveLength(cycle ? 2 : 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
