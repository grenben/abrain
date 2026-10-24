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
import { __setEmbedTransportForTests, chat, configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
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
import { withScheduledNightlyProbe } from '../../src/commands/nightly-probe-subscription.ts';
import { resolveNightlyProbeModelRoutes } from '../../src/core/cycle/nightly-probe-routes.ts';
import { resolveNightlyProbeSearchConfigSnapshot } from '../../src/core/cycle/nightly-probe-search-config.ts';
import { runCrossModalBatchForProbe } from '../../src/core/cycle/nightly-probe-adapters.ts';
import { runNightlyQualityProbe } from '../../src/core/cycle/nightly-quality-probe.ts';
import { readRecentQualityProbeEvents } from '../../src/core/audit-quality-probe.ts';
import { runNightlyQualityProbeStep } from '../../src/commands/autopilot-probes.ts';

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
const reply=readFileSync(${JSON.stringify(replyPath)},'utf8').replaceAll('{{slug}}',slug);
let text=reply.startsWith('__RAW_JSON__')?reply.slice('__RAW_JSON__'.length):JSON.stringify({text:reply});
if(reply==='__NIGHTLY_SCHEMA__'){
  const schema=JSON.parse(readFileSync(arg('--output-schema'),'utf8'));
  const fields=schema.properties||{};
  let value;
  if(fields.claims)value={evidence_hash:fields.evidence_hash.enum[0],claims:[]};
  else if(fields.citations){
    const hit=input.match(/<chat_session id="([^"]+)"[^>]*>\\n([\\s\\S]*?)\\n<\\/chat_session>/);
    value=hit?{evidence_hash:fields.evidence_hash.enum[0],answer:'widget-co',status:'answered',citations:[{session_id:hit[1],quote:hit[2].trim().slice(0,20)}]}:
      {evidence_hash:fields.evidence_hash.enum[0],answer:'The information is not available in the retrieved sessions.',status:'abstained',citations:[]};
  }else if(fields.scores)value={scores:Object.fromEntries(Object.keys(fields.scores.properties).map(k=>[k,{score:8,feedback:'Synthetic score.'}])),overall:8,improvements:Array.from({length:10},(_,i)=>'Improve detail '+i)};
  else throw Error('unrecognized nightly schema '+Object.keys(fields).join(','));
  text=JSON.stringify(value);
}
writeFileSync(arg('--output-last-message'),text);
for(const e of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:2,output_tokens:3}}])console.log(JSON.stringify(e));
`;
  writeFileSync(bin, script, { mode: 0o700 }); writeFileSync(replyPath, 'fixture');
  unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(script).digest('hex'));
  ({ engine, cleanup } = await createEngine());
  await engine.initSchema(); queue = new MinionQueue(engine);
});
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM codex_proposal_cache');
  await engine.executeRaw('DELETE FROM codex_eval_results');
  await engine.executeRaw('DELETE FROM codex_eval_runs');
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
test('a disabled nightly role refuses scheduling before any durable allowance', async () => {
  const models = { utility: 'codex-cli:gpt-test', reasoning: 'codex-cli:gpt-test', deep: 'codex-cli:gpt-test', subagent: 'codex-cli:gpt-test' };
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ private_codex: { mode: 'strict', bin, models, enabled_roles: ['longmemeval-reader', 'longmemeval-extractor'] } }));
  let started = false;
  await expect(withScheduledNightlyProbe(engine, { fixturePath: join(root, 'unused'), startedAt: new Date(), maxUsd: 1 }, async () => {
    started = true; return { outcome: 'pass', exit_code: 0 };
  })).rejects.toMatchObject({ code: 'private_role_disabled' });
  expect(started).toBe(false); expect(count()).toBe(0);
  expect(await engine.executeRaw('SELECT run_id FROM codex_subscription_runs')).toEqual([]);
});
test('nightly occurrence reuses one immutable allowance and rejects a changed fixture', async () => {
  const limits = { maxAttempts: 2, maxTurns: 2, windowMs: 600_000, auxiliaryMaxUsd: 0.01 };
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({
    private_codex: { mode: 'strict', models: { utility: 'codex-cli:gpt-test', reasoning: 'codex-cli:gpt-test', deep: 'codex-cli:gpt-test', subagent: 'codex-cli:gpt-test' }, enabled_roles: ['nightly-probes', 'longmemeval-reader', 'longmemeval-extractor', 'longmemeval-judge'], bin,
      scheduled_jobs: { 'nightly-quality-probe': limits } } }));
  const fixturePath = join(root, 'nightly-synthetic.jsonl');
  writeFileSync(fixturePath, '{"question":"synthetic"}\n');
  const scope = { fixturePath, startedAt: new Date(), maxUsd: 0.01,
    searchConfigSnapshot: await resolveNightlyProbeSearchConfigSnapshot(engine),
    modelRoutes: await resolveNightlyProbeModelRoutes(engine) };
  const run = () => withScheduledNightlyProbe(engine, scope, async () => {
    await chat({ privateRole: 'nightly-probes', messages: [{ role: 'user', content: 'synthetic fixture' }] }); return { outcome: 'pass', exit_code: 0 };
  });
  await run();
  const [first] = await engine.executeRaw<{ deadline: Date | string }>(
    "SELECT deadline FROM codex_subscription_runs WHERE run_id LIKE 'codex-nightly-quality:%'");
  await run();
  const [retry] = await engine.executeRaw<{ deadline: Date | string; attempts: number; accepted_turns: number }>(
    "SELECT deadline,attempts,accepted_turns FROM codex_subscription_runs WHERE run_id LIKE 'codex-nightly-quality:%'");
  expect(new Date(retry!.deadline).getTime()).toBe(new Date(first!.deadline).getTime());
  expect(retry).toMatchObject({ attempts: 2, accepted_turns: 2 });
  await expect(run()).rejects.toMatchObject({ code: 'subscription_exhausted' });
  writeFileSync(fixturePath, '{"question":"changed"}\n');
  await expect(run()).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
  expect(count()).toBe(2);
});
test('nightly private admission requires an explicit schedule and auxiliary cap before inference', async () => {
  const fixturePath = join(root, 'nightly-no-grant.jsonl');
  writeFileSync(fixturePath, '{"question":"synthetic"}\n');
  const scope = { fixturePath, startedAt: new Date(), maxUsd: 0.01,
    searchConfigSnapshot: await resolveNightlyProbeSearchConfigSnapshot(engine),
    modelRoutes: await resolveNightlyProbeModelRoutes(engine) };
  await expect(withScheduledNightlyProbe(engine, scope, async () => {
    await chat({ privateRole: 'nightly-probes', messages: [{ role: 'user', content: 'synthetic fixture' }] }); return { outcome: 'pass', exit_code: 0 };
  })).rejects.toMatchObject({ code: 'subscription_required' });
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({
    private_codex: { mode: 'strict', models: { utility: 'codex-cli:gpt-test', reasoning: 'codex-cli:gpt-test', deep: 'codex-cli:gpt-test', subagent: 'codex-cli:gpt-test' }, enabled_roles: ['nightly-probes', 'longmemeval-reader', 'longmemeval-extractor', 'longmemeval-judge'], bin,
      scheduled_jobs: { 'nightly-quality-probe': { maxAttempts: 1, maxTurns: 1, windowMs: 600_000 } } } }));
  await expect(withScheduledNightlyProbe(engine, scope, async () => {
    await chat({ privateRole: 'nightly-probes', messages: [{ role: 'user', content: 'synthetic fixture' }] }); return { outcome: 'pass', exit_code: 0 };
  })).rejects.toMatchObject({ code: 'subscription_auxiliary_budget_required' });
  expect(count()).toBe(0);
  const runs = await engine.executeRaw('SELECT run_id FROM codex_subscription_runs');
  expect(runs).toEqual([]);
});
test('private cross-modal judge validates three sequential Codex proposals before acceptance', async () => {
  const limits = { maxAttempts: 3, maxTurns: 3, windowMs: 600_000, auxiliaryMaxUsd: 0.01 };
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({
    private_codex: { mode: 'strict', models: { utility: 'codex-cli:gpt-test', reasoning: 'codex-cli:gpt-test', deep: 'codex-cli:gpt-test', subagent: 'codex-cli:gpt-test' }, enabled_roles: ['nightly-probes', 'longmemeval-reader', 'longmemeval-extractor', 'longmemeval-judge'], bin,
      scheduled_jobs: { 'nightly-quality-probe': limits } } }));
  const fixturePath = join(root, 'nightly-judge.jsonl');
  writeFileSync(fixturePath, '{"question":"synthetic"}\n');
  writeFileSync(replyPath, '__RAW_JSON__' + JSON.stringify({ scores: {
    CORRECTNESS: { score: 8, feedback: 'Accurate.' }, DIRECTNESS: { score: 8, feedback: 'Direct.' } }, overall: 8,
    improvements: Array.from({ length: 10 }, (_, i) => `${i + 1}. Clarify the answer.`) }));
  const routes = await resolveNightlyProbeModelRoutes(engine);
  expect(Object.values(routes.slots)).toEqual(['codex-cli:gpt-test', 'codex-cli:gpt-test', 'codex-cli:gpt-test']);
  const batchPath = join(root, 'nightly-judge-batch.jsonl'), summaryPath = join(root, 'nightly-judge-summary.json');
  writeFileSync(batchPath, JSON.stringify({ question_id: 'q1', question: 'Where?', hypothesis: 'widget-co', answer: 'widget-co' }) + '\n');
  await withScheduledNightlyProbe(engine, { fixturePath, startedAt: new Date(), maxUsd: 0.01,
    searchConfigSnapshot: await resolveNightlyProbeSearchConfigSnapshot(engine), modelRoutes: routes }, async () => {
    const result = await runCrossModalBatchForProbe({ batchPath, summaryPath, maxUsd: 0.01, modelRoutes: routes });
    expect(result.summary.pass_count).toBe(1);
    expect(result.summary.panel?.distinct_models).toBe(1);
    return { outcome: 'inconclusive', exit_code: 2 };
  });
  const [run] = await engine.executeRaw<{ attempts: number; accepted_turns: number }>(
    "SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id LIKE 'codex-nightly-quality:%'");
  expect(run).toMatchObject({ attempts: 3, accepted_turns: 3 });
  expect(count()).toBe(3);
});
test('invalid private judge scores consume attempts but never accepted turns', async () => {
  const limits = { maxAttempts: 3, maxTurns: 1, windowMs: 600_000, auxiliaryMaxUsd: 0.01 };
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({
    private_codex: { mode: 'strict', models: { utility: 'codex-cli:gpt-test', reasoning: 'codex-cli:gpt-test', deep: 'codex-cli:gpt-test', subagent: 'codex-cli:gpt-test' }, enabled_roles: ['nightly-probes', 'longmemeval-reader', 'longmemeval-extractor', 'longmemeval-judge'], bin,
      scheduled_jobs: { 'nightly-quality-probe': limits } } }));
  const fixturePath = join(root, 'nightly-invalid.jsonl'), batchPath = join(root, 'nightly-invalid-batch.jsonl');
  writeFileSync(fixturePath, '{"question":"synthetic"}\n');
  writeFileSync(batchPath, JSON.stringify({ question_id: 'q1', question: 'Where?', hypothesis: 'widget-co', answer: 'widget-co' }) + '\n');
  writeFileSync(replyPath, '__RAW_JSON__' + JSON.stringify({ scores: {
    CORRECTNESS: { score: 99, feedback: 'Invalid.' }, DIRECTNESS: { score: 8, feedback: 'Direct.' } }, overall: 8,
    improvements: Array.from({ length: 10 }, (_, i) => `${i + 1}. Clarify the answer.`) }));
  const routes = await resolveNightlyProbeModelRoutes(engine);
  await withScheduledNightlyProbe(engine, { fixturePath, startedAt: new Date(), maxUsd: 0.01,
    searchConfigSnapshot: await resolveNightlyProbeSearchConfigSnapshot(engine), modelRoutes: routes }, async () => {
    const result = await runCrossModalBatchForProbe({ batchPath, summaryPath: join(root, 'nightly-invalid-summary.json'),
      maxUsd: 0.01, modelRoutes: routes });
    expect(result.summary.inconclusive_count).toBe(1);
    return { outcome: 'inconclusive', exit_code: 2 };
  });
  const [run] = await engine.executeRaw<{ attempts: number; accepted_turns: number }>(
    "SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id LIKE 'codex-nightly-quality:%'");
  expect(run).toMatchObject({ attempts: 3, accepted_turns: 0 });
  expect(count()).toBe(3);
});
test('the scheduled nightly phase records an honest collapsed-panel result under one allowance', async () => {
  const limits = { maxAttempts: 4, maxTurns: 4, windowMs: 600_000, auxiliaryMaxUsd: 0.01 };
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({
    private_codex: { mode: 'strict', models: { utility: 'codex-cli:gpt-test', reasoning: 'codex-cli:gpt-test', deep: 'codex-cli:gpt-test', subagent: 'codex-cli:gpt-test' }, enabled_roles: ['nightly-probes', 'longmemeval-reader', 'longmemeval-extractor', 'longmemeval-judge'], bin,
      scheduled_jobs: { 'nightly-quality-probe': limits } } }));
  const fixturePath = join(root, 'nightly-phase.jsonl'), auditDir = mkdtempSync(join(root, 'nightly-audit-'));
  writeFileSync(fixturePath, '{"question":"Where?"}\n');
  writeFileSync(replyPath, '__RAW_JSON__' + JSON.stringify({ scores: {
    CORRECTNESS: { score: 8, feedback: 'Accurate.' }, DIRECTNESS: { score: 8, feedback: 'Direct.' } }, overall: 8,
    improvements: Array.from({ length: 10 }, (_, i) => `${i + 1}. Clarify the answer.`) }));
  const priorAudit = process.env.GBRAIN_AUDIT_DIR;
  process.env.GBRAIN_AUDIT_DIR = auditDir;
  try {
    const run = () => runNightlyQualityProbe({ isEnabled: () => true, hasEmbeddingProvider: () => true,
      resolveMaxUsd: () => 0.01, resolveBudgetPolicy: async () => ({ capSource: 'user' as const }),
      resolveFixturePath: () => fixturePath,
      resolveSearchConfigSnapshot: () => resolveNightlyProbeSearchConfigSnapshot(engine),
      resolveModelRoutes: () => resolveNightlyProbeModelRoutes(engine),
      withRunAuthorization: (input, work) => withScheduledNightlyProbe(engine, input, work),
      runLongMemEval: async ({ outputPath }) => {
        const judgeReply = readFileSync(replyPath, 'utf8');
        writeFileSync(replyPath, 'synthetic reader');
        await chat({ privateRole: 'nightly-probes', messages: [{ role: 'user', content: 'synthetic fixture' }] });
        writeFileSync(replyPath, judgeReply);
        writeFileSync(outputPath, JSON.stringify({ question_id: 'q1', question: 'Where?',
          hypothesis: 'widget-co', answer: 'widget-co' }) + '\n');
      },
      runCrossModalBatch: runCrossModalBatchForProbe,
      now: () => new Date() });
    const result = await run();
    expect(result.outcome).toBe('inconclusive');
    expect(count()).toBe(4);
    const [audit] = readRecentQualityProbeEvents(1);
    expect(audit).toMatchObject({ outcome: 'inconclusive', reason: 'panel_collapsed',
      distinct_judge_models: 1, distinct_judge_providers: 1 });
    expect((await run()).outcome).toBe('rate_limited');
    expect(count()).toBe(4);
    const [parent] = await engine.executeRaw<{ attempts: number; accepted_turns: number }>(
      "SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id LIKE 'codex-nightly-quality:%'");
    expect(parent).toMatchObject({ attempts: 4, accepted_turns: 4 });
  } finally {
    if (priorAudit === undefined) delete process.env.GBRAIN_AUDIT_DIR; else process.env.GBRAIN_AUDIT_DIR = priorAudit;
  }
});
test('the daemon step runs the native nightly reader, extractor, embedding and judge adapters under one grant', async () => {
  const limits = { maxAttempts: 100, maxTurns: 100, windowMs: 600_000, auxiliaryMaxUsd: 1 };
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({
    private_codex: { mode: 'strict', models: { utility: 'codex-cli:gpt-test', reasoning: 'codex-cli:gpt-test', deep: 'codex-cli:gpt-test', subagent: 'codex-cli:gpt-test' }, enabled_roles: ['nightly-probes', 'longmemeval-reader', 'longmemeval-extractor', 'longmemeval-judge'], bin,
      scheduled_jobs: { 'nightly-quality-probe': limits } } }));
  writeFileSync(replyPath, '__NIGHTLY_SCHEMA__');
  const auditDir = mkdtempSync(join(root, 'nightly-native-audit-'));
  const priorAudit = process.env.GBRAIN_AUDIT_DIR;
  const priorOpenAI = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-synthetic';
  const priorReranker = await engine.getConfig('search.reranker.enabled');
  await engine.setConfig('search.reranker.enabled', 'false');
  let embedCalls = 0;
  configureGateway({ chat_model: 'codex-cli:gpt-test', expansion_model: 'codex-cli:gpt-test',
    embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-synthetic' } });
  __setEmbedTransportForTests((async (params: { values: string[] }) => {
    embedCalls += params.values.length;
    return { embeddings: params.values.map((_, i) => Array.from({ length: 1536 }, (__, j) => ((i + j) % 7) / 7)),
      values: params.values, warnings: [], usage: { tokens: params.values.length } };
  }) as unknown as Parameters<typeof __setEmbedTransportForTests>[0]);
  process.env.GBRAIN_AUDIT_DIR = auditDir;
  try {
    const cfg = { autopilot: { nightly_quality_probe: { enabled: true, max_usd: 1 } } } as unknown as
      Parameters<typeof runNightlyQualityProbeStep>[1];
    await runNightlyQualityProbeStep(engine, cfg);
    const [audit] = readRecentQualityProbeEvents(1);
    expect(audit).toMatchObject({ outcome: 'inconclusive', reason: 'panel_collapsed',
      pass_count: 10, fail_count: 0, distinct_judge_models: 1, distinct_judge_providers: 1 });
    expect(embedCalls).toBeGreaterThan(0);
    expect(count()).toBeGreaterThan(0);
    const [parent] = await engine.executeRaw<{ attempts: number; accepted_turns: number }>(
      "SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id LIKE 'codex-nightly-quality:%'");
    expect(parent!.attempts).toBe(count());
    expect(parent!.accepted_turns).toBe(parent!.attempts);
    const [paid] = await engine.executeRaw<{ total: number }>('SELECT count(*)::int AS total FROM mcp_spend_reservations');
    expect(paid!.total).toBeGreaterThan(0);
  } finally {
    __setEmbedTransportForTests(null);
    if (priorReranker === null) await engine.unsetConfig('search.reranker.enabled');
    else await engine.setConfig('search.reranker.enabled', priorReranker);
    if (priorOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorOpenAI;
    if (priorAudit === undefined) delete process.env.GBRAIN_AUDIT_DIR; else process.env.GBRAIN_AUDIT_DIR = priorAudit;
  }
}, 240_000);
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
// The worker's dispatch guard is too late to prove disabled work never entered the queue.
test('core producer roles refuse disabled queue admission while freshness cycles stay model-free', async () => {
  const models = { utility: 'codex-cli:utility-fixture', reasoning: 'codex-cli:reasoning-fixture', deep: 'codex-cli:deep-fixture', subagent: 'codex-cli:subagent-fixture' };
  const path = join(root, '.gbrain', 'config.json');
  const policy = (enabled_roles: string[]) => writeFileSync(path, JSON.stringify({ private_codex: { mode: 'strict', models, enabled_roles, bin } }));
  policy(['chat']);
  for (const [name, data] of [ ['enrich', { sourceId: 'default' }], ['extract-atoms-drain', {}],
    ['autopilot-cycle', { phases: ['synthesize_concepts'] }], ['contextual_reindex_per_chunk', { expected_source_id: 'default' }] ] as const) {
    await expect(queue.add(name, data, {}, { allowProtectedSubmit: true, codexSubscription: grant() })).rejects.toMatchObject({ code: 'private_role_disabled' });
  }
  expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
  expect(await engine.executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(0);
  policy(['enrichment']);
  await expect(queue.add('enrich', { model: models.utility }, {}, { codexSubscription: grant() })).rejects.toMatchObject({ code: 'private_route_conflict' });
  const valid = await queue.add('enrich', { model: models.reasoning }, {}, { codexSubscription: grant() }); expect(valid.id).toBeGreaterThan(0);
  const fresh = await queue.add('autopilot-cycle', { phases: [...SOURCE_FRESHNESS_PHASES] }, {}, { allowProtectedSubmit: true }); expect(fresh.id).toBeGreaterThan(0);
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
// Scalar route changes above cannot catch revocation or a different tier moving
// while the reasoning model stays unchanged. Exercise the real queue binding.
// Existing queue/worker entrypoints suffice; no additional production seam.
test('tiered job binding rejects changed activation and non-reasoning model pins', async () => {
  const models = { utility: 'codex-cli:utility-test', reasoning: 'codex-cli:gpt-test',
    deep: 'codex-cli:deep-test', subagent: 'codex-cli:action-test' };
  const setPolicy = (enabled_roles = ['chat', 'enrichment'], deep = models.deep) =>
    writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ private_codex: {
      mode: 'strict', bin, models: { ...models, deep }, enabled_roles,
    } }));
  setPolicy();
  const job = await claimed();
  let entered = 0;
  const run = () => runWithJobSpend(engine, job, ctxFor(job), async () => { entered++; });
  // Reordering the same set is not a policy change.
  setPolicy(['enrichment', 'chat']);
  await run(); expect(entered).toBe(1);
  setPolicy(['chat']);
  await expect(run()).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
  setPolicy(['chat', 'enrichment'], 'codex-cli:deep-other');
  await expect(run()).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
  // Reverting to the legacy scalar shape cannot adopt tiered work either.
  config();
  await expect(run()).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
  expect(entered).toBe(1); expect(count()).toBe(0);
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
