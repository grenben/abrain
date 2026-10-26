import { expect, spyOn } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { submitCodexSkillOpt } from '../../src/core/skillopt/codex-job.ts';
import { runSkillOptJob, type SkillOptJobInput } from '../../src/core/skillopt/job.ts';
import { resolveSkillOptModels } from '../../src/core/skillopt/models-plan.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { buildJobContext } from '../../src/core/minions/job-context.ts';
import { runWithJobSpend } from '../../src/core/minions/spend-authorization.ts';
import * as store from '../../src/core/skillopt/codex-run-store.ts';
import * as files from '../../src/core/skillopt/codex-run-files.ts';
import * as drafts from '../../src/core/skillopt/codex-bootstrap-files.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

const [mode, point, root, digest] = process.argv.slice(2);
if (!['seed', 'crash', 'recover'].includes(mode) || !['checkpoint', 'result', 'file'].includes(point)) throw new Error('Invalid fixture phase');
const config = JSON.parse(readFileSync(join(root, 'home', '.gbrain', 'config.json'), 'utf8'));
const unregister = __registerCodexFixtureForTests(config.private_codex.bin, digest);
globalThis.fetch = (() => { throw new Error('forbidden network'); }) as unknown as typeof fetch;
const databaseUrl = process.env.CODEX_OPTIMIZER_CRASH_DATABASE_URL;
if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
const engine = databaseUrl ? new PostgresEngine() : new PGLiteEngine();
if (databaseUrl) await (engine as PostgresEngine).connect({ database_url: databaseUrl, poolSize: 2 });
else await (engine as PGLiteEngine).connect({ database_path: join(root, 'database') });
const queue = new MinionQueue(engine), directory = join(root, 'skills');
const skill = join(directory, 'synthetic-skill', 'SKILL.md');
const initialText = '---\nname: synthetic-skill\ndescription: Synthetic benchmark skill.\n---\n# Response\n\nPrefer brevity.\n';
const finalText = initialText.replace('Prefer brevity.', 'Always cite evidence.');
const scope = () => ({ operationContext: { engine, remote: false, sourceId: 'default', config: {} as never, logger: {} as never, dryRun: false },
  codex: { allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'] } });
const countCalls = () => readFileSync(join(root, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).length;

async function seed(): Promise<void> {
  await engine.initSchema();
  mkdirSync(join(directory, 'synthetic-skill'), { recursive: true }); writeFileSync(skill, initialText);
  const benchmarkPath = join(root, 'benchmark.jsonl');
  writeFileSync(benchmarkPath, Array.from({ length: 15 }, (_, i) => JSON.stringify({ task_id: `case-${String(i).padStart(2, '0')}`,
    task: `Synthetic task ${i}.`, judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'evidence' }] } })).join('\n'));
  const input: SkillOptJobInput = { skillsDir: directory, skillName: 'synthetic-skill', benchmarkPath, epochs: 1, batchSize: 5,
    lr: 1, lrSchedule: 'constant', split: [1, 1, 1], models: await resolveSkillOptModels(engine), modelFlags: {}, modelsStrict: false,
    reflectMaxTokens: 2048, mode: 'patch', dryRun: false, noMutate: false, allowMutateBundled: false, bootstrapReviewed: false,
    maxCostUsd: 1, maxCostSource: 'user', maxRuntimeMin: 20, force: true };
  const grant = { requestId: '123e4567-e89b-42d3-a456-426614174000', maxAttempts: 150, maxTurns: 150, deadline: new Date(Date.now() + 3600000) };
  const job = await submitCodexSkillOpt(engine, input, scope(), grant);
  writeFileSync(join(root, 'submission.json'), JSON.stringify({ input, grant, jobId: job.id }));
}

async function pause(): Promise<never> {
  console.log('OPTIMIZER_RETAINED');
  await new Promise<void>(() => { setInterval(() => {}, 1000); });
  throw new Error('unreachable');
}

function injectCrash(): void {
  if (point === 'checkpoint') {
    const original = store.saveOptimizerCheckpoint;
    spyOn(store, 'saveOptimizerCheckpoint').mockImplementationOnce(async (...args) => { await original(...args); await pause(); });
  } else if (point === 'result') {
    const original = store.saveOptimizerResult;
    spyOn(store, 'saveOptimizerResult').mockImplementationOnce(async (...args) => { await original(...args); await pause(); });
  } else {
    const original = files.publishOptimizerFile;
    spyOn(files, 'publishOptimizerFile').mockImplementationOnce(async (...args) => { await original(...args); await pause(); });
  }
}

async function recoverLease(jobId: number) {
  const job = await queue.getJob(jobId);
  expect(job).toMatchObject({ status: 'active', lock_token: 'killed-optimizer' });
  expect(await queue.claim('premature-worker', 900000, 'default', ['skillopt'])).toBeNull();
  const [run] = await engine.executeRaw<{ run_id: string; input_hash: string; result: unknown }>('SELECT run_id,input_hash,result FROM codex_skillopt_runs');
  expect(run).toBeDefined();
  expect(run!.result === null).toBe(point === 'checkpoint');
  expect(countCalls()).toBe(point === 'checkpoint' ? 15 : 66);
  expect(readFileSync(skill, 'utf8')).toBe(point === 'file' ? finalText : initialText);
  const grants = await engine.executeRaw('SELECT run_id,max_attempts,max_turns,deadline FROM codex_subscription_runs WHERE parent_run_id IS NULL');
  expect(grants).toHaveLength(1);
  expect(await engine.executeRaw("SELECT attempt_id FROM codex_subscription_attempts WHERE state IN ('active','unresolved')")).toHaveLength(0);
  // Only simulate elapsed leases after the OS kill; never clear progress or refund attempts.
  await engine.executeRaw("UPDATE minion_jobs SET lock_until=now()-interval '1 second' WHERE id=$1 AND lock_token='killed-optimizer'", [jobId]);
  await engine.executeRaw("UPDATE codex_skillopt_runs SET lease_until=now()-interval '1 second' WHERE run_id=$1", [run!.run_id]);
  const stalled = await queue.handleStalled(0);
  expect(stalled.requeued.map(row => row.id)).toEqual([jobId]); expect(stalled.dead).toHaveLength(0);
  const [claim] = await engine.executeRaw<{ claim_generation: string | number }>('SELECT claim_generation FROM minion_jobs WHERE id=$1', [jobId]);
  return { run: run!, grants, generation: Number(claim!.claim_generation) };
}

async function execute(): Promise<void> {
  const saved = JSON.parse(readFileSync(join(root, 'submission.json'), 'utf8'));
  const before = mode === 'recover' ? await recoverLease(saved.jobId) : undefined;
  const job = await queue.claim(mode === 'crash' ? 'killed-optimizer' : 'recovery-optimizer', 900000, 'default', ['skillopt']);
  expect(job?.id).toBe(saved.jobId);
  const context = buildJobContext(engine, queue, job!, job!.lock_token!, new AbortController().signal, new AbortController().signal);
  const originalWrite = drafts.writeBootstrapDraft;
  spyOn(drafts, 'writeBootstrapDraft').mockImplementation((...args) => {
    originalWrite(...args); appendFileSync(join(root, 'writes.jsonl'), JSON.stringify({ effect: 'skill' }) + '\n');
  });
  if (mode === 'crash') injectCrash();
  const result = await runWithJobSpend(engine, job!, context, () => runSkillOptJob(engine, job!.data, context));
  expect(mode).toBe('recover');
  expect(result).toMatchObject({ outcome: 'accepted', mutated_skill_file: true, cost_usd: null,
    receipt: { baseline_sel_score: 0, best_sel_score: 1, test_score: 1, subscription: { attempts: 66, accepted_turns: 66 } } });
  expect((await queue.completeJob(job!.id, job!.lock_token!, { ...result }))?.status).toBe('completed');
  const [claim] = await engine.executeRaw<{ claim_generation: string | number }>('SELECT claim_generation FROM minion_jobs WHERE id=$1', [job!.id]);
  expect(Number(claim!.claim_generation)).toBeGreaterThan(before!.generation);
  expect(await engine.executeRaw('SELECT run_id,input_hash,state FROM codex_skillopt_runs')).toEqual([{ run_id: before!.run.run_id, input_hash: before!.run.input_hash, state: 'complete' }]);
  expect(await engine.executeRaw('SELECT run_id,max_attempts,max_turns,deadline FROM codex_subscription_runs WHERE parent_run_id IS NULL')).toEqual(before!.grants);
  const [usage] = await engine.executeRaw<{ attempts: number; accepted_turns: number }>('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE parent_run_id IS NULL');
  expect(Number(usage!.attempts)).toBe(66); expect(Number(usage!.accepted_turns)).toBe(66);
  expect(await engine.executeRaw('SELECT attempt_id FROM codex_subscription_attempts')).toHaveLength(66);
  expect(readFileSync(skill, 'utf8')).toBe(finalText);
  expect((await submitCodexSkillOpt(engine, saved.input, scope(), { ...saved.grant, deadline: new Date(saved.grant.deadline) })).id).toBe(saved.jobId);
  expect(await engine.executeRaw('SELECT job_id FROM codex_skillopt_submissions')).toHaveLength(1);
  expect(countCalls()).toBe(66);
  console.log('OPTIMIZER_RECOVERED');
}

try { if (mode === 'seed') await seed(); else await execute(); }
finally { unregister(); await engine.disconnect(); }
