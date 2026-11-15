import { describe, beforeEach, test, expect, spyOn } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runBatchAll, type BatchAllOpts } from '../../src/core/skillopt/batch.ts';
import * as batchStore from '../../src/core/skillopt/codex-batch-store.ts';
import * as runStore from '../../src/core/skillopt/codex-run-store.ts';
import * as orchestrator from '../../src/core/skillopt/orchestrator.ts';
import { withSkillOptAllowance } from '../../src/core/skillopt/codex-local-grant.ts';
import { runSkillOptCommand } from '../../src/commands/skillopt.ts';
import { createSubscriptionRun, reserveSubscriptionAttempt, settleSubscriptionAttempt } from '../../src/core/ai/subscription-admission.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../../src/core/ai/subscription-context.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../../src/core/minions/subscription-jobs.ts';
interface Fixture { engine(): BrainEngine; root: string; replies(...values: unknown[]): void; calls(): any[] }
export function codexSkilloptBatchContract(f: Fixture) {
  describe('durable Codex optimizer batch', () => {
    let seq = 0, dir: string, args: string[];
    const text = '---\nname: synthetic-skill\ndescription: Synthetic benchmark skill.\n---\n# Response\n\nPrefer brevity.\n';
    const benchmark = Array.from({ length: 15 }, (_, i) => JSON.stringify({ task_id: `task-${i}`, task: 'Give a useful answer.', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'evidence' }] } })).join('\n');
    const rootId = 'codex-skillopt:123e4567-e89b-42d3-a456-426614174000';
    beforeEach(() => {
      dir = join(f.root, `batch-${seq++}`);
      for (const skill of ['alpha', 'beta']) {
        mkdirSync(join(dir, skill), { recursive: true }); writeFileSync(join(dir, skill, 'SKILL.md'), text);
        writeFileSync(join(dir, skill, 'skillopt-benchmark.jsonl'), benchmark);
      }
      args = ['--all', '--loop', '--codex-request-id', '123e4567-e89b-42d3-a456-426614174000', '--codex-max-attempts', '150',
        '--codex-max-turns', '150', '--codex-deadline', new Date(Date.now() + 3600000).toISOString(), '--source', 'default', '--read-prefix', 'notes/*'];
      f.replies({ autoOptimizer: true });
    });
    const opts = (extra: Partial<BatchAllOpts> = {}): BatchAllOpts => ({ engine: f.engine(), skillsDir: dir,
      perSkillMaxCostUsd: 1, brainWideMaxCostUsd: 2, optimizerModel: 'codex-cli:gpt-test', targetModel: 'codex-cli:gpt-test', judgeModel: 'codex-cli:gpt-test',
      epochs: 1, batchSize: 5, lr: 1, lrSchedule: 'constant', split: [1, 1, 1], reflectMaxTokens: 2048,
      dryRun: false, noMutate: true, allowMutateBundled: false, force: true, ...extra,
      optimizerMode: extra.optimizerMode ?? 'reflect' });
    const run = (extra: Partial<BatchAllOpts> = {}, flags = args) => withSkillOptAllowance(f.engine(), flags, (_, scope) => runBatchAll(opts({ ...scope, ...extra })));
    const batch = () => batchStore.readOptimizerBatch(f.engine(), rootId);
    test('actual CLI runs two skills under one root and recovers identical receipts without new calls', async () => {
      const flags = [...args, '--skills-dir', dir, '--epochs', '1', '--batch-size', '5', '--lr', '1', '--lr-schedule', 'constant', '--split', '1:1:1', '--reflect-max-tokens', '2048', '--no-mutate', '--force', '--json'];
      const exits: number[] = [], output: string[] = [];
      const exit = spyOn(process, 'exit').mockImplementation(c => { exits.push(Number(c)); return undefined as never; });
      const out = spyOn(process.stdout, 'write').mockImplementation(c => { output.push(String(c)); return true; });
      try { await runSkillOptCommand(f.engine(), flags); await runSkillOptCommand(f.engine(), flags); }
      finally { exit.mockRestore(); out.mockRestore(); }
      expect(exits).toEqual([0, 0]); const results = output.filter(s => s.startsWith('{')).map(s => JSON.parse(s));
      expect(results).toHaveLength(2); expect(results[1]).toEqual(results[0]);
      expect(results[0]).toMatchObject({ skills_run: 2, accepted: 2, cumulative_cost_usd: null, remaining_quota: null, subscription: { attempts: 132, accepted_turns: 132 } });
      expect(results[0].per_skill.every((r: any) => r.cost_usd === null && r.receipt.final_cost_usd === null)).toBe(true);
      expect(f.calls()).toHaveLength(132);
      expect(await f.engine().executeRaw('SELECT attempts FROM codex_subscription_runs WHERE run_id=$1', [rootId])).toEqual([{ attempts: 132 }]);
      expect(await f.engine().executeRaw('SELECT attempts FROM codex_subscription_runs WHERE parent_run_id=$1', [rootId])).toEqual([{ attempts: 66 }, { attempts: 66 }]);
      expect((await batch())!.state).toBe('complete');
    });
    test('all preflight and dry-run finish before any durable allowance or output', async () => {
      writeFileSync(join(dir, 'beta', 'skillopt-benchmark.jsonl'), 'invalid');
      await expect(run()).rejects.toThrow(); expect(f.calls()).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(0);
      writeFileSync(join(dir, 'beta', 'skillopt-benchmark.jsonl'), benchmark);
      expect(await run({ dryRun: true })).toMatchObject({ dry_run: true, skills_scanned: 2, skills_run: 0 });
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_skillopt_batches')).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(0);
      expect(existsSync(join(dir, 'alpha', 'skillopt-proposed.md'))).toBe(false);
    });
    test('valid empty selection is distinct from a missing directory or conflicting CLI controls', async () => {
      await expect(run({ skillsDir: join(dir, 'missing') })).rejects.toThrow();
      for (const extra of [['--benchmark', '/unused'], ['--brain-wide-max-cost-usd', '1']])
        await expect(withSkillOptAllowance(f.engine(), [...args, ...extra], async () => undefined)).rejects.toThrow();
      expect(await withSkillOptAllowance(f.engine(), [...args, '--background'], async remaining => remaining.includes('--background'))).toBe(true);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(0);
      expect(await run({ filter: () => false })).toMatchObject({ skills_scanned: 0, skills_run: 0, errored: 0, cumulative_cost_usd: null });
      expect((await batch())!.state).toBe('complete'); expect(f.calls()).toHaveLength(0);
    });
    test('CLI dry-run checks the batch without granting work and exits successfully', async () => {
      const exits: number[] = [];
      const exit = spyOn(process, 'exit').mockImplementation(c => { exits.push(Number(c)); return undefined as never; });
      const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
      try { await runSkillOptCommand(f.engine(), [...args, '--skills-dir', dir, '--split', '1:1:1', '--dry-run', '--force', '--no-mutate', '--json']); }
      finally { exit.mockRestore(); out.mockRestore(); }
      expect(exits).toEqual([0]); expect(f.calls()).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(0);
    });
    test('partial publication and acknowledgement loss reuse the first skill and reject changed pending inputs', async () => {
      const original = runStore.completeOptimizerRun;
      const fault = spyOn(runStore, 'completeOptimizerRun').mockImplementationOnce(async (...input) => { await original(...input); throw new Error('synthetic publication acknowledgement loss'); });
      try { await expect(run()).rejects.toThrow('synthetic publication acknowledgement loss'); } finally { fault.mockRestore(); }
      // File committed but its surrounding transaction rolled back: retained computed
      // result reconciles the exact bytes, with no re-optimization of that skill.
      expect(existsSync(join(dir, 'alpha', 'skillopt-proposed.md'))).toBe(true); expect(f.calls()).toHaveLength(66);
      writeFileSync(join(dir, 'beta', 'skillopt-benchmark.jsonl'), benchmark.replaceAll('useful', 'changed'));
      await expect(run()).rejects.toMatchObject({ code: 'subscription_identity_conflict' }); expect(f.calls()).toHaveLength(66);
      writeFileSync(join(dir, 'beta', 'skillopt-benchmark.jsonl'), benchmark);
      expect((await run()).accepted).toBe(2); expect(f.calls()).toHaveLength(132);
    });
    test('lost manifest acknowledgement retains membership and fences until explicit lease recovery', async () => {
      const original = batchStore.claimOptimizerBatch;
      const fault = spyOn(batchStore, 'claimOptimizerBatch').mockImplementationOnce(async (...input) => { await original(...input); throw new Error('synthetic manifest acknowledgement loss'); });
      try { await expect(run()).rejects.toThrow('synthetic manifest acknowledgement loss'); } finally { fault.mockRestore(); }
      const members = await f.engine().executeRaw('SELECT run_id FROM codex_skillopt_batch_members ORDER BY ordinal');
      expect(members).toHaveLength(2); expect(f.calls()).toHaveLength(0);
      await expect(run()).rejects.toMatchObject({ code: 'subscription_owner_lost' });
      await f.engine().executeRaw("UPDATE codex_skillopt_batches SET lease_until=now()-interval '1 second'");
      expect((await run()).accepted).toBe(2);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_skillopt_batch_members ORDER BY ordinal')).toEqual(members);
    });
    test('an unresolved child call holds the batch and its charged root allowance', async () => {
      const original = runStore.saveOptimizerCheckpoint;
      const fault = spyOn(runStore, 'saveOptimizerCheckpoint').mockImplementationOnce(async (...input) => {
        await original(...input); const host = codexSubscriptionContext()!;
        const attempt = await reserveSubscriptionAttempt(f.engine(), { runId: host.runId, attemptId: randomUUID(), requestHash: 'a'.repeat(64), timeoutMs: 1000 });
        await settleSubscriptionAttempt(f.engine(), attempt, { state: 'unresolved', failureCode: 'termination_unconfirmed' });
        throw new Error('synthetic unresolved call');
      });
      try { await expect(run()).rejects.toThrow('synthetic unresolved call'); } finally { fault.mockRestore(); }
      const before = f.calls().length;
      expect((await batch())!.state).toBe('needs_reconciliation');
      await expect(run()).rejects.toMatchObject({ code: 'subscription_lane_busy' }); expect(f.calls()).toHaveLength(before);
      expect(await f.engine().executeRaw('SELECT attempts FROM codex_subscription_runs WHERE run_id=$1', [rootId])).toEqual([{ attempts: before + 1 }]);
    });
    test('a stale batch owner cannot publish or release its replacement lease', async () => {
      const original = runStore.saveOptimizerResult, replacement = randomUUID();
      const fault = spyOn(runStore, 'saveOptimizerResult').mockImplementationOnce(async (...input) => {
        await original(...input);
        await f.engine().executeRaw("UPDATE codex_skillopt_batches SET owner_token=$1::uuid,lease_until=now()+interval '15 minutes'", [replacement]);
      });
      try { await expect(run()).rejects.toMatchObject({ code: 'subscription_owner_lost' }); } finally { fault.mockRestore(); }
      expect(existsSync(join(dir, 'alpha', 'skillopt-proposed.md'))).toBe(false);
      expect(await f.engine().executeRaw('SELECT owner_token::text FROM codex_skillopt_batches')).toEqual([{ owner_token: replacement }]);
      await expect(run()).rejects.toMatchObject({ code: 'subscription_owner_lost' }); expect(f.calls()).toHaveLength(66);
    });
    test('competing batch owners cannot admit duplicate optimizers', async () => {
      const original = orchestrator.runSkillOpt;
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(r => { entered = r; }), wait = new Promise<void>(r => { release = r; });
      const gate = spyOn(orchestrator, 'runSkillOpt').mockImplementationOnce(async (...input) => { entered(); await wait; return original(...input); });
      const first = run();
      try { await ready; await expect(run()).rejects.toMatchObject({ code: 'subscription_owner_lost' }); }
      finally { release(); gate.mockRestore(); }
      expect((await first).accepted).toBe(2); expect(f.calls()).toHaveLength(132);
    });
    test('per-skill exhaustion stays explicit and cannot silently advance to another skill', async () => {
      await expect(run({ codexPerSkill: { maxAttempts: 1, maxTurns: 1 } })).rejects.toMatchObject({ code: 'subscription_exhausted' });
      expect(f.calls()).toHaveLength(1); expect((await batch())!.state).toBe('idle');
      expect(await f.engine().executeRaw('SELECT count(*)::int AS n FROM codex_skillopt_runs')).toEqual([{ n: 1 }]);
      await expect(run({ codexPerSkill: { maxAttempts: 2, maxTurns: 2 } })).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
    });
    test('aggregate exhaustion retains the completed first skill and refuses increased retry limits', async () => {
      const bounded = args.map((v, i) => ['--codex-max-attempts', '--codex-max-turns'].includes(args[i - 1]!) ? '100' : v);
      await expect(run({}, bounded)).rejects.toMatchObject({ code: 'subscription_exhausted' });
      expect(f.calls()).toHaveLength(100);
      expect(await f.engine().executeRaw("SELECT count(*)::int AS n FROM codex_skillopt_runs WHERE state='complete'")).toEqual([{ n: 1 }]);
      expect((await batch())!.result).toBeNull(); expect(existsSync(join(dir, 'alpha', 'skillopt-proposed.md'))).toBe(true);
      await expect(run()).rejects.toMatchObject({ code: 'subscription_identity_conflict' }); expect(f.calls()).toHaveLength(100);
    });
    test('cancellation between members preserves the committed skill and resumes without regenerating it', async () => {
      const controller = new AbortController(), original = orchestrator.runSkillOpt;
      const cancel = spyOn(orchestrator, 'runSkillOpt').mockImplementationOnce(async (...input) => {
        const result = await original(...input); controller.abort(new Error('synthetic batch cancellation')); return result;
      });
      try {
        await expect(withSkillOptAllowance(f.engine(), args, (_, scope) => withCodexSubscription({ ...codexSubscriptionContext()!, signal: controller.signal },
          () => runBatchAll(opts(scope))))).rejects.toThrow('synthetic batch cancellation');
      } finally { cancel.mockRestore(); }
      expect(f.calls()).toHaveLength(66); expect(existsSync(join(dir, 'alpha', 'skillopt-proposed.md'))).toBe(true);
      expect((await batch())!.result).toBeNull(); expect((await run()).accepted).toBe(2); expect(f.calls()).toHaveLength(132);
    });
    test('lost terminal acknowledgement returns the retained batch result on retry', async () => {
      const original = batchStore.completeOptimizerBatch;
      const fault = spyOn(batchStore, 'completeOptimizerBatch').mockImplementationOnce(async (...input) => { await original(...input); throw new Error('synthetic terminal acknowledgement loss'); });
      try { await expect(run()).rejects.toThrow('synthetic terminal acknowledgement loss'); } finally { fault.mockRestore(); }
      const saved = (await batch())!.result;
      expect((await batch())!.state).toBe('complete'); expect(saved).not.toBeNull(); expect(await run()).toEqual(saved!); expect(f.calls()).toHaveLength(132);
    });
    test('an unbound child allowance does not authorize an optimizer', async () => {
      const envelope = { accountLane: CODEX_JOB_ACCOUNT_LANE, maxAttempts: 150, maxTurns: 150, deadline: new Date(Date.now() + 3600000) };
      await createSubscriptionRun(f.engine(), { ...envelope, runId: 'unbound-root' });
      await createSubscriptionRun(f.engine(), { ...envelope, runId: 'unbound-child', parentRunId: 'unbound-root' });
      const { perSkillMaxCostUsd, brainWideMaxCostUsd, ...base } = opts();
      await expect(withCodexSubscription({ engine: f.engine(), runId: 'unbound-child' }, () => orchestrator.runSkillOpt({ ...base,
        operationContext: { engine: f.engine(), remote: false, sourceId: 'default', config: {} as never, logger: {} as never, dryRun: false },
        codex: { allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'] }, skillName: 'alpha', benchmarkPath: join(dir, 'alpha', 'skillopt-benchmark.jsonl'),
        maxCostUsd: 1, maxRuntimeMin: 30, mode: 'patch', bootstrapReviewed: false, json: true }))).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      expect(f.calls()).toHaveLength(0); expect(await f.engine().executeRaw('SELECT run_id FROM codex_skillopt_runs')).toHaveLength(0);
    });
    test('competing SDK batch and standalone claims cannot adopt the same root identity', async () => {
      const deadline = new Date(Date.now() + 3600000), host = { engine: f.engine(), runId: 'purpose-race' };
      await createSubscriptionRun(f.engine(), { runId: host.runId, accountLane: CODEX_JOB_ACCOUNT_LANE, maxAttempts: 10, maxTurns: 10, deadline });
      const input: batchStore.BatchInput = { protocol: 'codex-skillopt-batch-v1', entries: [],
        grant: { maxAttempts: 10, maxTurns: 10, deadline: deadline.toISOString(), auxiliaryUsd: null },
        perSkill: { maxAttempts: 10, maxTurns: 10 }, auxiliary: [], scope: { skillsDir: dir, sourceId: 'default', codex: { allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'] } } };
      const results = await Promise.allSettled([batchStore.claimOptimizerBatch(host, input), runStore.claimOptimizerRun(host, { protocol: 'synthetic-standalone' }, text, 60000)]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'subscription_identity_conflict' } });
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_skillopt_batches UNION ALL SELECT run_id FROM codex_skillopt_runs')).toHaveLength(1);
      expect(f.calls()).toHaveLength(0);
    });
  });
}
