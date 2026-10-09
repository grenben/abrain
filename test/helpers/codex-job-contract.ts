import { beforeAll, beforeEach, afterAll, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { runWithJobSpend, jobSpendAuthorization } from '../../src/core/minions/spend-authorization.ts';
import type { MinionJob, MinionJobContext } from '../../src/core/minions/types.ts';
import { chat, configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { withAIInvocationGuard, invokeAI } from '../../src/core/ai/invocation-guard.ts';
import { runJobInChild } from '../../src/core/minions/child-job-runner.ts';
import { noteChildSubscriptionEnforcement } from '../../src/core/minions/subscription-child.ts';

export function codexJobContract(createEngine: () => Promise<{ engine: BrainEngine; cleanup?: () => Promise<void> }>) {
const root = mkdtempSync(join(tmpdir(), 'codex-jobs-'));
const bin = join(root, 'fixture.mjs'), capture = join(root, 'calls');
const saved = Object.fromEntries(['HOME', 'GBRAIN_HOME', 'CODEX_HOME'].map(k => [k, process.env[k]]));
const originalFetch = globalThis.fetch;
let engine: BrainEngine, queue: MinionQueue, unregister: () => void;
let cleanup: (() => Promise<void>) | undefined;
const config = (enabled = true, model = 'codex-cli:gpt-test') => writeFileSync(join(root, '.gbrain', 'config.json'),
  JSON.stringify(enabled ? { private_codex: { mode: 'strict', model, bin } } : {}));
const grant = () => ({ maxAttempts: 2, maxTurns: 2, deadline: new Date(Date.now() + 600_000) });
const ctxFor = (job: MinionJob, signal = new AbortController().signal) => ({
  id: job.id, name: job.name, data: job.data, signal, shutdownSignal: new AbortController().signal,
}) as MinionJobContext;
const call = () => chat({ messages: [{ role: 'user', content: 'synthetic fixture' }], timeoutMs: 1000 });
const count = () => readFileSync(capture, 'utf8').split('\n').filter(Boolean).length;
async function claimed(granted = true, spend = false) {
  await queue.add('enrich', { sourceId: 'default' }, {}, {
    ...(granted ? { codexSubscription: grant() } : {}),
    ...(spend ? { spendAuthorization: jobSpendAuthorization({ consented_effects: ['paid'], cap_usd: 0.01, cap_source: 'user', via: 'yes' }, { command: 'enrich' }) } : {}),
  });
  const job = await queue.claim('fixture-token', 60_000, 'default', ['enrich']);
  if (!job) throw new Error('fixture was not claimed');
  return job;
}
beforeAll(async () => {
  for (const name of Object.keys(saved)) process.env[name] = root;
  globalThis.fetch = (() => { throw new Error('forbidden network'); }) as unknown as typeof fetch;
  mkdirSync(join(root, '.gbrain'));
  const script = `#!${Bun.which('node')}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1];
readFileSync(0,'utf8');appendFileSync(${JSON.stringify(capture)},'call\\n');
const text=JSON.stringify({text:'fixture'});writeFileSync(arg('--output-last-message'),text);
for(const e of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:2,output_tokens:3}}])console.log(JSON.stringify(e));
`;
  writeFileSync(bin, script, { mode: 0o700 });
  unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(script).digest('hex'));
  ({ engine, cleanup } = await createEngine());
  await engine.initSchema(); queue = new MinionQueue(engine);
});
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM codex_subscription_attempts');
  await engine.executeRaw('DELETE FROM codex_subscription_runs');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM mcp_spend_reservations');
  config(); writeFileSync(capture, ''); resetGateway(); configureGateway({ env: {} });
});
afterAll(async () => {
  await engine?.disconnect(); await cleanup?.(); unregister?.(); resetGateway(); globalThis.fetch = originalFetch;
  for (const [k,v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(root, { recursive: true, force: true });
});

test('real queue and worker spend wrapper reuse a durable allowance across retries', async () => {
  const job = await claimed(); const ctx = ctxFor(job);
  expect((await runWithJobSpend(engine, job, ctx, call)).text).toBe('fixture');
  expect((await runWithJobSpend(engine, job, ctx, call)).text).toBe('fixture');
  await expect(runWithJobSpend(engine, job, ctx, call)).rejects.toMatchObject({ code: 'subscription_exhausted' });
  expect(count()).toBe(2);
  const [row] = await engine.executeRaw('SELECT attempts,accepted_turns,account_lane FROM codex_subscription_runs');
  expect(row).toMatchObject({ attempts: 2, accepted_turns: 2, account_lane: 'codex-subscription' });
});
test('a real worker carries the grant through gateway dispatch and fenced completion', async () => {
  const job = await queue.add('enrich', { sourceId: 'default' }, { max_attempts: 1 }, { codexSubscription: grant() });
  const worker = new MinionWorker(engine, { concurrency: 1, pollInterval: 25, healthCheckInterval: 0, maxRssMb: 0 });
  worker.register('enrich', async () => ({ text: (await call()).text }));
  const running = worker.start();
  try {
    const deadline = Date.now() + 10_000;
    let current = await queue.getJob(job.id);
    while (Date.now() < deadline && current?.status !== 'completed' && current?.status !== 'dead') {
      await new Promise(resolve => setTimeout(resolve, 25)); current = await queue.getJob(job.id);
    }
    expect(current?.status).toBe('completed');
    expect(current?.result).toMatchObject({ text: 'fixture' });
    expect(count()).toBe(1);
  } finally { worker.stop(); await running; }
});
test('payload subscription fields and USD consent do not authorize subscription calls', async () => {
  const spendAuthorization = jobSpendAuthorization({ consented_effects: ['paid'], cap_usd: 0.01, cap_source: 'user', via: 'yes' }, { command: 'enrich' });
  await expect(queue.add('enrich', { codexSubscription: grant() }, {}, { spendAuthorization })).rejects.toMatchObject({ code: 'subscription_required' });
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
  config(false); const job = await claimed(false, true); config(); job.data.codexSubscription = grant();
  await expect(runWithJobSpend(engine, job, ctxFor(job), call)).rejects.toMatchObject({ code: 'subscription_required' });
  expect(count()).toBe(0);
});
test('queue preflight refuses forbidden pins and private native minions without inserting jobs', async () => {
  await expect(queue.add('enrich', { model: 'anthropic:claude-test' })).rejects.toMatchObject({ source: 'job:model' });
  await expect(queue.add('subagent', { model: 'codex-cli:gpt-test' })).rejects.toMatchObject({ code: 'private_native_loop_unsupported' });
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});
test('invalid grants roll back insertion; coalescing cannot enlarge allowances or change inputs', async () => {
  await expect(queue.add('enrich', {}, {}, { codexSubscription: { ...grant(), maxAttempts: 0 } })).rejects.toMatchObject({ code: 'subscription_invalid' });
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
  const g = grant(), options = { idempotency_key: 'subscription-fixture' };
  const first = await queue.add('enrich', { sourceId: 'default' }, options, { codexSubscription: g });
  expect((await queue.add('enrich', { sourceId: 'default' }, options, { codexSubscription: g })).id).toBe(first.id);
  await expect(queue.add('enrich', { sourceId: 'default' }, options, { codexSubscription: { ...g, maxAttempts: 3 } })).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
  await expect(queue.add('enrich', { sourceId: 'default', prompt: 'changed' }, options, { codexSubscription: g })).rejects.toThrow('subscription_identity_conflict');
});
test('legacy coalesced jobs cannot silently adopt the subscription protocol', async () => {
  config(false);
  await queue.add('enrich', {}, { idempotency_key: 'legacy-fixture' });
  config();
  await expect(queue.add('enrich', {}, { idempotency_key: 'legacy-fixture' }, { codexSubscription: grant() })).rejects.toMatchObject({ code: 'subscription_required' });
  expect(await engine.executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(0);
});
test('source incarnation, payload and configured route changes invalidate the binding', async () => {
  const job = await claimed();
  await engine.executeRaw("UPDATE minion_jobs SET data=$2::text::jsonb WHERE id=$1", [job.id, JSON.stringify({ sourceId: 'default', prompt: 'changed' })]);
  await expect(runWithJobSpend(engine, job, ctxFor(job), call)).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
  await engine.executeRaw('UPDATE minion_jobs SET data=$2::text::jsonb WHERE id=$1', [job.id, JSON.stringify(job.data)]);
  config(true, 'codex-cli:gpt-other');
  await expect(runWithJobSpend(engine, job, ctxFor(job), call)).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
  config();
  await engine.executeRaw("UPDATE sources SET created_at=created_at+interval '1 second' WHERE id='default'");
  await expect(runWithJobSpend(engine, job, ctxFor(job), call)).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
  expect(count()).toBe(0);
});
test('disabling private mode does not reinterpret an authorized job as API work', async () => {
  const job = await claimed(); config(false);
  let ran = false;
  await expect(runWithJobSpend(engine, job, ctxFor(job), async () => { ran = true; })).rejects.toMatchObject({ code: 'subscription_required' });
  expect(ran).toBe(false);
});
test('lease loss between admission and runtime refuses execution and settles the unused attempt', async () => {
  const job = await claimed();
  await expect(runWithJobSpend(engine, job, ctxFor(job), () => withAIInvocationGuard(async () => {
    await engine.executeRaw("UPDATE minion_jobs SET lock_token='new-worker', codex_claim_token=claim_generation+1, claim_generation=claim_generation+1 WHERE id=$1", [job.id]);
    return { settle: async () => {} };
  }, call))).rejects.toMatchObject({ code: 'subscription_owner_lost' });
  expect(count()).toBe(0);
  const [row] = await engine.executeRaw('SELECT state FROM codex_subscription_attempts');
  expect(row).toMatchObject({ state: 'failed' });
});
test('cancelled jobs cannot dispatch even when the caller omits a gateway abort signal', async () => {
  const job = await claimed(); const controller = new AbortController();
  await expect(runWithJobSpend(engine, job, ctxFor(job, controller.signal), async () => {
    controller.abort(); return call();
  })).rejects.toMatchObject({ reason: 'aborted' });
  expect(count()).toBe(0);
});
test('auxiliary API admission is still independent and enforced in a subscription job', async () => {
  const job = await claimed(true, true); let dispatched = false;
  await expect(runWithJobSpend(engine, job, ctxFor(job), () => invokeAI({
    operation: 'fixture', kind: 'embedding', model: 'openai:text-embedding-3-small', maxInputTokens: 10_000_000, maxOutputTokens: 0,
  }, async () => { dispatched = true; return ''; }, () => null))).rejects.toThrow();
  expect(dispatched).toBe(false);
});
test('subscription-only jobs cannot make auxiliary paid calls', async () => {
  const job = await claimed(); let dispatched = false;
  await expect(runWithJobSpend(engine, job, ctxFor(job), () => invokeAI({
    operation: 'fixture', kind: 'embedding', model: 'openai:text-embedding-3-small', maxInputTokens: 1, maxOutputTokens: 0,
  }, async () => { dispatched = true; return ''; }, () => null))).rejects.toMatchObject({ code: 'subscription_auxiliary_budget_required' });
  expect(dispatched).toBe(false);
});
test('older workers cannot claim or reclaim jobs carrying subscription admission', async () => {
  const job = await queue.add('enrich', {}, {}, { codexSubscription: grant() });
  await expect(engine.executeRaw("UPDATE minion_jobs SET status='active',lock_token='old',claim_generation=claim_generation+1 WHERE id=$1", [job.id])).rejects.toThrow('Codex subscription job protocol 1 required');
  const current = await queue.claim('new', 60_000, 'default', ['enrich']);
  expect(current?.id).toBe(job.id);
  await expect(engine.executeRaw("UPDATE minion_jobs SET lock_token='old',claim_generation=claim_generation+1 WHERE id=$1", [job.id])).rejects.toThrow('Codex subscription job protocol 1 required');
});
test('older isolated children are rejected before any subprocess can start', async () => {
  noteChildSubscriptionEnforcement(['spend-enforcement-v1']);
  await expect(runJobInChild({ jobId: 1, jobName: 'enrich', lockToken: 'fixture', codexAuthorized: true,
    invocation: { cmd: '/must-not-execute', argsPrefix: [] }, tiniPath: '',
    abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
  })).rejects.toMatchObject({ reasonCode: 'child_protocol_incompatible' });
});
}
