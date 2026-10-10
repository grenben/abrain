import { beforeAll, beforeEach, afterAll, test, expect, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { runWithJobSpend } from '../../src/core/minions/spend-authorization.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../../src/core/minions/subscription-jobs.ts';
import { buildJobContext } from '../../src/core/minions/job-context.ts';
import type { MinionJob } from '../../src/core/minions/types.ts';
import { makeSubagentHandler } from '../../src/core/minions/handlers/subagent.ts';
import { configureGateway, resetGateway, type ChatResult } from '../../src/core/ai/gateway.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { CODEX_READ_PROTOCOL } from '../../src/core/minions/codex-action-contract.ts';
import * as store from '../../src/core/minions/codex-action-store.ts';
import * as persistence from '../../src/core/minions/handlers/subagent-persistence.ts';
import { runJobInChild } from '../../src/core/minions/child-job-runner.ts';
import { noteChildSubscriptionEnforcement } from '../../src/core/minions/subscription-child.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { codexActionWritesContract } from './codex-action-writes-contract.ts';
import { codexSkilloptRolloutContract } from './codex-skillopt-rollout-contract.ts';

export function codexActionsContract(factory: () => Promise<{ engine: BrainEngine; cleanup?: () => Promise<void> }>) {
  const root = mkdtempSync(join(tmpdir(), 'codex-actions-')), bin = join(root, 'fake.mjs'), control = join(root, 'replies.json'), capture = join(root, 'calls.jsonl');
  const keys = ['HOME', 'GBRAIN_HOME', 'CODEX_HOME'] as const, saved = keys.map(k => [k, process.env[k]] as const), fetch = globalThis.fetch;
  let engine: BrainEngine, queue: MinionQueue, cleanup: (() => Promise<void>) | undefined, unregister: () => void;
  const get = (slug = 'notes/one') => ({ response: { kind: 'tool', name: 'brain_get_page', arguments: { slug } } });
  const final = { response: { kind: 'final', answer: 'The synthetic note recommends checking evidence.' } };
  const calls = () => readFileSync(capture, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s));
  const replies = (...values: unknown[]) => writeFileSync(control, JSON.stringify(values));
  const data = (extra: Record<string, unknown> = {}) => ({ action_protocol: CODEX_READ_PROTOCOL, prompt: 'Read notes/one and summarize.',
    source_id: 'default', allowed_tools: ['get_page'], allowed_slug_prefixes: ['notes/*'], max_turns: 4, no_self_fix: true, ...extra });
  const grant = (max = 8) => ({ maxAttempts: max, maxTurns: max, deadline: new Date(Date.now() + 600000) });
  const ctxFor = (job: MinionJob, controller = new AbortController()) => buildJobContext(engine, queue, job, job.lock_token!, controller.signal, new AbortController().signal);
  const handler = () => makeSubagentHandler({ engine, makeAnthropic: () => { throw new Error('forbidden Anthropic construction'); } });
  const submit = (extra: Record<string, unknown> = {}, max = 8) => queue.add('subagent', data(extra), { max_attempts: 1 }, { allowProtectedSubmit: true, codexSubscription: grant(max) });
  async function claim(extra: Record<string, unknown> = {}, max = 8) {
    await submit(extra, max);
    const job = await queue.claim('owner-one', 60000, 'default', ['subagent']);
    if (!job) throw new Error('fixture job not claimed'); return job;
  }
  const run = (job: MinionJob, ctx = ctxFor(job)) => runWithJobSpend(engine, job, ctx, () => handler()(ctx));
  beforeAll(async () => {
    for (const k of keys) process.env[k] = root;
    globalThis.fetch = (() => { throw new Error('forbidden network'); }) as unknown as typeof fetch;
    mkdirSync(join(root, '.gbrain'));
    writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ private_codex: { mode: 'strict', model: 'codex-cli:gpt-test', bin } }));
    const script = `#!${Bun.which('node')}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const a=process.argv.slice(2),arg=n=>a[a.indexOf(n)+1],schema=JSON.parse(readFileSync(arg('--output-schema'),'utf8')),prompt=readFileSync(0,'utf8');
const count=readFileSync(${JSON.stringify(capture)},'utf8').split('\\n').filter(Boolean).length;
const values=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8')),value=values[Math.min(count,values.length-1)];
appendFileSync(${JSON.stringify(capture)},JSON.stringify({schema,prompt,argv:a})+'\\n');
const text=JSON.stringify(value);writeFileSync(arg('--output-last-message'),text);
for(const e of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed',usage:{input_tokens:30,cached_input_tokens:2,output_tokens:15}}])console.log(JSON.stringify(e));
`;
    writeFileSync(bin, script, { mode: 0o700 }); unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(script).digest('hex'));
    ({ engine, cleanup } = await factory()); await engine.initSchema(); queue = new MinionQueue(engine);
    await engine.setConfig('recall.track_retrieval', 'false');
    await engine.putPage('notes/one', { title: 'Evidence', type: 'note', compiled_truth: 'Check the evidence before drawing a conclusion.', frontmatter: { visibility: 'world' } });
    await engine.putPage('notes/private', { title: 'Hidden', type: 'note', compiled_truth: 'SYNTHETIC_PRIVATE_CANARY', frontmatter: { visibility: 'private' } });
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','Synthetic other source')");
    await engine.putPage('notes/other-only', { title: 'Other', type: 'note', compiled_truth: 'SYNTHETIC_OTHER_SOURCE_CANARY' }, { sourceId: 'other' });
  });
  beforeEach(async () => {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('DELETE FROM codex_skillopt_rollouts');
    await engine.executeRaw('DELETE FROM codex_subscription_attempts'); await engine.executeRaw('DELETE FROM codex_subscription_runs'); await engine.executeRaw('DELETE FROM minion_jobs');
    writeFileSync(capture, ''); replies(get(), final); resetGateway(); configureGateway({ env: {} });
  });
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine?.disconnect(); await cleanup?.(); unregister?.(); resetGateway(); globalThis.fetch = fetch;
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(root, { recursive: true, force: true });
  });
  test('trusted child jobs use distinct ledgers while consuming one parent allowance', async () => {
    const parent = { ...grant(3), runId: 'aggregate-action-root', accountLane: CODEX_JOB_ACCOUNT_LANE };
    await createSubscriptionRun(engine, parent);
    const child = { maxAttempts: 2, maxTurns: 2, deadline: parent.deadline, parentRunId: parent.runId };
    for (let i = 0; i < 2; i++) await queue.add('subagent', data({ prompt: `Read notes/one, task ${i}.` }), { max_attempts: 1 }, { allowProtectedSubmit: true, codexSubscription: child });
    const one = (await queue.claim('group-worker-one', 60000, 'default', ['subagent']))!;
    const two = (await queue.claim('group-worker-two', 60000, 'default', ['subagent']))!;
    replies(get(), final, get(), final);
    expect(await run(one)).toMatchObject({ stop_reason: 'end_turn', cost_usd: null });
    await expect(run(two)).rejects.toMatchObject({ code: 'subscription_exhausted' });
    expect(calls()).toHaveLength(3);
    expect(await engine.executeRaw('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [parent.runId])).toEqual([{ attempts: 3, accepted_turns: 3 }]);
    const rows = await engine.executeRaw<{job_id:number|bigint;gbrain_tool_use_id:string;status:string}>('SELECT job_id,gbrain_tool_use_id::text,status FROM subagent_tool_executions ORDER BY job_id');
    expect(rows.map(r => String(r.job_id))).toEqual([String(one.id), String(two.id)]);expect(rows.every(r => r.status === 'complete')).toBe(true);
    expect(rows[0]!.gbrain_tool_use_id).not.toBe(rows[1]!.gbrain_tool_use_id);
    await expect(run(two)).rejects.toMatchObject({ code: 'subscription_exhausted' });expect(calls()).toHaveLength(3);
  });
  test('job data cannot grant a parent allowance and invalid trusted parents roll back insertion', async () => {
    await expect(submit({ parentRunId: 'model-authored-parent' })).rejects.toThrow('unsupported_job_field');
    await expect(queue.add('subagent', data(), {}, { allowProtectedSubmit: true, codexSubscription: { ...grant(), parentRunId: 'missing-parent' } })).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);expect(calls()).toHaveLength(0);
  });
  test('actual worker executes sequential schema reads with durable canonical history and null cost', async () => {
    const job = await submit(); const worker = new MinionWorker(engine, { concurrency: 1, pollInterval: 25, healthCheckInterval: 0, maxRssMb: 0 });
    worker.register('subagent', handler()); const running = worker.start();
    try {
      const deadline = Date.now() + 10000; let current = await queue.getJob(job.id);
      while (Date.now() < deadline && !['completed', 'dead'].includes(current!.status)) { await new Promise(r => setTimeout(r, 25)); current = await queue.getJob(job.id); }
      expect(current?.status).toBe('completed'); expect(current?.result).toMatchObject({ turns_count: 2, cost_usd: null, pages_written: 0, action_protocol: CODEX_READ_PROTOCOL });
      const [row] = await engine.executeRaw('SELECT * FROM subagent_tool_executions WHERE job_id=$1', [job.id]);
      expect(row).toMatchObject({ message_idx: 1, ordinal: 0, status: 'complete', provider_id: CODEX_READ_PROTOCOL, schema_version: 3 });
      expect(row!.tool_use_id).toBe(row!.gbrain_tool_use_id);
      expect(calls()).toHaveLength(2); expect(calls()[1].prompt).toContain('Check the evidence');
      expect(calls()[0].schema.properties.response.anyOf[1].properties.arguments.properties).toEqual({ slug: { type: 'string', description: 'Page slug.', minLength: 1, maxLength: 512 } });
      expect(calls()[0].argv).toContain('--ephemeral');
    } finally { worker.stop(); await running; }
  });
  test('terminal replay uses saved history without another model call', async () => {
    const job = await claim(); const first = await run(job); expect(await run(job)).toEqual(first); expect(calls()).toHaveLength(2);
    expect(await queue.getJob(job.id)).toMatchObject({ tokens_input: 56, tokens_output: 30, tokens_cache_read: 4 });
  });
  test('crash before action retention charges the attempt but executes nothing', async () => {
    replies(get(), get(), final); const job = await claim();
    const fault = spyOn(store, 'retainCodexAction').mockRejectedValue(new Error('synthetic crash'));
    try { await expect(run(job)).rejects.toThrow('synthetic crash'); } finally { fault.mockRestore(); }
    expect(await engine.executeRaw('SELECT id FROM subagent_tool_executions')).toHaveLength(0);
    expect((await run(job)).turns_count).toBe(2); expect(calls()).toHaveLength(3);
    expect((await engine.executeRaw('SELECT attempts FROM codex_subscription_runs'))[0]!.attempts).toBe(3);
  });
  test('crash after ledger insertion rolls back the assistant action and ledger together', async () => {
    replies(get(), get(), final); const job = await claim(), original = persistence.persistMessage;
    const fault = spyOn(persistence, 'persistMessage').mockImplementation(async (...args) => {
      await original(...args); if (args[2].role === 'assistant') throw new Error('synthetic crash');
    });
    try { await expect(run(job)).rejects.toThrow('synthetic crash'); } finally { fault.mockRestore(); }
    expect(await engine.executeRaw('SELECT id FROM subagent_tool_executions')).toHaveLength(0);
    expect(await engine.executeRaw("SELECT id FROM subagent_messages WHERE role='assistant'")).toHaveLength(0);
    expect((await run(job)).turns_count).toBe(2); expect(calls()).toHaveLength(3);
  });
  test('crash after terminal retention recovers the answer without more inference', async () => {
    const job = await claim(), original = store.retainCodexAction;
    const fault = spyOn(store, 'retainCodexAction').mockImplementation(async (...args) => {
      await original(...args); if (args[3].kind === 'final') throw new Error('synthetic crash');
    });
    try { await expect(run(job)).rejects.toThrow('synthetic crash'); } finally { fault.mockRestore(); }
    expect((await run(job)).result).toBe(final.response.answer); expect(calls()).toHaveLength(2);
  });
  test('crash after action retention resumes the same canonical action before inference', async () => {
    const job = await claim(), original = store.retainCodexAction;
    const fault = spyOn(store, 'retainCodexAction').mockImplementation(async (...args) => { await original(...args); throw new Error('synthetic crash'); });
    try { await expect(run(job)).rejects.toThrow('synthetic crash'); } finally { fault.mockRestore(); }
    const [before] = await engine.executeRaw('SELECT gbrain_tool_use_id,status FROM subagent_tool_executions'); expect(before!.status).toBe('pending');
    expect((await run(job)).stop_reason).toBe('end_turn'); expect(calls()).toHaveLength(2);
    const [after] = await engine.executeRaw('SELECT gbrain_tool_use_id,status FROM subagent_tool_executions'); expect(after).toEqual({ ...before, status: 'complete' });
  });
  test('crash after read before result persistence replays only the safe read', async () => {
    const job = await claim(), fault = spyOn(store, 'settleCodexAction').mockRejectedValue(new Error('synthetic crash'));
    try { await expect(run(job)).rejects.toThrow('synthetic crash'); } finally { fault.mockRestore(); }
    expect(calls()).toHaveLength(1); expect((await run(job)).turns_count).toBe(2); expect(calls()).toHaveLength(2);
  });
  test('crash after result persistence never repeats a completed read', async () => {
    const job = await claim(), original = store.settleCodexAction;
    const fault = spyOn(store, 'settleCodexAction').mockImplementation(async (...args) => { await original(...args); throw new Error('synthetic crash'); });
    try { await expect(run(job)).rejects.toThrow('synthetic crash'); } finally { fault.mockRestore(); }
    const reads = spyOn(engine, 'readPageSnapshot');
    try { expect((await run(job)).stop_reason).toBe('end_turn'); expect(reads).not.toHaveBeenCalled(); } finally { reads.mockRestore(); }
  });
  test('retained identities return the database ID and refuse changed inputs', async () => {
    const job = await claim(), ctx = ctxFor(job);
    await runWithJobSpend(engine, job, ctx, async () => {
      await store.loadCodexActions(engine, ctx, job.data.prompt as string);
      const answer = { model: 'codex-cli:gpt-test', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult;
      const action = { kind: 'tool' as const, name: 'brain_get_page', arguments: { slug: 'notes/one' } };
      await store.retainCodexAction(engine, ctx, 1, action, answer);
      const first = await store.loadCodexActions(engine, ctx, job.data.prompt as string);
      await store.retainCodexAction(engine, ctx, 1, action, answer);
      expect((await store.loadCodexActions(engine, ctx, job.data.prompt as string)).rows[0]!.gbrain_tool_use_id).toBe(first.rows[0]!.gbrain_tool_use_id);
      await expect(store.retainCodexAction(engine, ctx, 1, { ...action, arguments: { slug: 'notes/changed' } }, answer)).rejects.toThrow('identity_conflict');
    }); expect(calls()).toHaveLength(0);
  });
  for (const [label, proposal] of Object.entries({ authority: { response: { ...get().response, source_id: 'other' } },
    operation_id: { response: { ...get().response, id: 'model-id' } }, outside_prefix: get('outside/one'),
    multiple: { response: [get().response, get().response] }, write: { response: { kind: 'tool', name: 'brain_put_page', arguments: { slug: 'notes/new' } } } })) {
    test(`rejects model-authored ${label} before any execution`, async () => {
      replies(proposal); const job = await claim(); await expect(run(job)).rejects.toThrow();
      expect(await engine.executeRaw('SELECT id FROM subagent_tool_executions')).toHaveLength(0);
      expect(await engine.executeRaw("SELECT id FROM subagent_messages WHERE role='assistant'")).toHaveLength(0);
    });
  }
  test('private and cross-source reads persist explicit sanitized failures without leaking content', async () => {
    replies(get('notes/private'), get('notes/other-only'), final); const job = await claim(); expect(await run(job)).toMatchObject({ turns_count: 3, tool_actions_failed: 2 });
    const rows = await engine.executeRaw('SELECT status,output FROM subagent_tool_executions'); expect(rows).toHaveLength(2);
    expect(rows.every(r => r.status === 'failed')).toBe(true);
    const text = JSON.stringify(calls()); expect(text).not.toContain('SYNTHETIC_PRIVATE_CANARY'); expect(text).not.toContain('SYNTHETIC_OTHER_SOURCE_CANARY');
  });
  test('lease theft after read prevents stale result persistence; new worker safely resumes', async () => {
    const job = await claim(), original = store.settleCodexAction;
    const fault = spyOn(store, 'settleCodexAction').mockImplementation(async (...args) => {
      await engine.executeRaw("UPDATE minion_jobs SET lock_token='owner-two',codex_claim_token=claim_generation+1,claim_generation=claim_generation+1 WHERE id=$1", [job.id]);
      return original(...args);
    });
    try { await expect(run(job)).rejects.toMatchObject({ code: 'subscription_owner_lost' }); } finally { fault.mockRestore(); }
    expect((await engine.executeRaw('SELECT status FROM subagent_tool_executions'))[0]!.status).toBe('pending');
    const current = (await queue.getJob(job.id))!; expect((await run(current)).stop_reason).toBe('end_turn'); expect(calls()).toHaveLength(2);
  });
  test('turn and subscription limits stop rather than fabricate final completion', async () => {
    const job = await claim({ max_turns: 1 }); await expect(run(job)).rejects.toThrow('turn_limit'); expect(calls()).toHaveLength(1);
    await engine.executeRaw('DELETE FROM minion_jobs'); writeFileSync(capture, '');
    const limited = await claim({}, 1); await expect(run(limited)).rejects.toMatchObject({ code: 'subscription_exhausted' }); expect(calls()).toHaveLength(1);
  });
  test('direct handler calls require a durable job binding and cancellation cannot settle a result', async () => {
    const job = await claim(); await expect(handler()(ctxFor(job))).rejects.toThrow('job_binding_required'); expect(calls()).toHaveLength(0);
    const controller = new AbortController(), ctx = ctxFor(job, controller), original = store.settleCodexAction;
    const fault = spyOn(store, 'settleCodexAction').mockImplementation(async (...args) => { controller.abort(); return original(...args); });
    try { await expect(run(job, ctx)).rejects.toThrow(); } finally { fault.mockRestore(); }
    expect((await engine.executeRaw('SELECT status FROM subagent_tool_executions'))[0]!.status).toBe('pending');
  });
  test('legacy histories and unexpected ledger effects require reconciliation before inference', async () => {
    const job = await claim(); await engine.executeRaw("INSERT INTO subagent_messages(job_id,message_idx,role,content_blocks) VALUES($1,0,'user','[]'::jsonb)", [job.id]);
    await expect(run(job)).rejects.toThrow('history_protocol'); expect(calls()).toHaveLength(0);
  });
  test('an unknown pending write is never replayed or concealed by further inference', async () => {
    const job = await claim(), ctx = ctxFor(job);
    await runWithJobSpend(engine, job, ctx, async () => {
      await store.loadCodexActions(engine, ctx, job.data.prompt as string);
      await store.retainCodexAction(engine, ctx, 1, { kind: 'tool', name: 'brain_put_page', arguments: { slug: 'notes/one' } },
        { model: 'codex-cli:gpt-test', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult);
    });
    await expect(run(job)).rejects.toThrow('needs_reconciliation'); expect(calls()).toHaveLength(0);
    expect((await engine.executeRaw('SELECT status FROM subagent_tool_executions'))[0]!.status).toBe('pending');
  });
  test('oversize read results produce an explicit failed tool result, never silently truncated evidence', async () => {
    await engine.putPage('notes/large', { type: 'note', title: 'Large synthetic note', compiled_truth: 'x'.repeat(17000) });
    replies(get('notes/large'), final); const job = await claim(); expect((await run(job)).tool_actions_failed).toBe(1);
    expect(calls()[1].prompt).toContain('codex_action_read_failed'); expect(calls()[1].prompt).not.toContain('x'.repeat(100));
  });
  test('queue rejects legacy, write, custom system and unsupported job protocols', async () => {
    for (const extra of [{ action_protocol: undefined }, { action_protocol: 'future' }, { optimizer_protocol: 'future' }, { allowed_tools: ['put_page'] }, { require_writes: true }, { system: 'override' }, { brain_id: 'other' }, { no_self_fix: false }]) await expect(submit(extra)).rejects.toThrow();
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
  });
  test('source incarnation and handler payload changes refuse before inference', async () => {
    const job = await claim(), ctx = ctxFor(job);
    ctx.data = { ...ctx.data, allowed_slug_prefixes: ['other/*'] };
    await expect(run(job, ctx)).rejects.toThrow('identity_conflict');
    await engine.executeRaw("UPDATE sources SET created_at=created_at+interval '1 second' WHERE id='default'");
    await expect(run(job)).rejects.toMatchObject({ code: 'subscription_identity_conflict' }); expect(calls()).toHaveLength(0);
  });
  test('older child protocol refuses a host action job before subprocess dispatch', async () => {
    noteChildSubscriptionEnforcement(['codex-subscription-v1']);
    await expect(runJobInChild({ jobId: 1, jobName: 'subagent', codexAuthorized: true, lockToken: 'unused',
      abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
      invocation: { cmd: '/nonexistent/forbidden', argsPrefix: [] }, tiniPath: '' })).rejects.toMatchObject({ reasonCode: 'child_protocol_incompatible' });
  });
  codexActionWritesContract({ engine: () => engine, root, claim, run, replies, calls, get, final });
  codexSkilloptRolloutContract({ engine: () => engine, replies, calls, get, final });
}
