import { beforeAll, beforeEach, afterAll, test, expect, spyOn } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { makeEnrichHandler } from '../../src/core/minions/handlers/enrich.ts';
import { runWithJobSpend, jobSpendAuthorization } from '../../src/core/minions/spend-authorization.ts';
import type { MinionJob, MinionJobContext } from '../../src/core/minions/types.ts';
import { chat, configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { withAIInvocationGuard, invokeAI } from '../../src/core/ai/invocation-guard.ts';
import { runJobInChild } from '../../src/core/minions/child-job-runner.ts';
import { noteChildSubscriptionEnforcement } from '../../src/core/minions/subscription-child.ts';
import { runJobsSubmit } from '../../src/commands/jobs/submit.ts';
import { SOURCE_FRESHNESS_PHASES } from '../../src/core/cycle/phase-scope.ts';
import { dispatchGlobalMaintenance } from '../../src/commands/autopilot-fanout.ts';
import { scheduledCodexSubmit } from '../../src/core/minions/subscription-schedules.ts';
import { readPrivateCodexConfig } from '../../src/core/ai/private-policy.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../../src/core/ai/subscription-context.ts';
import { BudgetMeter } from '../../src/core/cycle/budget-meter.ts';
import { parseArgs as parseEnrichArgs, runEnrich, runEnrichCore } from '../../src/commands/enrich.ts';
import { createEphemeralBrain } from '../../src/core/ephemeral-brain.ts';
import { withSubscriptionScratch } from '../../src/core/ai/subscription-target.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { queuePrivateEnrich, withEnrichSubscription } from '../../src/commands/enrich-subscription.ts';

export function codexJobContract(createEngine: () => Promise<{ engine: BrainEngine; cleanup?: () => Promise<void> }>) {
const root = mkdtempSync(join(tmpdir(), 'codex-jobs-'));
const bin = join(root, 'fixture.mjs'), capture = join(root, 'calls'), replyPath = join(root, 'reply');
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
const input=readFileSync(0,'utf8');appendFileSync(${JSON.stringify(capture)},'call\\n');
const slug=(input.match(/people\\/enrich-(?:default|other)-worker/)||[])[0]||'';
const text=JSON.stringify({text:readFileSync(${JSON.stringify(replyPath)},'utf8').replaceAll('{{slug}}',slug)});writeFileSync(arg('--output-last-message'),text);
for(const e of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:2,output_tokens:3}}])console.log(JSON.stringify(e));
`;
  writeFileSync(bin, script, { mode: 0o700 }); writeFileSync(replyPath, 'fixture');
  unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(script).digest('hex'));
  ({ engine, cleanup } = await createEngine());
  await engine.initSchema(); queue = new MinionQueue(engine);
});
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM codex_proposal_cache');
  await engine.executeRaw('DELETE FROM codex_subscription_attempts');
  await engine.executeRaw('DELETE FROM codex_subscription_runs');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM mcp_spend_reservations');
  config(); writeFileSync(capture, ''); writeFileSync(replyPath, 'fixture'); resetGateway(); configureGateway({ env: {} });
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
test('private enrichment core refuses an unowned run before candidate work', async () => {
  await expect(runEnrichCore(engine, { sourceId: 'default', model: 'codex-cli:gpt-test' }))
    .rejects.toMatchObject({ code: 'subscription_required' });
  const job = await claimed();
  const result = await runWithJobSpend(engine, job, ctxFor(job), () =>
    runEnrichCore(engine, { sourceId: 'default', model: 'codex-cli:gpt-test', limit: 1 }));
  expect(result.pages_enriched).toBe(0);
  expect(count()).toBe(0);
});
test('private enrichment core refuses a foreign model and disposable output target', async () => {
  const job = await claimed();
  const scratch = await createEphemeralBrain();
  try {
    await runWithJobSpend(engine, job, ctxFor(job), async () => {
      await expect(runEnrichCore(engine, { sourceId: 'default', model: 'anthropic:claude-test' }))
        .rejects.toMatchObject({ source: 'cli:model' });
      await expect(withSubscriptionScratch(scratch, () =>
        runEnrichCore(scratch, { sourceId: 'default', model: 'codex-cli:gpt-test' })))
        .rejects.toMatchObject({ code: 'subscription_identity_conflict' });
    });
  } finally { await scratch.disconnect(); }
  expect(count()).toBe(0);
});
test('inline enrichment owns a durable allowance and binds retry identity', async () => {
  const flags = { maxAttempts: '2', maxTurns: '2', deadline: grant().deadline.toISOString(), requestId: randomUUID() };
  const identity = { sourceIds: ['default'], params: { sourceId: 'default', model: 'codex-cli:gpt-test', limit: 1 } };
  await expect(withEnrichSubscription(engine, {}, identity, async () => call()))
    .rejects.toMatchObject({ code: 'subscription_required' });
  const result = await withEnrichSubscription(engine, flags, identity, async model => {
    expect(model).toBe('codex-cli:gpt-test');
    return call();
  });
  expect(result.text).toBe('fixture');
  expect(count()).toBe(1);
  await expect(withEnrichSubscription(engine, flags, { ...identity, params: { ...identity.params, limit: 2 } }, async () => call()))
    .rejects.toMatchObject({ code: 'subscription_identity_conflict' });
  expect(count()).toBe(1);
  const [run] = await engine.executeRaw<{ attempts: number; accepted_turns: number }>(
    "SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id LIKE 'codex-enrich:%'");
  expect(run).toMatchObject({ attempts: 1, accepted_turns: 1 });
});
test('private enrichment validates citations before accepting and publishing a page', async () => {
  const slug = 'people/enrich-example';
  await engine.putPage(slug, { type: 'person' as never, title: 'Enrich Example', compiled_truth: 'Stub page.', timeline: '', frontmatter: {} });
  await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,source,valid_from)
    VALUES('default',$1,'Enrich Example led the synthetic launch in 2026.','test',now())`, [slug]);
  const flags = { maxAttempts: '2', maxTurns: '2', deadline: grant().deadline.toISOString(), requestId: randomUUID() };
  const identity = { sourceIds: ['default'], params: { sourceId: 'default', model: 'codex-cli:gpt-test', limit: 1, minContextChars: 20 } };
  writeFileSync(replyPath, '## Overview\nEnrich Example led the synthetic launch in 2026.');
  await expect(withEnrichSubscription(engine, flags, identity, () => runEnrichCore(engine, {
    sourceId: 'default', model: 'codex-cli:gpt-test', limit: 1, minContextChars: 20,
  }))).rejects.toMatchObject({ reason: 'invalid_output' });
  expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.compiled_truth).toBe('Stub page.');
  writeFileSync(replyPath, `## Overview\nEnrich Example led the synthetic launch in 2026. [Source: ${slug}]`);
  const result = await withEnrichSubscription(engine, flags, identity, () => runEnrichCore(engine, {
    sourceId: 'default', model: 'codex-cli:gpt-test', limit: 1, minContextChars: 20,
  }));
  expect(result.pages_enriched).toBe(1);
  expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.compiled_truth).toContain(`[Source: ${slug}]`);
  const [run] = await engine.executeRaw<{ accepted_turns: number }>(
    "SELECT accepted_turns FROM codex_subscription_runs WHERE run_id LIKE 'codex-enrich:%'");
  expect(Number(run?.accepted_turns)).toBe(1);
});
test('direct enrich CLI carries its explicit allowance into page publication', async () => {
  const slug = 'people/enrich-cli-example';
  await engine.putPage(slug, { type: 'person' as never, title: 'Enrich CLI Example', compiled_truth: 'Stub page.', timeline: '', frontmatter: {} });
  await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,source,valid_from)
    VALUES('default',$1,'Enrich CLI Example led a synthetic project.','test',now())`, [slug]);
  writeFileSync(replyPath, `## Overview\nEnrich CLI Example led a synthetic project. [Source: ${slug}]`);
  const flags = ['--source', 'default', '--model', 'codex-cli:gpt-test', '--limit', '1', '--min-context', '20',
    '--max-usd', '0.01', '--yes', '--json', '--codex-max-attempts', '1', '--codex-max-turns', '1',
    '--codex-deadline', grant().deadline.toISOString(), '--codex-request-id', randomUUID()];
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try { await runEnrich(engine, flags); } finally { log.mockRestore(); }
  expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.compiled_truth).toContain(`[Source: ${slug}]`);
  expect(count()).toBe(1);
});
test('background enrich CLI submits a source job with a parent subscription allowance', async () => {
  const backgroundEngine = Object.assign(Object.create(engine) as BrainEngine, { kind: 'postgres' as const });
  const requestId = randomUUID();
  const flags = ['--background', '--source', 'default', '--model', 'codex-cli:gpt-test', '--limit', '1',
    '--max-usd', '0.01', '--yes', '--codex-max-attempts', '1', '--codex-max-turns', '1',
    '--codex-deadline', grant().deadline.toISOString(), '--codex-request-id', requestId];
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try { await runEnrich(backgroundEngine, flags); } finally { log.mockRestore(); }
  const [child] = await engine.executeRaw<{ parent_run_id: string }>(
    "SELECT parent_run_id FROM codex_subscription_runs WHERE run_id LIKE 'codex-job:%'");
  expect(child?.parent_run_id).toContain(`codex-enrich-batch:${requestId}:`);
  const [job] = await engine.executeRaw<{ spend_authorization: { group_id: string } }>(
    "SELECT spend_authorization FROM minion_jobs WHERE name='enrich' ORDER BY id DESC LIMIT 1");
  expect(job?.spend_authorization.group_id).toBe(requestId);
  expect(count()).toBe(0);
});
test('direct enrich CLI refuses missing or duplicated subscription flags before work', async () => {
  await expect(runEnrich(engine, ['--source', 'default', '--yes']))
    .rejects.toMatchObject({ code: 'subscription_required' });
  const backgroundEngine = Object.assign(Object.create(engine) as BrainEngine, { kind: 'postgres' as const });
  await expect(runEnrich(backgroundEngine, ['--background', '--source', 'default', '--yes']))
    .rejects.toMatchObject({ code: 'subscription_required' });
  await expect(runEnrich(backgroundEngine, ['--background', '--dry-run', '--source', 'default']))
    .rejects.toThrow('Private Codex --dry-run cannot be queued.');
  expect(parseEnrichArgs(['--codex-max-attempts', '2', '--codex-max-attempts', '3']).error)
    .toContain('requires one space-separated value');
  expect(count()).toBe(0);
});
test('private background source jobs share one durable subscription and paid cap', async () => {
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'Other') ON CONFLICT (id) DO NOTHING");
  try {
    const flags = { maxAttempts: '2', maxTurns: '2', deadline: grant().deadline.toISOString(), requestId: randomUUID() };
    const identity = { sourceIds: ['default', 'other'], params: { model: 'codex-cli:gpt-test', limit: 1 }, auxiliaryMaxUsd: 0.02 };
    const spend = jobSpendAuthorization({ consented_effects: ['paid'], cap_usd: 0.02, cap_source: 'user', via: 'yes' },
      { command: 'enrich', of: 2 });
    const submit = () => queuePrivateEnrich(engine, flags, identity, sourceId => ({ sourceId, model: 'codex-cli:gpt-test', limit: 1 }),
      sourceId => `test-enrich:${sourceId}`, spend);
    const first = await submit();
    expect(first.jobs).toHaveLength(2);
    expect(first.jobs.every(job => job.spend_authorization?.group_id === flags.requestId)).toBe(true);
    const [parent] = await engine.executeRaw<{ run_id: string; max_attempts: number; max_turns: number }>(
      "SELECT run_id,max_attempts,max_turns FROM codex_subscription_runs WHERE run_id LIKE 'codex-enrich-batch:%'");
    expect(parent).toMatchObject({ max_attempts: 2, max_turns: 2 });
    const children = await engine.executeRaw<{ run_id: string; parent_run_id: string }>(
      "SELECT run_id,parent_run_id FROM codex_subscription_runs WHERE parent_run_id LIKE 'codex-enrich-batch:%' ORDER BY run_id");
    expect(children).toHaveLength(2);
    expect(children.every(child => child.parent_run_id === parent?.run_id)).toBe(true);
    const retry = await submit();
    expect(retry.jobs.map(job => job.id)).toEqual(first.jobs.map(job => job.id));
    await expect(queuePrivateEnrich(engine, flags, { ...identity, params: { ...identity.params, limit: 2 } },
      sourceId => ({ sourceId, model: 'codex-cli:gpt-test', limit: 2 }), sourceId => `test-enrich:${sourceId}`, spend))
      .rejects.toMatchObject({ code: 'subscription_identity_conflict' });
    for (const child of children) await withCodexSubscription({ engine, runId: child.run_id }, () => call());
    await expect(withCodexSubscription({ engine, runId: children[0]!.run_id }, () => call()))
      .rejects.toMatchObject({ code: 'subscription_exhausted' });
    expect(count()).toBe(2);
  } finally {
    await engine.executeRaw("DELETE FROM sources WHERE id='other'");
  }
});
test('a real worker publishes both source jobs under their shared parent allowance', async () => {
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'Other') ON CONFLICT (id) DO NOTHING");
  const sources = [
    { id: 'default', slug: 'people/enrich-default-worker' },
    { id: 'other', slug: 'people/enrich-other-worker' },
  ];
  try {
    for (const source of sources) {
      await engine.putPage(source.slug, { type: 'person' as never, title: source.slug,
        compiled_truth: 'Stub page.', timeline: '', frontmatter: {} }, { sourceId: source.id });
      await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,source,valid_from)
        VALUES($1,$2,'This person led a synthetic launch.','test',now())`, [source.id, source.slug]);
    }
    writeFileSync(replyPath, '## Overview\nThis person led a synthetic launch. [Source: {{slug}}]');
    const flags = { maxAttempts: '2', maxTurns: '2', deadline: grant().deadline.toISOString(), requestId: randomUUID() };
    const spend = jobSpendAuthorization({ consented_effects: ['paid'], cap_usd: 0.02, cap_source: 'user', via: 'yes' },
      { command: 'enrich', of: 2 });
    const { jobs } = await queuePrivateEnrich(engine, flags, { sourceIds: sources.map(source => source.id),
      params: { model: 'codex-cli:gpt-test', limit: 1, minContextChars: 20 }, auxiliaryMaxUsd: 0.02 },
    sourceId => ({ sourceId, model: 'codex-cli:gpt-test', limit: 1, minContextChars: 20 }),
    sourceId => `test-worker-enrich:${sourceId}`, spend);
    const worker = new MinionWorker(engine, { concurrency: 1, pollInterval: 25, healthCheckInterval: 0, maxRssMb: 0 });
    worker.register('enrich', makeEnrichHandler(engine));
    const running = worker.start();
    try {
      const deadline = Date.now() + 12_000;
      let states = await Promise.all(jobs.map(job => queue.getJob(job.id)));
      while (Date.now() < deadline && states.some(job => job?.status !== 'completed' && job?.status !== 'dead')) {
        await new Promise(resolve => setTimeout(resolve, 25));
        states = await Promise.all(jobs.map(job => queue.getJob(job.id)));
      }
      expect(states.map(job => job?.status)).toEqual(['completed', 'completed']);
      expect(states.map(job => (job?.result as { pages_enriched?: number } | undefined)?.pages_enriched)).toEqual([1, 1]);
    } finally { worker.stop(); await running; }
    for (const source of sources) {
      expect((await engine.readPageSnapshot(source.slug, { sourceId: source.id }))?.page.compiled_truth)
        .toContain(`[Source: ${source.slug}]`);
    }
    const [parent] = await engine.executeRaw<{ attempts: number; accepted_turns: number }>(
      "SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id LIKE 'codex-enrich-batch:%'");
    expect(parent).toMatchObject({ attempts: 2, accepted_turns: 2 });
    expect(count()).toBe(2);
  } finally {
    await engine.executeRaw("DELETE FROM sources WHERE id='other'");
  }
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
test('transactional publication fence rejects a second worker ownership change', async () => {
  const job=await claimed();
  await expect(runWithJobSpend(engine,job,ctxFor(job),async()=>{
    const fence=codexSubscriptionContext()!.checkAuthorityInTransaction!;
    await engine.transaction(tx=>fence(tx));
    await engine.executeRaw("UPDATE minion_jobs SET lock_token='second-worker',codex_claim_token=claim_generation+1,claim_generation=claim_generation+1 WHERE id=$1",[job.id]);
    await expect(engine.transaction(async tx=>{
      await fence(tx);await tx.setConfig('synthetic.publication_fence','wrong');
    })).rejects.toMatchObject({code:'subscription_owner_lost'});
    expect(await engine.getConfig('synthetic.publication_fence')).toBeNull();
  })).rejects.toMatchObject({code:'subscription_owner_lost'});
});
test('ordinary page admission under a subscription rejects a lost worker lease', async () => {
  const job = await claimed();
  const context: OperationContext = { engine, config: { engine: 'pglite', embedding_disabled: true },
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' };
  const put = (slug: string) => submitPageMutation(context, { operation: 'put_page', params: {
    slug, content: `---\ntype: note\ntitle: ${slug}\n---\n\nSynthetic body.`, request_id: randomUUID(), wait_ms: 100,
  } });
  await expect(runWithJobSpend(engine, job, ctxFor(job), async () => {
    await put('notes/subscription-owned');
    await engine.executeRaw("UPDATE minion_jobs SET lock_token='replacement',codex_claim_token=claim_generation+1,claim_generation=claim_generation+1 WHERE id=$1", [job.id]);
    await expect(put('notes/subscription-lost')).rejects.toMatchObject({ code: 'subscription_owner_lost' });
  })).rejects.toMatchObject({ code: 'subscription_owner_lost' });
  expect(await engine.executeRaw("SELECT request_id FROM persistence_requests WHERE slug='notes/subscription-lost'")).toHaveLength(0);
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

test('CLI grant reaches the durable queue and the production gateway scope', async () => {
  const g = grant(), args = ['submit', 'enrich', '--queue-only', '--params', '{"sourceId":"default"}',
    '--codex-max-attempts', String(g.maxAttempts), '--codex-max-turns', String(g.maxTurns), '--codex-deadline', g.deadline.toISOString(), '--idempotency-key', 'cli-codex'];
  const output: unknown[][] = [], log = spyOn(console, 'log').mockImplementation((...line) => { output.push(line); });
  try {
    await runJobsSubmit({ args: [...args, '--dry-run'], engine, engineOrNull: engine, queue });
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
    expect(await engine.executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(0);
    expect(JSON.stringify(output)).toContain('monetary_cost_usd');
    await runJobsSubmit({ args, engine, engineOrNull: engine, queue });
    await runJobsSubmit({ args, engine, engineOrNull: engine, queue });
    expect(await engine.executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(1);
    const job = (await queue.claim('cli-worker', 60_000, 'default', ['enrich']))!;
    expect(job.spend_authorization).toBeNull();
    expect((await runWithJobSpend(engine, job, ctxFor(job), call)).text).toBe('fixture');
    expect(count()).toBe(1);
  } finally { log.mockRestore(); }
});
test('CLI refuses missing, malformed, enlarged and misplaced subscription allowances before writes', async () => {
  const deadline = grant().deadline.toISOString();
  const base = ['submit', 'enrich', '--queue-only', '--codex-max-attempts', '2', '--codex-max-turns', '2', '--codex-deadline', deadline];
  for (const args of [
    ['submit', 'enrich', '--yes', '--max-usd', '1', '--dry-run'],
    [...base, '--codex-max-turns', '1'],
    base.map(v => v === '2' ? '2junk' : v),
    base.map(v => v === deadline ? '2099-01-01T00:00:00Z' : v),
    base.map(v => v === 'enrich' ? 'lint' : v),
    [...base, '--max-usd', 'off'],
  ]) await expect(runJobsSubmit({ args, engine, engineOrNull: engine, queue })).rejects.toThrow();
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
  expect(await engine.executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(0);
});
test('CLI auxiliary USD cap stays independent of the subscription allowance', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runJobsSubmit({ args: ['submit', 'enrich', '--queue-only', '--codex-max-attempts', '2', '--codex-max-turns', '2',
      '--codex-deadline', grant().deadline.toISOString(), '--max-usd', '0.01'], engine, engineOrNull: engine, queue });
    const job = (await queue.claim('mixed-cli', 60_000, 'default', ['enrich']))!;
    expect(job.spend_authorization?.cap_usd).toBe(0.01);
    expect((await runWithJobSpend(engine, job, ctxFor(job), call)).text).toBe('fixture');
    let dispatched = false;
    await expect(runWithJobSpend(engine, job, ctxFor(job), () => invokeAI({ operation: 'fixture', kind: 'embedding',
      model: 'openai:text-embedding-3-small', maxInputTokens: 10_000_000, maxOutputTokens: 0 },
    async () => { dispatched = true; }, () => null))).rejects.toThrow();
    expect(dispatched).toBe(false);
  } finally { log.mockRestore(); }
});
test('deterministic freshness and stored-fact parsing need no model configuration or grant', async () => {
  // Invalid private config is a tripwire: these jobs must not even consult it.
  writeFileSync(join(root, '.gbrain', 'config.json'), '{invalid');
  for (const name of ['autopilot-cycle', 'extract_facts', 'subagent_aggregator']) {
    const data = name === 'autopilot-cycle' ? { source_id: 'default', phases: SOURCE_FRESHNESS_PHASES } : {};
    await queue.add(name, data, {}, { allowProtectedSubmit: true });
    const job = (await queue.claim(`deterministic-${name}`, 60_000, 'default', [name]))!;
    expect(await runWithJobSpend(engine, job, ctxFor(job), async () => 'deterministic')).toBe('deterministic');
  }
  expect(count()).toBe(0);
});
test('global maintenance and unspecified cycle phases cannot bypass private admission', async () => {
  for (const [name, data] of [['autopilot-global-maintenance', {}], ['autopilot-cycle', {}],
    ['autopilot-cycle', { phases: [] }], ['autopilot-cycle', { phases: ['unknown-phase'] }]] as const) {
    await expect(queue.add(name, data)).rejects.toMatchObject({ code: 'subscription_required' });
  }
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
});
test('the real global scheduler requires explicit file consent and reuses the occurrence allowance', async () => {
  const slot = new Date().toISOString(), opts = { repoPath: '/synthetic', slot, timeoutMs: 300000, jsonMode: false, log: () => {} };
  await expect(dispatchGlobalMaintenance(engine, queue, opts)).rejects.toMatchObject({ code: 'subscription_required' });
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ private_codex: { mode: 'strict', model: 'codex-cli:gpt-test', bin,
    scheduled_jobs: { 'autopilot-global-maintenance': { maxAttempts: 2, maxTurns: 2, windowMs: 600000 } } } }));
  expect((await dispatchGlobalMaintenance(engine, queue, opts)).dispatched).toBe(true);
  expect((await dispatchGlobalMaintenance(engine, queue, opts)).coalesced).toBe(true);
  const [run] = await engine.executeRaw<{ deadline: Date | string; max_attempts: number }>('SELECT deadline,max_attempts FROM codex_subscription_runs');
  expect(new Date(run!.deadline).getTime()).toBe(Date.parse(slot) + 600000);
  const job = (await queue.claim('scheduled', 60000, 'default', ['autopilot-global-maintenance']))!;
  expect((await runWithJobSpend(engine, job, ctxFor(job), call)).text).toBe('fixture');
  // A later occurrence cannot extend a still-active coalesced job's deadline.
  const later = new Date(Date.parse(slot) + 1).toISOString();
  await expect(dispatchGlobalMaintenance(engine, queue, { ...opts, slot: later })).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
  expect(await engine.executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(1);
});
test('schedule limits reject malformed opt-ins, expired slots and inferred authorization', async () => {
  const write = (scheduled_jobs: unknown) => writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({
    private_codex: { mode: 'strict', model: 'codex-cli:gpt-test', bin, scheduled_jobs } }));
  for (const scheduled_jobs of [[], { unknown: {} }, { 'autopilot-cycle': { maxAttempts: 1, maxTurns: 2, windowMs: 600000 } },
    { 'autopilot-cycle': { maxAttempts: 1, maxTurns: 1, windowMs: 86400001 } },
    { 'autopilot-cycle': { maxAttempts: 1, maxTurns: 1, windowMs: 600000, auxiliaryMaxUsd: 0 } }]) {
    write(scheduled_jobs); expect(readPrivateCodexConfig).toThrow('private_config_invalid');
  }
  write({ 'autopilot-cycle': { maxAttempts: 1, maxTurns: 1, windowMs: 600000, auxiliaryMaxUsd: 0.02 } });
  const trusted = scheduledCodexSubmit('autopilot-cycle', {}, new Date().toISOString());
  expect(trusted?.spendAuthorization?.cap_usd).toBe(0.02);
  expect(() => scheduledCodexSubmit('autopilot-cycle', {}, new Date(Date.now() - 700000).toISOString())).toThrow('subscription_exhausted');
  expect(scheduledCodexSubmit('autopilot-cycle', { phases: SOURCE_FRESHNESS_PHASES }, 'unused')).toBeUndefined();
});
test('cycle budgets require subscription authority and never fabricate prices, even with overrides', async () => {
  const estimate = { modelId: 'codex-cli:gpt-test', estimatedInputTokens: 100, maxOutputTokens: 100 };
  const meter = new BudgetMeter({ budgetUsd: 0.01, phase: 'fixture', auditPath: join(root, 'cycle-budget.jsonl'),
    allowUnpriced: true, pricingOverrides: { 'codex-cli:gpt-test': { input: 0, output: 0 } } });
  expect(meter.check(estimate)).toMatchObject({ allowed: false, billing: 'subscription', estimatedCostUsd: null, cumulativeCostUsd: null });
  const job = await claimed();
  await runWithJobSpend(engine, job, ctxFor(job), async () => {
    expect(meter.check(estimate)).toMatchObject({ allowed: true, estimatedCostUsd: null });
    expect((await call()).text).toBe('fixture');
    expect((await call()).text).toBe('fixture');
    // Cycle preflight does not replace the gateway's durable exhaustion gate.
    await expect(call()).rejects.toMatchObject({ code: 'subscription_exhausted' });
    expect(meter.check({ modelId: 'openai:gpt-4o', estimatedInputTokens: 10000000, maxOutputTokens: 10000 }).allowed).toBe(false);
  });
  expect(meter.totalSpent).toBeNull();
  const entries = readFileSync(join(root, 'cycle-budget.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
  expect(entries.filter(e => e.event === 'subscription_preflight').every(e => e.estimated_cost_usd === null && e.remaining_quota === null)).toBe(true);
});
}
