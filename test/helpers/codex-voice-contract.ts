import { beforeAll, afterAll, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway, chat } from '../../src/core/ai/gateway.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription, type CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { defaultJudge, gateVoice, DEFAULT_RUBRICS, type VoiceGateOpts } from '../../src/core/calibration/voice-gate.ts';

export function codexVoiceContract(createEngine: () => Promise<{ engine: BrainEngine; cleanup?: () => Promise<void> }>) {
  const root = mkdtempSync(join(tmpdir(), 'codex-voice-')), bin = join(root, 'fixture.mjs');
  const capture = join(root, 'calls.jsonl'), control = join(root, 'response.json');
  const keys = ['HOME', 'GBRAIN_HOME', 'CODEX_HOME'] as const;
  const saved = keys.map(k => [k, process.env[k]] as const), originalFetch = globalThis.fetch;
  let cleanup: (() => Promise<void>) | undefined, engine: BrainEngine, unregister: () => void, seq = 0;
  const candidate = 'You called the orchard well: 4 of 5 forecasts held up.';
  const reply = (value: unknown) => writeFileSync(control, JSON.stringify(value));
  const calls = () => readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const run = async <T>(fn: (id: string) => Promise<T>, maxAttempts = 6, hooks: Partial<CodexSubscriptionContext> = {}) => {
    const runId = `voice-fixture-${seq++}`;
    await createSubscriptionRun(engine, { runId, accountLane: runId, maxAttempts, maxTurns: maxAttempts, deadline: new Date(Date.now() + 600000) });
    return withCodexSubscription({ engine, runId, ...hooks }, () => fn(runId));
  };
  const accounting = async (id: string) => (await engine.executeRaw<{ attempts: number; accepted_turns: number; repairs: number }>(
    'SELECT attempts,accepted_turns,repairs FROM codex_subscription_runs WHERE run_id=$1', [id]))[0]!;
  const generate = async () => {
    const result = await chat({ model: 'codex-cli:gpt-test', timeoutMs: 120000, allowFallback: false, maxTokens: 512,
      messages: [{ role: 'user', content: 'Synthetic bounded content generator. Return one candidate.' }], responseSchema: { name: 'voice-fixture-generator',
        schema: { type: 'object', properties: { candidate: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['candidate'], additionalProperties: false } } });
    return JSON.parse(result.text).candidate as string;
  };
  const gate = (extra: Partial<VoiceGateOpts<null>> = {}) => gateVoice({ mode: 'pattern_statement', generate,
    templateFallback: { fn: () => { throw new Error('forbidden template fallback'); }, slots: null },
    judge: async () => { throw new Error('injected judge bypass'); }, ...extra });
  beforeAll(async () => {
    for (const key of keys) process.env[key] = root;
    globalThis.fetch = (() => { throw new Error('forbidden network'); }) as unknown as typeof fetch;
    mkdirSync(join(root, '.gbrain'));
    writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ private_codex: { mode: 'strict', model: 'codex-cli:gpt-test', bin } }));
    writeFileSync(capture, '');
    const script = `#!${Bun.which('node')}
import {readFileSync,writeFileSync,appendFileSync,statSync} from 'node:fs';
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1];
const schemaPath=arg('--output-schema'),schema=JSON.parse(readFileSync(schemaPath,'utf8')),prompt=readFileSync(0,'utf8');
appendFileSync(${JSON.stringify(capture)},JSON.stringify({args,schema,prompt,mode:statSync(schemaPath).mode&511,envKeys:Object.keys(process.env)})+'\\n');
const responses=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
const value=Array.isArray(responses)?responses.shift():responses;
if(Array.isArray(responses))writeFileSync(${JSON.stringify(control)},JSON.stringify(responses));
const bound=schema.properties.candidate_hash?{mode:schema.properties.mode.enum[0],candidate_hash:schema.properties.candidate_hash.enum[0]}:{};
const text=value.raw??JSON.stringify({...bound,...value});
writeFileSync(arg('--output-last-message'),text);
for(const event of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},
{type:'item.completed',item:{type:value.refusal?'refusal':'agent_message',text}},
...(value.missingCompletion?[]:[{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:4}}])])console.log(JSON.stringify(event));
`;
    writeFileSync(bin, script, { mode: 0o700 });
    unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(script).digest('hex'));
    ({ engine, cleanup } = await createEngine()); await engine.initSchema(); configureGateway({ env: {} });
  });
  afterAll(async () => {
    await engine?.disconnect(); await cleanup?.(); unregister?.(); resetGateway(); globalThis.fetch = originalFetch;
    for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  });
  for (const mode of Object.keys(DEFAULT_RUBRICS) as Array<keyof typeof DEFAULT_RUBRICS>) {
    test(`native ${mode} judge binds the actual candidate and records a valid judgment`, async () => {
      reply({ verdict: 'conversational', reason: 'Plain and grounded.' });
      await run(async id => {
        expect(await defaultJudge({ candidate, mode, rubric: DEFAULT_RUBRICS[mode] })).toEqual({ verdict: 'conversational', reason: 'Plain and grounded.' });
        const a = await accounting(id); expect(Number(a.attempts)).toBe(1); expect(Number(a.accepted_turns)).toBe(1);
      });
      const wire = calls().at(-1)!;
      expect(wire.args).toContain('--output-schema'); expect(wire.mode).toBe(0o600);
      expect(wire.schema.properties.mode.enum).toEqual([mode]);
      expect(wire.schema.properties.candidate_hash.enum).toEqual([createHash('sha256').update(candidate).digest('hex')]);
      expect(wire.prompt).toContain(candidate);
      expect(wire.envKeys.some((key: string) => /API_KEY|TOKEN|DATABASE_URL/.test(key))).toBe(false);
    });
  }
  test.each([
    { raw: 'malformed' }, { verdict: 'unexpected', reason: 'bad verdict' }, { verdict: 'academic', reason: '   ' },
    { verdict: 'academic', reason: 'line\nbreak' }, { verdict: 'conversational', reason: 'ok', candidate_hash: 'wrong' },
    { verdict: 'conversational', reason: 'ok', mode: 'nudge' }, { verdict: 'conversational', reason: 'ok', operation_id: 'forged' },
  ])('malformed judge output stays a failure, never a negative grade or template', async value => {
    reply([{ candidate }, value]); const before = calls().length;
    await run(async id => {
      await expect(gate()).rejects.toMatchObject({ reason: 'invalid_output' });
      const a = await accounting(id); expect(Number(a.attempts)).toBe(2); expect(Number(a.accepted_turns)).toBe(1);
    });
    expect(calls().length - before).toBe(2);
  });
  test('one valid rejection permits exactly one admitted content repair', async () => {
    reply([{ candidate }, { verdict: 'academic', reason: 'Shorter and more conversational.' },
      { candidate: 'You got 4 of 5 orchard forecasts right.' }, { verdict: 'conversational', reason: 'Clear.' }]);
    await run(async id => {
      expect(await gate()).toMatchObject({ passed: true, attempts: 2, text: 'You got 4 of 5 orchard forecasts right.' });
      const a = await accounting(id); expect(Number(a.attempts)).toBe(4); expect(Number(a.repairs)).toBe(1); expect(Number(a.accepted_turns)).toBe(4);
    });
  });
  test('two valid rejections defer instead of writing a fallback success', async () => {
    reply([{ candidate }, { verdict: 'academic', reason: 'Too clinical.' }, { candidate }, { verdict: 'academic', reason: 'Still clinical.' }]);
    await run(async id => {
      await expect(gate()).rejects.toMatchObject({ code: 'voice_gate_rejected' });
      expect(Number((await accounting(id)).attempts)).toBe(4);
    });
  });
  test.each([{ refusal: true }, { missingCompletion: true }])('uncertain judge failures retain the lane and do not regenerate', async value => {
    reply([{ candidate }, value]);
    await run(async id => {
      await expect(gate()).rejects.toMatchObject({ reason: value.refusal ? 'refusal' : 'missing_completion' });
      const [row] = await engine.executeRaw<{ state: string }>('SELECT state FROM codex_subscription_attempts WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1', [id]);
      expect(row!.state).toBe('unresolved'); expect(Number((await accounting(id)).attempts)).toBe(2);
    });
  });
  test('generator failure stops immediately without retry and redacts arbitrary errors', async () => {
    const before = calls().length;
    await run(async id => {
      await expect(gate({ generate: async () => { throw new Error('RAW_PROVIDER_SECRET'); } })).rejects.toMatchObject({ reason: 'provider_failure', message: 'codex-cli proposal failed: provider_failure' });
      expect(Number((await accounting(id)).attempts)).toBe(0);
    });
    expect(calls().length).toBe(before);
  });
  test('an exhausted envelope stops the repair without fallback', async () => {
    reply([{ candidate }, { verdict: 'academic', reason: 'Too clinical.' }]);
    await run(async id => {
      await expect(gate()).rejects.toMatchObject({ code: 'subscription_exhausted' });
      expect(Number((await accounting(id)).attempts)).toBe(2);
    }, 2);
  });
  test('repair allowances are shared with an enclosing repair scope', async () => {
    reply([{ candidate }, { verdict: 'academic', reason: 'Too clinical.' }]);
    await run(async id => {
      await expect(gate()).rejects.toMatchObject({ code: 'subscription_exhausted' });
      const a = await accounting(id); expect(Number(a.attempts)).toBe(2); expect(Number(a.repairs)).toBe(1);
    }, 6, { repair: true });
  });
  test('missing admission and conflicting judge pins fail before generation', async () => {
    const before = calls().length;
    await expect(gate()).rejects.toMatchObject({ code: 'subscription_required' });
    await engine.setConfig('models.tier.utility', 'anthropic:claude-test');
    try { await run(async () => { await expect(gate()).rejects.toMatchObject({ code: 'private_route_conflict' }); }); }
    finally { await engine.setConfig('models.tier.utility', ''); }
    expect(calls().length).toBe(before);
  });
  test('bounds and cancellation refuse before callbacks; explicit template-only remains deterministic', async () => {
    let generated = 0;
    const before = calls().length;
    await run(async () => {
      await expect(gate({ maxAttempts: 3, generate: async () => { generated++; return candidate; } })).rejects.toMatchObject({ reason: 'invalid_input' });
      await expect(defaultJudge({ candidate: 'x'.repeat(4001), mode: 'nudge', rubric: 'be plain' })).rejects.toMatchObject({ reason: 'invalid_input' });
    });
    await run(async () => { await expect(gate({ generate: async () => { generated++; return candidate; } })).rejects.toMatchObject({ reason: 'aborted' }); }, 6, { signal: AbortSignal.abort() });
    expect(await gate({ maxAttempts: 0, templateFallback: { fn: () => 'Explicit local template', slots: null } })).toMatchObject({ text: 'Explicit local template', passed: false, attempts: 0 });
    expect(generated).toBe(0); expect(calls().length).toBe(before);
  });
}
