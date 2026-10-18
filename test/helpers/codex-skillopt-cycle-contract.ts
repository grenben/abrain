import { describe, beforeEach, afterEach, test, expect, spyOn } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runPhaseSkillopt } from '../../src/core/skillopt/cycle-phase.ts';
import * as cycleStore from '../../src/core/skillopt/codex-cycle-store.ts';
import * as batchStore from '../../src/core/skillopt/codex-batch-store.ts';
import * as files from '../../src/core/skillopt/codex-run-files.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription } from '../../src/core/ai/subscription-context.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../../src/core/minions/subscription-jobs.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { buildJobContext } from '../../src/core/minions/job-context.ts';
import { runWithJobSpend } from '../../src/core/minions/spend-authorization.ts';
import { makeAutopilotGlobalMaintenanceHandler } from '../../src/core/minions/handlers/autopilot-global-maintenance.ts';
import { runCycle } from '../../src/core/cycle.ts';
import { runBatchAll } from '../../src/core/skillopt/batch.ts';
import { runRollout } from '../../src/core/skillopt/rollout.ts';
interface Fixture { engine(): BrainEngine; root: string; replies(...values: unknown[]): void; calls(): any[] }
export function codexSkilloptCycleContract(f: Fixture) {
  describe('scheduled native Codex optimizer cycle', () => {
    let seq = 0, dir: string;
    const text = '---\nname: synthetic-skill\ndescription: Synthetic benchmark skill.\n---\n# Response\n\nPrefer brevity.\n';
    const benchmark = Array.from({ length: 50 }, (_, i) => JSON.stringify({ task_id: `task-${i}`, task: 'Give a useful answer.', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'evidence' }] } })).join('\n');
    const config = (extra = {}) => ({ sourceId: 'default', skillsDir: dir, allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'], maxSkillsPerCycle: 1, maxAttemptsPerSkill: 300, maxTurnsPerSkill: 300, ...extra });
    const save = (extra = {}) => f.engine().setConfig('cycle.skillopt.codex', JSON.stringify(config(extra)));
    const grant = (runId = 'scheduled-optimizer', max = 300) => createSubscriptionRun(f.engine(), { runId, accountLane: CODEX_JOB_ACCOUNT_LANE,
      maxAttempts: max, maxTurns: max, deadline: new Date(Date.now() + 3600000) });
    const run = (runId = 'scheduled-optimizer', extra = {}) => withCodexSubscription({ engine: f.engine(), runId }, () => runPhaseSkillopt({ engine: f.engine(), ...extra }));
    const row = (runId = 'scheduled-optimizer') => cycleStore.readOptimizerCycle(f.engine(), runId);
    const skill = (name: string) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, 'SKILL.md'), text); writeFileSync(join(dir, name, 'skillopt-benchmark.jsonl'), benchmark); };
    beforeEach(async () => {
      dir = join(f.root, `cycle-${seq++}`); skill('alpha'); await save();
      await f.engine().setConfig('cycle.skillopt.enabled', 'true');
      await f.engine().setConfig('skillopt.reflect_max_tokens', '2048');
      f.replies({ autoOptimizer: true, cycleOptimizer: true });
    });
    afterEach(async () => {
      await f.engine().executeRaw("DELETE FROM config WHERE key LIKE 'cycle.skillopt.%' OR key IN ('skillopt.reflect_max_tokens','autopilot.last_global_at','autopilot.global_maintenance.progress')");
    });
    test('real cycle dispatcher completes native proposals, replays receipts and applies source cooldown', async () => {
      await grant();
      const result = await withCodexSubscription({ engine: f.engine(), runId: 'scheduled-optimizer' }, () => runCycle(f.engine(), { brainDir: null, phases: ['skillopt'], pull: false }));
      expect(result.phases.find(p => p.phase === 'skillopt')).toMatchObject({ status: 'ok', details: { skills_run: 1, accepted: 1, cost_usd: null } });
      const calls = f.calls().length; expect(calls).toBeGreaterThan(100); expect(calls).toBeLessThan(300);
      expect(readFileSync(join(dir, 'alpha', 'SKILL.md'), 'utf8')).toBe(text);
      expect(readFileSync(join(dir, 'alpha', 'skillopt-proposed.md'), 'utf8')).toContain('Always cite evidence.');
      expect((await row())?.state).toBe('complete');
      const stamp = await f.engine().executeRaw('SELECT settled_at FROM codex_skillopt_cycles');
      skill('beta'); expect(await run()).toMatchObject({ status: 'ok', details: { skills_run: 1 } });
      expect(f.calls()).toHaveLength(calls); expect((await row())?.selection).toEqual(['alpha']);
      expect(await f.engine().executeRaw('SELECT settled_at FROM codex_skillopt_cycles')).toEqual(stamp);
      renameSync(join(dir, 'beta'), join(f.root, `hidden-${seq}`));
      await grant('next-cycle'); expect(await run('next-cycle')).toMatchObject({ status: 'ok', details: { skills_run: 0 } });
      expect(f.calls()).toHaveLength(calls); expect(await f.engine().getConfig('cycle.skillopt.last_run.alpha')).toBeNull();
    });
    test('disabled and dry-run paths do not require a grant or persist cycle state', async () => {
      await f.engine().setConfig('cycle.skillopt.enabled', 'false');
      expect(await runPhaseSkillopt({ engine: f.engine() })).toMatchObject({ status: 'skipped', details: { reason: 'feature_flag_off' } });
      expect(await runPhaseSkillopt({ engine: f.engine(), once: true, dryRun: true })).toMatchObject({ status: 'skipped', details: { candidates: 1 } });
      expect(await f.engine().executeRaw('SELECT * FROM codex_skillopt_cycles')).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT * FROM codex_subscription_runs')).toHaveLength(0); expect(f.calls()).toHaveLength(0);
    });
    test('USD caps alone and conflicting source scope cannot admit calls', async () => {
      await f.engine().setConfig('cycle.skillopt.brain_wide_cap_usd', '20');
      expect(await runPhaseSkillopt({ engine: f.engine() })).toMatchObject({ status: 'fail', details: { reason: 'subscription_required', cost_usd: null } });
      await grant(); expect(await run('scheduled-optimizer', { sourceId: 'other' })).toMatchObject({ status: 'fail', details: { reason: 'invalid_params' } });
      await save({ allowedTools: ['shell'] }); expect((await run()).status).toBe('fail');
      expect(await f.engine().executeRaw('SELECT * FROM codex_skillopt_cycles')).toHaveLength(0); expect(f.calls()).toHaveLength(0);
    });
    test('unavailable feature configuration is an explicit failure rather than a disabled-feature success', async () => {
      const original = f.engine().getConfig.bind(f.engine());
      const fault = spyOn(f.engine(), 'getConfig').mockImplementation(key => key === 'cycle.skillopt.enabled' ? Promise.reject(new Error('SYNTHETIC_PRIVATE_DB_ERROR')) : original(key));
      try {
        const result = await runPhaseSkillopt({ engine: f.engine() });
        expect(result).toMatchObject({ status: 'fail', details: { reason: 'config_unavailable', cost_usd: null } });
        expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE'); expect(f.calls()).toHaveLength(0);
      } finally { fault.mockRestore(); }
    });
    test('invalid benchmarks earn no success stamp and have a 24-hour error cooldown', async () => {
      writeFileSync(join(dir, 'alpha', 'skillopt-benchmark.jsonl'), 'bad'); await grant();
      expect((await run()).status).toBe('fail'); expect((await row())?.state).toBe('failed');
      expect(await f.engine().executeRaw('SELECT * FROM codex_skillopt_batches')).toHaveLength(0); expect(f.calls()).toHaveLength(0);
      writeFileSync(join(dir, 'alpha', 'skillopt-benchmark.jsonl'), benchmark); await grant('next-cycle');
      expect(await run('next-cycle')).toMatchObject({ status: 'ok', details: { skills_run: 0 } }); expect(f.calls()).toHaveLength(0);
      expect((await row())?.result_hash).toBeNull();
    });
    test('a concurrent preflight failure cannot be adopted after another caller prepared the batch', async () => {
      await grant(); const original = batchStore.claimOptimizerBatch;
      const fault = spyOn(batchStore, 'claimOptimizerBatch').mockImplementationOnce(async (...args) => {
        await f.engine().executeRaw("UPDATE codex_skillopt_cycles SET state='failed',settled_at=now() WHERE run_id=$1", [args[0].runId]);
        return original(...args);
      });
      try { expect(await run()).toMatchObject({ status: 'fail', details: { reason: 'subscription_identity_conflict' } }); }
      finally { fault.mockRestore(); }
      expect((await row())?.state).toBe('failed'); expect(f.calls()).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT * FROM codex_skillopt_batches')).toHaveLength(0);
    });
    test('partial file publication retains the frozen selection and blocks new roots until recovery', async () => {
      await grant(); const original = files.publishOptimizerFile;
      const fault = spyOn(files, 'publishOptimizerFile').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('SYNTHETIC_PRIVATE_PROVIDER_ERROR'); });
      let failed;
      try { failed = await run(); } finally { fault.mockRestore(); }
      expect(failed).toMatchObject({ status: 'fail', details: { reason: 'generation_failed' } }); expect(JSON.stringify(failed)).not.toContain('SYNTHETIC_PRIVATE');
      expect((await row())?.state).toBe('pending'); expect(existsSync(join(dir, 'alpha', 'skillopt-proposed.md'))).toBe(true);
      const calls = f.calls().length; skill('beta'); await grant('new-root');
      expect(await run('new-root')).toMatchObject({ status: 'fail', details: { reason: 'write_pending' } });
      await save({ maxSkillsPerCycle: 2 }); expect(await run()).toMatchObject({ status: 'fail', details: { reason: 'subscription_identity_conflict' } });
      await save(); expect(await run()).toMatchObject({ status: 'ok', details: { skills_run: 1 } });
      expect((await row())?.selection).toEqual(['alpha']); expect(f.calls()).toHaveLength(calls);
    });
    test('lost completion acknowledgement preserves the original cooldown timestamp', async () => {
      await grant(); f.replies({ autoOptimizer: true, noEdits: true }); const original = cycleStore.finishOptimizerCycle;
      const fault = spyOn(cycleStore, 'finishOptimizerCycle').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('lost acknowledgement'); });
      try { expect((await run()).status).toBe('fail'); } finally { fault.mockRestore(); }
      const calls = f.calls().length, stamps = await f.engine().executeRaw('SELECT settled_at FROM codex_skillopt_cycles');
      expect(await run()).toMatchObject({ status: 'ok', details: { no_improvement: 1 } }); expect(f.calls()).toHaveLength(calls);
      expect(await f.engine().executeRaw('SELECT settled_at FROM codex_skillopt_cycles')).toEqual(stamps);
    });
    test('lost selection acknowledgement preserves membership and excludes direct rollout adoption', async () => {
      await grant(); const original = cycleStore.acceptOptimizerCycle;
      const fault = spyOn(cycleStore, 'acceptOptimizerCycle').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('lost selection acknowledgement'); });
      try { expect((await run()).status).toBe('fail'); } finally { fault.mockRestore(); }
      expect((await row())?.state).toBe('pending'); expect((await row())?.selection).toEqual(['alpha']);
      await expect(withCodexSubscription({ engine: f.engine(), runId: 'scheduled-optimizer' }, () => runRollout({
        engine: f.engine(), operationContext: { engine: f.engine(), sourceId: 'default', remote: false, config: {} as never, logger: {} as never, dryRun: false },
        codex: { invocationId: 'unbound-cycle-read', allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'] },
        skillText: text, task: { task_id: 'unbound', task: 'Read evidence.', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'evidence' }] } },
        targetModel: 'codex-cli:gpt-test', maxTurns: 2 }))).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      renameSync(join(dir, 'alpha'), join(f.root, `missing-${seq}`)); skill('beta');
      expect((await run()).status).toBe('fail'); expect((await row())?.selection).toEqual(['alpha']);
      expect((await row())?.state).toBe('failed'); expect(f.calls()).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT * FROM codex_skillopt_batches')).toHaveLength(0);
    });
    test('exhausted runs stay pending, reject direct batch adoption and reject changed source incarnation', async () => {
      await save({ maxAttemptsPerSkill: 1, maxTurnsPerSkill: 1 }); await grant('scheduled-optimizer', 1);
      expect(await run()).toMatchObject({ status: 'fail', details: { reason: 'subscription_exhausted' } }); expect(f.calls()).toHaveLength(1);
      expect((await row())?.state).toBe('pending'); expect((await row())?.result_hash).toBeNull();
      await expect(withCodexSubscription({ engine: f.engine(), runId: 'scheduled-optimizer' }, () => runBatchAll({ engine: f.engine(), skillsDir: dir,
        operationContext: { engine: f.engine(), sourceId: 'default', remote: false, config: {} as never, logger: {} as never, dryRun: false },
        codex: { allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'] }, optimizerModel: 'codex-cli:gpt-test', targetModel: 'codex-cli:gpt-test', judgeModel: 'codex-cli:gpt-test',
        epochs: 1, batchSize: 4, lr: 4, lrSchedule: 'cosine', split: [4, 1, 5], dryRun: false, noMutate: true, allowMutateBundled: false, force: false,
        perSkillMaxCostUsd: 1, brainWideMaxCostUsd: 2 }))).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      // Simulate a retained run from an earlier source incarnation without rewriting
      // an active source that has unrelated page-write guard foreign keys.
      await f.engine().executeRaw("UPDATE codex_skillopt_cycles SET source_incarnation=gen_random_uuid() WHERE run_id='scheduled-optimizer'");
      expect(await run()).toMatchObject({ status: 'fail', details: { reason: 'subscription_identity_conflict' } });
      expect(f.calls()).toHaveLength(1);
    });
    test('real queued maintenance handler does not stamp success after subscription exhaustion', async () => {
      await save({ maxAttemptsPerSkill: 1, maxTurnsPerSkill: 1 });
      const queue = new MinionQueue(f.engine());
      await queue.add('autopilot-global-maintenance', { phases: ['skillopt'] }, { max_attempts: 1 }, { allowProtectedSubmit: true,
        codexSubscription: { maxAttempts: 1, maxTurns: 1, deadline: new Date(Date.now() + 3600000) } });
      const job = (await queue.claim('cycle-worker', 600000, 'default', ['autopilot-global-maintenance']))!;
      const context = buildJobContext(f.engine(), queue, job, job.lock_token!, new AbortController().signal, new AbortController().signal);
      const result = await runWithJobSpend(f.engine(), job, context, () => makeAutopilotGlobalMaintenanceHandler(f.engine())(context));
      expect(result).toMatchObject({ partial: true, report: { phases: [expect.objectContaining({ phase: 'skillopt', status: 'fail' })] } });
      expect(await f.engine().getConfig('autopilot.last_global_at')).toBeNull(); expect(f.calls()).toHaveLength(1);
    });
    test('aborted and expired cycle deadlines stop before inference without completing a selection', async () => {
      await grant(); const controller = new AbortController(); controller.abort();
      expect(await run('scheduled-optimizer', { signal: controller.signal })).toMatchObject({ status: 'fail', details: { reason: 'cancelled' } });
      expect(await run('scheduled-optimizer', { deadlineAtMs: Date.now() - 1000 })).toMatchObject({ status: 'fail' });
      expect(f.calls()).toHaveLength(0); expect((await row())?.state).not.toBe('complete');
    });
  });
}
