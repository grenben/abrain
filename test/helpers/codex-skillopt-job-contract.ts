import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { submitCodexSkillOpt } from '../../src/core/skillopt/codex-job.ts';
import { runSkillOptJob, type SkillOptJobInput } from '../../src/core/skillopt/job.ts';
import { resolveSkillOptModels } from '../../src/core/skillopt/models-plan.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { buildJobContext } from '../../src/core/minions/job-context.ts';
import { runWithJobSpend } from '../../src/core/minions/spend-authorization.ts';
import type { MinionJob } from '../../src/core/minions/types.ts';
import { runSkillOptCommand } from '../../src/commands/skillopt.ts';
import * as store from '../../src/core/skillopt/codex-run-store.ts';
import * as files from '../../src/core/skillopt/codex-run-files.ts';
import { reserveSubscriptionAttempt, settleSubscriptionAttempt } from '../../src/core/ai/subscription-admission.ts';
import { withSkillOptAllowance } from '../../src/core/skillopt/codex-local-grant.ts';
import { runSkillOpt } from '../../src/core/skillopt/orchestrator.ts';
import { skillOptModelOpts } from '../../src/core/skillopt/models-plan.ts';
import { submitCodexSkillOptBatch } from '../../src/core/skillopt/codex-batch-job.ts';
interface Fixture { engine(): BrainEngine; root: string; replies(...values: unknown[]): void; calls(): any[] }
export function codexSkilloptJobContract(f: Fixture) {
  describe('native optimizer background jobs', () => {
    let sequence = 0, dir: string, skill: string, benchmark: string, batchDir: string, queue: MinionQueue;
    const text = '---\nname: synthetic-skill\ndescription: Synthetic benchmark skill.\n---\n# Response\n\nPrefer brevity.\n';
    beforeEach(() => {
      dir = join(f.root, `background-${sequence++}`); mkdirSync(join(dir, 'synthetic-skill'), { recursive: true });
      batchDir = join(f.root, `background-batch-${sequence}`);
      for (const name of ['alpha', 'beta']) mkdirSync(join(batchDir, name), { recursive: true });
      skill = join(dir, 'synthetic-skill', 'SKILL.md'); benchmark = join(dir, 'benchmark.jsonl'); writeFileSync(skill, text);
      writeFileSync(benchmark, Array.from({ length: 15 }, (_, i) => JSON.stringify({ task_id: `case-${String(i).padStart(2, '0')}`,
        task: `Synthetic task ${i}.`, judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'evidence' }] } })).join('\n'));
      for (const name of ['alpha', 'beta']) {
        writeFileSync(join(batchDir, name, 'SKILL.md'), text);
        writeFileSync(join(batchDir, name, 'skillopt-benchmark.jsonl'), readFileSync(benchmark, 'utf8'));
      }
      queue = new MinionQueue(f.engine()); f.replies({ autoOptimizer: true });
    });
    const grant = () => ({ requestId: '123e4567-e89b-42d3-a456-426614174000', maxAttempts: 150, maxTurns: 150, deadline: new Date(Date.now() + 3600000) });
    const scope = () => ({ operationContext: { engine: f.engine(), remote: false, sourceId: 'default', config: {} as never, logger: {} as never, dryRun: false },
      codex: { allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'] } });
    const input = async (extra: Partial<SkillOptJobInput> = {}): Promise<SkillOptJobInput> => ({ skillsDir: dir, skillName: 'synthetic-skill', benchmarkPath: benchmark,
      epochs: 1, batchSize: 5, lr: 1, lrSchedule: 'constant', split: [1, 1, 1], models: await resolveSkillOptModels(f.engine()), modelFlags: {}, modelsStrict: false,
      reflectMaxTokens: 2048, mode: 'patch', dryRun: false, noMutate: true, allowMutateBundled: false, bootstrapReviewed: false,
      maxCostUsd: 1, maxCostSource: 'user', maxRuntimeMin: 20, force: true, ...extra });
    const submit = async (g = grant(), extra: Partial<SkillOptJobInput> = {}) => submitCodexSkillOpt(f.engine(), await input(extra), scope(), g);
    const claim = async () => { const job = await queue.claim(`owner-${Date.now()}`, 900000, 'default', ['skillopt']); if (!job) throw new Error('fixture claim missing'); return job; };
    const execute = (job: MinionJob, abort = new AbortController()) => {
      const context = buildJobContext(f.engine(), queue, job, job.lock_token!, abort.signal, new AbortController().signal);
      return runWithJobSpend(f.engine(), job, context, () => runSkillOptJob(f.engine(), job.data, context));
    };
    test('discovery-enabled queued optimizer preserves its registry and immutable tool scope', async () => {
      const g = grant(), s = scope(), inputOpts = await input();
      s.codex = { ...s.codex, allowedTools: ['get_page', 'list_pages'] };
      const enhanced = { ...s, codex: { ...s.codex, readRegistry: 'codex-discovery-v1' as const } };
      const submitted = await submitCodexSkillOpt(f.engine(), inputOpts, enhanced, g);
      expect(submitted.data.read_registry).toBe('codex-discovery-v1');
      await expect(submitCodexSkillOpt(f.engine(), inputOpts, scope(), g)).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      expect((await execute(await claim()))).toMatchObject({ outcome: 'accepted', cost_usd: null });
      const children = await f.engine().executeRaw<{ registry: string }>("SELECT data->>'read_registry' AS registry FROM minion_jobs WHERE name='subagent'");
      expect(children.length).toBeGreaterThan(0); expect(children.every(r => r.registry === 'codex-discovery-v1')).toBe(true);
      expect((await submitCodexSkillOpt(f.engine(), inputOpts, enhanced, g)).id).toBe(submitted.id); expect(f.calls()).toHaveLength(66);
    });
    test('real worker completes a permanently bound optimizer and its shared child allowance', async () => {
      const g = grant(), submitted = await submit(g);
      expect((await submit(g)).id).toBe(submitted.id); expect(f.calls()).toHaveLength(0);
      const worker = new MinionWorker(f.engine(), { concurrency: 1, pollInterval: 25, healthCheckInterval: 0, maxRssMb: 0 });
      worker.register('skillopt', ctx => runSkillOptJob(f.engine(), ctx.data, ctx)); const running = worker.start();
      try {
        const until = Date.now() + 60000; let row = await queue.getJob(submitted.id);
        while (Date.now() < until && !['completed', 'dead', 'failed'].includes(row!.status)) { await new Promise(r => setTimeout(r, 25)); row = await queue.getJob(submitted.id); }
        expect(row?.status).toBe('completed'); expect(row?.result).toMatchObject({ outcome: 'accepted', cost_usd: null, receipt: { subscription: { attempts: 66 }, final_cost_usd: null } });
        expect(readFileSync(join(dir, 'synthetic-skill', 'skillopt-proposed.md'), 'utf8')).toContain('Always cite evidence.');
        expect((await submit(g)).id).toBe(submitted.id); expect(f.calls()).toHaveLength(66);
        expect(await queue.removeJob(submitted.id)).toBe(false);
        expect(await queue.prune({ olderThan: new Date(Date.now() + 60000), status: ['completed'] })).toBe(0);
      } finally { worker.stop(); await running; }
    });
    test('queued input changes and changed allowance cannot mint new work', async () => {
      const g = grant(); await submit(g);
      await expect(submit({ ...g, maxAttempts: 151 })).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      await expect(submit(g, { epochs: 2 })).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      writeFileSync(skill, text + '\nUnrelated user edit.\n');
      await expect(execute(await claim())).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_skillopt_runs')).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT id FROM minion_jobs')).toHaveLength(1); expect(f.calls()).toHaveLength(0);
    });
    test('direct handler, unsupported protocol and forbidden nested model flags refuse without inference', async () => {
      const submitted = await submit();
      await expect(runSkillOptJob(f.engine(), submitted.data)).rejects.toMatchObject({ code: 'subscription_required' });
      for (const changed of [{ ...submitted.data, optimizer_protocol: 'old' }, { ...submitted.data, model_flags: { optimizer: 'anthropic:claude-sonnet-4-6' } }])
        await expect(queue.add('skillopt', changed, {}, { allowProtectedSubmit: true, codexSubscription: grant() })).rejects.toThrow();
      expect(await f.engine().executeRaw('SELECT id FROM minion_jobs')).toHaveLength(1); expect(f.calls()).toHaveLength(0);
    });
    test('root worker fencing stops old owners and preserves evaluations for the new claim', async () => {
      const submitted = await submit(), old = await claim(), original = store.saveOptimizerCheckpoint;
      const fault = spyOn(store, 'saveOptimizerCheckpoint').mockImplementationOnce(async (...args) => {
        await original(...args); await f.engine().executeRaw("UPDATE minion_jobs SET lock_token='new-owner',codex_claim_token=claim_generation+1,claim_generation=claim_generation+1 WHERE id=$1", [submitted.id]);
      });
      try { await expect(execute(old)).rejects.toMatchObject({ code: 'subscription_owner_lost' }); } finally { fault.mockRestore(); }
      expect(f.calls()).toHaveLength(15); expect(readFileSync(skill, 'utf8')).toBe(text);
      const current = (await queue.getJob(submitted.id))!;
      expect(await execute(current)).toMatchObject({ outcome: 'accepted', cost_usd: null }); expect(f.calls()).toHaveLength(66);
    });
    test('committed file effect with lost acknowledgement reuses the same job and accepted result', async () => {
      const g = grant(), submitted = await submit(g, { noMutate: false }), job = await claim(), original = files.publishOptimizerFile;
      const fault = spyOn(files, 'publishOptimizerFile').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('synthetic worker effect acknowledgement lost'); });
      try { await expect(execute(job)).rejects.toThrow('synthetic worker effect acknowledgement lost'); } finally { fault.mockRestore(); }
      expect(readFileSync(skill, 'utf8')).toContain('Always cite evidence.');
      expect((await submit(g, { noMutate: false })).id).toBe(submitted.id);
      expect(await execute(job)).toMatchObject({ outcome: 'accepted', mutated_skill_file: true }); expect(f.calls()).toHaveLength(66);
    });
    test('exhaustion is a failure and retry retains the exhausted root', async () => {
      const g = { ...grant(), maxAttempts: 2, maxTurns: 2 }; const submitted = await submit(g), job = await claim();
      await expect(execute(job)).rejects.toMatchObject({ code: 'subscription_exhausted' });
      expect((await submit(g)).id).toBe(submitted.id);
      await expect(execute(job)).rejects.toThrow(); expect(f.calls()).toHaveLength(2); expect(readFileSync(skill, 'utf8')).toBe(text);
    });
    test('submission acknowledgement loss recovers the same permanent identity', async () => {
      const g = grant(), engine = f.engine(), original = engine.transaction;
      engine.transaction = async function<T>(this: BrainEngine, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
        const value = await original.call(this, fn) as T;
        if (this === engine) throw new Error('synthetic submit acknowledgement lost');
        return value;
      };
      try { await expect(submit(g)).rejects.toThrow('synthetic submit acknowledgement lost'); } finally { engine.transaction = original; }
      const [row] = await engine.executeRaw<{ job_id: number }>('SELECT job_id FROM codex_skillopt_submissions');
      expect(Number((await submit(g)).id)).toBe(Number(row!.job_id));
      expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(1); expect(f.calls()).toHaveLength(0);
    });
    test('unresolved inference blocks the same job without releasing the shared lane', async () => {
      const g = grant(), submitted = await submit(g), job = await claim();
      const [root] = await f.engine().executeRaw<{ run_id: string }>('SELECT run_id FROM codex_subscription_runs');
      const attempt = await reserveSubscriptionAttempt(f.engine(), { runId: root!.run_id, attemptId: 'synthetic-ambiguous', requestHash: 'a'.repeat(64), timeoutMs: 100 });
      await settleSubscriptionAttempt(f.engine(), attempt, { state: 'unresolved', failureCode: 'termination_unconfirmed' });
      await expect(execute(job)).rejects.toMatchObject({ code: 'subscription_lane_busy' });
      expect((await submit(g)).id).toBe(submitted.id);
      expect(await f.engine().executeRaw('SELECT state FROM codex_subscription_attempts')).toEqual([{ state: 'unresolved' }]); expect(f.calls()).toHaveLength(0);
    });
    test('one request UUID cannot switch between foreground and background allowances', async () => {
      const g = { ...grant(), maxAttempts: 1, maxTurns: 1 };
      const foreground = async (requestId: string) => {
        const opts = await input();
        return withSkillOptAllowance(f.engine(), ['--source', 'default', '--read-prefix', 'notes/*', '--codex-request-id', requestId,
          '--codex-max-attempts', '1', '--codex-max-turns', '1', '--codex-deadline', g.deadline.toISOString()], (_, local) =>
          runSkillOpt({ ...opts, ...skillOptModelOpts(opts.models), ...local, engine: f.engine(), json: true }));
      };
      await submit(g);
      await expect(foreground(g.requestId)).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      const other = '123e4567-e89b-42d3-a456-426614174001';
      await expect(foreground(other)).rejects.toMatchObject({ code: 'subscription_exhausted' });
      await expect(submit({ ...g, requestId: other })).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      expect(f.calls()).toHaveLength(1);
      expect(await f.engine().executeRaw('SELECT job_id FROM codex_skillopt_submissions')).toHaveLength(1);
    });
    test('background CLI submits on PostgreSQL and runs inline on PGLite', async () => {
      const g = grant(), exits: number[] = [];
      const exit = spyOn(process, 'exit').mockImplementation(code => { exits.push(Number(code)); return undefined as never; });
      const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
      try { await runSkillOptCommand(f.engine(), ['synthetic-skill', '--skills-dir', dir, '--benchmark', benchmark, '--epochs', '1', '--batch-size', '5', '--lr', '1',
        '--lr-schedule', 'constant', '--split', '1:1:1', '--reflect-max-tokens', '2048', '--no-mutate', '--force', '--json', '--background',
        '--source', 'default', '--read-prefix', 'notes/*', '--codex-request-id', g.requestId, '--codex-max-attempts', '150', '--codex-max-turns', '150', '--codex-deadline', g.deadline.toISOString()]); }
      finally { exit.mockRestore(); out.mockRestore(); }
      expect(exits).toEqual([0]); expect(f.calls()).toHaveLength(f.engine().kind === 'pglite' ? 66 : 0);
      expect(await f.engine().executeRaw('SELECT job_id FROM codex_skillopt_submissions')).toHaveLength(f.engine().kind === 'pglite' ? 0 : 1);
    });
    test('queued --all preflights every skill and the fenced worker replays the retained batch', async () => {
      if (f.engine().kind === 'pglite') return;
      const g = grant(), exits: number[] = [], output: string[] = [], errors: string[] = [];
      const exit = spyOn(process, 'exit').mockImplementation(code => { exits.push(Number(code)); return undefined as never; });
      const out = spyOn(process.stdout, 'write').mockImplementation(value => { output.push(String(value)); return true; });
      const err = spyOn(process.stderr, 'write').mockImplementation(value => { errors.push(String(value)); return true; });
      const args = ['--all', '--skills-dir', batchDir, '--epochs', '1', '--batch-size', '5', '--lr', '1', '--lr-schedule', 'constant',
        '--split', '1:1:1', '--reflect-max-tokens', '2048', '--no-mutate', '--force', '--background', '--json',
        '--source', 'default', '--read-prefix', 'notes/*', '--codex-request-id', g.requestId, '--codex-max-attempts', '150',
        '--codex-max-turns', '150', '--codex-deadline', g.deadline.toISOString()];
      try { await runSkillOptCommand(f.engine(), args); await runSkillOptCommand(f.engine(), args); }
      finally { exit.mockRestore(); out.mockRestore(); err.mockRestore(); }
      if (exits.some(code => code !== 0)) throw new Error(`queued batch submission error: ${errors.join('').slice(0, 1000)}`);
      expect(exits).toEqual([0, 0]); expect(output.filter(s => s.startsWith('job_id=')).length).toBe(2);
      expect(await f.engine().executeRaw('SELECT job_id FROM codex_skillopt_batch_submissions')).toHaveLength(1);
      expect(await f.engine().executeRaw('SELECT id FROM minion_jobs WHERE name=\'skillopt\'')).toHaveLength(1);
      expect(f.calls()).toHaveLength(0);
      const job = await claim(); const result = await execute(job);
      expect(result).toMatchObject({ billing: 'subscription', cost_usd: null, remaining_quota: null, skills_run: 2, accepted: 2, subscription: { attempts: 132 } });
      const attempts = f.calls().length;
      expect(await execute(job)).toEqual(result); expect(f.calls()).toHaveLength(attempts);
      expect(await f.engine().executeRaw('SELECT state FROM codex_skillopt_batches')).toEqual([{ state: 'complete' }]);
      expect((await f.engine().executeRaw('SELECT attempts FROM codex_subscription_runs WHERE run_id LIKE $1', [`codex-job:${job.id}:%`])).reduce((n, r) => n + Number(r.attempts), 0)).toBe(132);
    });
    test('queued batch preflight rejects a changed benchmark before creating a job', async () => {
      if (f.engine().kind === 'pglite') return;
      writeFileSync(join(batchDir, 'beta', 'skillopt-benchmark.jsonl'), 'malformed');
      const g = grant(), base = await input();
      const { skillName: _skillName, benchmarkPath: _benchmarkPath, ...batchInput } = base;
      await expect(submitCodexSkillOptBatch(f.engine(), { ...batchInput, skillsDir: batchDir }, scope(), g)).rejects.toThrow();
      expect(await f.engine().executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT request_id FROM codex_skillopt_batch_submissions')).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(0);
      expect(f.calls()).toHaveLength(0);
    });
    test('queued worker refuses a benchmark changed after producer preflight', async () => {
      if (f.engine().kind === 'pglite') return;
      const g = grant(), base = await input();
      const { skillName: _skillName, benchmarkPath: _benchmarkPath, ...batchInput } = base;
      await submitCodexSkillOptBatch(f.engine(), { ...batchInput, skillsDir: batchDir }, scope(), g);
      writeFileSync(join(batchDir, 'beta', 'skillopt-benchmark.jsonl'), readFileSync(join(batchDir, 'beta', 'skillopt-benchmark.jsonl'), 'utf8').replace('Synthetic task 0.', 'Changed after enqueue.'));
      await expect(execute(await claim())).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_skillopt_batches')).toHaveLength(0);
      expect(f.calls()).toHaveLength(0);
    });
  });
}
