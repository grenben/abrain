import { beforeAll, afterAll, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription } from '../../src/core/ai/subscription-context.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { runTriagePass, TRIAGE_VERSION, isTriageCacheValid } from '../../src/core/cycle/synthesize.ts';
import { CODEX_TRIAGE_SCHEMA, CODEX_TRIAGE_VERSION } from '../../src/core/cycle/triage-codex.ts';
import type { TriageDecide } from '../../src/core/cycle/triage-decide.ts';

const root = mkdtempSync(join(tmpdir(), 'codex-triage-'));
const bin = join(root, 'fixture.mjs'), capture = join(root, 'calls.jsonl');
const saved = Object.fromEntries(['HOME', 'GBRAIN_HOME', 'CODEX_HOME'].map(k => [k, process.env[k]]));
const originalFetch = globalThis.fetch;
const model = 'codex-cli:gpt-test';
let engine: PGLiteEngine;
let unregister: (() => void) | undefined;
let sequence = 0;
const transcript = (kind: string) => ({ filePath: `/synthetic/${kind}.txt`, basename: kind,
  contentHash: createHash('sha256').update(kind).digest('hex'), inferredDate: null,
  content: `[case:${kind}]\n[user]\nAcme-example will keep source evidence with every decision.` });
const cfg = { model, maxChars: 1000, maxTokens: 2048, threshold: 0.5, concurrency: 8, maxMs: 60_000 };
const calls = () => existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').map(s => JSON.parse(s)) : [];
async function withRun<T>(run: () => Promise<T>, accountLane = 'fixture-account') {
  const runId = `triage-${sequence++}`;
  await createSubscriptionRun(engine, { runId, accountLane, maxAttempts: 8, maxTurns: 8, deadline: new Date(Date.now() + 600_000) });
  return withCodexSubscription({ engine, runId }, run);
}
beforeAll(async () => {
  process.env.HOME = root; process.env.GBRAIN_HOME = root; process.env.CODEX_HOME = root;
  globalThis.fetch = (() => { throw new Error('forbidden network'); }) as unknown as typeof fetch;
  mkdirSync(join(root, '.gbrain'));
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ private_codex: { mode: 'strict', model, bin } }));
  const script = `#!${Bun.which('node')}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1],prompt=readFileSync(0,'utf8');
const schema=JSON.parse(readFileSync(arg('--output-schema'),'utf8'));
appendFileSync(${JSON.stringify(capture)},JSON.stringify({args,schema,prompt})+'\\n');
const kind=prompt.match(/\\[case:([^\\]]+)\\]/)?.[1];
const value={score:kind==='empty'?0:0.9,content_type:kind==='empty'?'routine':'strategy',
 segments:kind==='empty'?[]:[{quote:'Acme-example will keep source evidence with every decision.',note:'Keep evidence'}],
 entities:kind==='empty'?[]:['Acme-example'],reasons:['durable decision','explicit source evidence']};
if(kind==='bad_quote')value.segments[0].quote='invented evidence';
if(kind==='bad_entity')value.entities=['invented-example'];
if(kind==='bad_note')value.segments[0].note='one two three four five six seven eight nine ten eleven twelve thirteen';
if(kind==='bad_schema')value.score='0.9';
if(kind==='bad_suffix')value.segments[0].quote='Acme-example will keep source evidence with every decision. invented suffix';
const text=kind==='malformed'?'{':JSON.stringify(value);writeFileSync(arg('--output-last-message'),text);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
console.log(JSON.stringify({type:'turn.started'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
if(kind==='refusal')console.log(JSON.stringify({type:'turn.failed',error:{message:'synthetic refusal'}}));
else if(kind!=='incomplete')console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:0,output_tokens:20}}));
`;
  writeFileSync(bin, script, { mode: 0o700 });
  unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(script).digest('hex'));
  engine = new PGLiteEngine(); await engine.connect({ database_url: '' }); await engine.initSchema();
  configureGateway({ env: {}, embedding_model: 'openai:text-embedding-3-small' });
});
afterAll(async () => {
  await engine?.disconnect(); unregister?.(); resetGateway(); globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
});

test('real triage transports schema, serializes calls and stores grounded versioned verdicts', async () => {
  const good = transcript('good'), empty = transcript('empty');
  const result = await withRun(() => runTriagePass(engine, [good, empty], cfg));
  expect(result.judged).toBe(2); expect(result.reports.map(r => r.worth)).toEqual([true, false]);
  expect(calls().at(-1).schema).toEqual(CODEX_TRIAGE_SCHEMA);
  expect(calls().at(-1).args).toContain('--output-schema');
  const stored = await engine.getDreamVerdict(good.filePath, good.contentHash);
  expect(stored).toMatchObject({ score: 0.9, triage_version: CODEX_TRIAGE_VERSION, model,
    segments: [{ quote: 'Acme-example will keep source evidence with every decision.', note: 'Keep evidence' }] });
  expect(isTriageCacheValid(stored!, model)).toBe(true);
  const count = calls().length;
  expect((await runTriagePass(engine, [good, empty], cfg)).cacheHits).toBe(2);
  expect(calls()).toHaveLength(count); // Cache reads need no subscription grant.
  await engine.putDreamVerdict(good.filePath, good.contentHash, { ...stored!, model, triage_version: TRIAGE_VERSION });
  expect((await withRun(() => runTriagePass(engine, [good], cfg))).judged).toBe(1);
});

for (const kind of ['bad_quote', 'bad_entity', 'bad_note', 'bad_suffix', 'bad_schema', 'malformed']) {
  test(`${kind} fails without a cached rejection, hidden repair or accepted turn`, async () => {
    const t = transcript(kind), count = calls().length;
    await expect(withRun(() => runTriagePass(engine, [t], cfg))).rejects.toThrow();
    expect(await engine.getDreamVerdict(t.filePath, t.contentHash)).toBeNull();
    expect(calls()).toHaveLength(count + 1);
    const [run] = await engine.executeRaw<{ attempts: number; accepted_turns: number }>('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [`triage-${sequence - 1}`]);
    expect(Number(run?.attempts)).toBe(1); expect(Number(run?.accepted_turns)).toBe(0);
  });
}

test('conflicting model and optional decision provider refuse before any call or cache use', async () => {
  const count = calls().length;
  await expect(runTriagePass(engine, [transcript('good')], { ...cfg, model: 'anthropic:claude-test' })).rejects.toMatchObject({ code: 'private_route_conflict' });
  const decide = { observe: async () => { throw new Error('forbidden decision provider'); } } as unknown as TriageDecide;
  await expect(runTriagePass(engine, [], { ...cfg, decide })).rejects.toMatchObject({ source: 'dream:triage_decide' });
  expect(calls()).toHaveLength(count);
});

test('missing terminal completion holds the lane and never becomes a negative judgment', async () => {
  const t = transcript('incomplete'), count = calls().length;
  await expect(withRun(() => runTriagePass(engine, [t], cfg))).rejects.toThrow();
  expect(await engine.getDreamVerdict(t.filePath, t.contentHash)).toBeNull();
  await expect(withRun(() => runTriagePass(engine, [transcript('after-incomplete')], cfg))).rejects.toMatchObject({ code: 'subscription_lane_busy' });
  expect(calls()).toHaveLength(count + 1);
});

test('refusal is an explicit failure and never a cached negative judgment', async () => {
  const t = transcript('refusal'), count = calls().length;
  await expect(withRun(() => runTriagePass(engine, [t], cfg), 'fixture-refusal')).rejects.toThrow();
  expect(await engine.getDreamVerdict(t.filePath, t.contentHash)).toBeNull();
  expect(calls()).toHaveLength(count + 1);
});
