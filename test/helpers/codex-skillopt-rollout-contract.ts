import { describe, expect, test, spyOn } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription, codexSubscriptionContext, type CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../../src/core/minions/subscription-jobs.ts';
import { runRollout, type RolloutOpts } from '../../src/core/skillopt/rollout.ts';
import { runValidationGate } from '../../src/core/skillopt/validate-gate.ts';
import * as actions from '../../src/core/minions/codex-action-store.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { runWithJobSpend } from '../../src/core/minions/spend-authorization.ts';
import { buildJobContext } from '../../src/core/minions/job-context.ts';
import { makeCodexSubagentHandler } from '../../src/core/minions/handlers/subagent-codex.ts';
interface Fixture { engine(): BrainEngine; replies(...values: unknown[]): void; calls(): any[]; get(slug?: string): unknown; final: unknown }
export function codexSkilloptRolloutContract(f: Fixture) {
  describe('durable Codex optimizer rollouts', () => {
    const opts = (extra: Partial<RolloutOpts> = {}): RolloutOpts => ({ engine: f.engine(),
      operationContext: { engine: f.engine(), remote: false, sourceId: 'default', config: {} as never, logger: {} as never, dryRun: false },
      skillText: 'Read the requested note. Summarize its evidence.', targetModel: 'codex-cli:gpt-test', maxTurns: 4,
      task: { task_id: 'one', task: 'Read notes/one.', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'evidence' }] } },
      codex: { invocationId: 'baseline:one:0', allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'] }, ...extra });
    async function run<T>(fn: () => Promise<T>, max = 12, hooks: Partial<CodexSubscriptionContext> = {}) {
      await createSubscriptionRun(f.engine(), { runId: 'optimizer-root', accountLane: CODEX_JOB_ACCOUNT_LANE,
        maxAttempts: max, maxTurns: max, deadline: new Date(Date.now() + 600000) });
      return withCodexSubscription({ engine: f.engine(), runId: 'optimizer-root', ...hooks }, fn);
    }
    const expire = () => f.engine().executeRaw("UPDATE minion_jobs SET lock_until=now()-interval '1 minute' WHERE status='active'");
    test('real rollout uses native schema, child job, canonical ledger and one retained trajectory', async () => {
      await run(async () => {
        const result = await runRollout(opts());
        expect(result).toMatchObject({ stop_reason: 'end', turns: 2, usage: { input_tokens: 56, output_tokens: 30 }, codex: { cost_usd: null, usage_complete: true } });
        expect(result.tool_calls[0]).toMatchObject({ name: 'get_page', input: { slug: 'notes/one' }, output: { source_id: 'default' } });
        expect(await runRollout(opts())).toEqual(result);
        expect(await f.engine().executeRaw('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1', ['optimizer-root'])).toEqual([{ attempts: 2, accepted_turns: 2 }]);
        expect(await f.engine().executeRaw('SELECT status FROM minion_jobs')).toEqual([{ status: 'completed' }]);
        expect(await f.engine().executeRaw("SELECT data->>'optimizer_protocol' AS protocol FROM minion_jobs")).toEqual([{ protocol: 'codex-skillopt-rollout-v1' }]);
        const rows = await f.engine().executeRaw<{ gbrain_tool_use_id: string; tool_use_id: string }>('SELECT gbrain_tool_use_id::text,tool_use_id FROM subagent_tool_executions');
        expect(rows).toHaveLength(1); expect(rows[0]!.gbrain_tool_use_id).toBe(rows[0]!.tool_use_id);
      });
      expect(f.calls()).toHaveLength(2); expect(f.calls()[0].argv).toContain('--output-schema');
      expect(f.calls()[0].prompt).toContain('candidate_skill');
    });
    test('discovery-enabled rollout retains scoped actions and rejects a changed registry', async () => {
      const codex = { ...opts().codex!, allowedTools: ['get_page', 'list_pages'], readRegistry: 'codex-discovery-v1' as const };
      f.replies({ response: { kind: 'tool', name: 'brain_list_pages', arguments: { limit: 2, offset: 0 } } }, f.get(), f.final);
      await run(async () => {
        const result = await runRollout(opts({ codex }));
        expect(result.tool_calls.map(t => t.name)).toEqual(['list_pages', 'get_page']);
        expect(result.tool_calls[0]!.output).toMatchObject({ mode: 'listing', items: expect.arrayContaining([
          expect.objectContaining({ slug: 'notes/one', source_id: 'default' }),
        ]) });
        expect(await runRollout(opts({ codex }))).toEqual(result);
        await expect(runRollout(opts())).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
        expect(await f.engine().executeRaw("SELECT data->>'read_registry' AS registry FROM minion_jobs")).toEqual([{ registry: 'codex-discovery-v1' }]);
      }); expect(f.calls()).toHaveLength(3);
    });
    test('discovery-enabled validation gate carries the registry into scored child history', async () => {
      const base = opts();
      f.replies({ response: { kind: 'tool', name: 'brain_list_pages', arguments: { limit: 2, offset: 0 } } }, f.final);
      await run(async () => {
        const result = await runValidationGate({ engine: f.engine(), operationContext: base.operationContext, candidateSkillText: base.skillText,
          selSet: [base.task], bestScore: 0, targetModel: base.targetModel, runsPerTask: 1,
          codex: { evaluationId: 'discover-eval', allowedTools: ['list_pages'], allowedSlugPrefixes: ['notes/*'], readRegistry: 'codex-discovery-v1' } });
        expect(result.selScore).toBe(1);
        expect(await f.engine().executeRaw("SELECT data->>'read_registry' AS registry FROM minion_jobs")).toEqual([{ registry: 'codex-discovery-v1' }]);
      }); expect(f.calls()).toHaveLength(2);
    });
    test('same evaluation cannot change task, candidate, scope, model or turn limit', async () => {
      await run(async () => {
        await runRollout(opts());
        for (const change of [{ skillText: 'Changed candidate' }, { task: { ...opts().task, task: 'Changed task' } },
          { codex: { ...opts().codex!, allowedSlugPrefixes: ['other/*'] } }, { maxTurns: 3 }])
          await expect(runRollout(opts(change))).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      }); expect(f.calls()).toHaveLength(2);
    });
    test('archiving the source invalidates a retained evaluation', async () => {
      await run(async () => {
        await runRollout(opts());
        await f.engine().executeRaw("UPDATE sources SET archived=true WHERE id='default'");
        try { await expect(runRollout(opts())).rejects.toMatchObject({ code: 'subscription_identity_conflict' }); }
        finally { await f.engine().executeRaw("UPDATE sources SET archived=false WHERE id='default'"); }
      }); expect(f.calls()).toHaveLength(2);
    });
    test('host grant, source and explicit supported read scope are required before calls', async () => {
      await expect(runRollout(opts())).rejects.toMatchObject({ code: 'subscription_required' });
      await run(async () => {
        for (const change of [{ operationContext: undefined }, { operationContext: { ...opts().operationContext!, remote: true } },
          { codex: undefined }, { codex: { ...opts().codex!, allowedTools: ['search'] } }, { writeCapture: true },
          { targetModel: 'anthropic:claude-sonnet-4-6' }, { skillText: 'x'.repeat(17000) }]) await expect(runRollout(opts(change))).rejects.toThrow();
      }); expect(f.calls()).toHaveLength(0); expect(await f.engine().executeRaw('SELECT id FROM minion_jobs')).toHaveLength(0);
    });
    test('real validation gate uses distinct repetitions and recovers them without more calls', async () => {
      f.replies(f.final);
      await run(async () => {
        const input = opts(), gate = () => runValidationGate({ engine: f.engine(), operationContext: input.operationContext,
          candidateSkillText: input.skillText, selSet: [input.task], targetModel: input.targetModel, bestScore: 0,
          codex: { evaluationId: 'baseline', allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'] } });
        expect(await gate()).toMatchObject({ accepted: true, selScore: 1, perTaskMedians: [{ task_id: 'one', runs: [1, 1, 1] }] });
        expect(await f.engine().executeRaw('SELECT job_id FROM codex_skillopt_rollouts')).toHaveLength(3);
        expect((await gate()).selScore).toBe(1);
      }); expect(f.calls()).toHaveLength(3);
    });
    test('siblings exhaust the same allowance; retry cannot mint a replacement job', async () => {
      await run(async () => {
        await runRollout(opts());
        const second = opts({ codex: { ...opts().codex!, invocationId: 'baseline:two:0' } });
        await expect(runRollout(second)).rejects.toMatchObject({ code: 'subscription_exhausted' });
        await expire(); await expect(runRollout(second)).rejects.toMatchObject({ code: 'subscription_exhausted' });
        await expect(runRollout(opts({ codex: { ...opts().codex!, invocationId: 'third' } }))).rejects.toMatchObject({ code: 'subscription_exhausted' });
        expect(await f.engine().executeRaw('SELECT job_id FROM codex_skillopt_rollouts')).toHaveLength(2);
      }, 2); expect(f.calls()).toHaveLength(2);
    });
    test('crash after action persistence reuses the canonical pending read before further inference', async () => {
      await run(async () => {
        const original = actions.retainCodexAction, fault = spyOn(actions, 'retainCodexAction').mockImplementationOnce(async (...args) => {
          await original(...args); throw new Error('synthetic lost acknowledgement');
        });
        try { await expect(runRollout(opts())).rejects.toThrow('synthetic lost acknowledgement'); } finally { fault.mockRestore(); }
        expect(f.calls()).toHaveLength(1);
        await expire(); const result = await runRollout(opts());
        expect(result.turns).toBe(2); expect(result.tool_calls).toHaveLength(1);
        expect(await f.engine().executeRaw('SELECT job_id FROM codex_skillopt_rollouts')).toHaveLength(1);
      }); expect(f.calls()).toHaveLength(2);
    });
    test('a failed read never becomes a successful optimizer measurement', async () => {
      f.replies(f.get('notes/private'), f.final);
      await run(async () => {
        await expect(runRollout(opts())).rejects.toMatchObject({ reason: 'invalid_output' });
        expect(await f.engine().executeRaw('SELECT trajectory FROM codex_skillopt_rollouts')).toEqual([{ trajectory: null }]);
        await expire(); await expect(runRollout(opts())).rejects.toMatchObject({ reason: 'invalid_output' });
      }); expect(f.calls()).toHaveLength(2); expect(JSON.stringify(f.calls())).not.toContain('SYNTHETIC_PRIVATE_CANARY');
    });
    test('ambiguous attempts block recovery despite an expired worker lease', async () => {
      await run(async () => {
        const original = actions.retainCodexAction, fault = spyOn(actions, 'retainCodexAction').mockImplementationOnce(async (...args) => {
          await original(...args); throw new Error('synthetic crash');
        });
        try { await expect(runRollout(opts())).rejects.toThrow(); } finally { fault.mockRestore(); }
        await f.engine().executeRaw("UPDATE codex_subscription_attempts SET state='unresolved',settled_at=NULL WHERE state='succeeded'");
        await expire(); await expect(runRollout(opts())).rejects.toMatchObject({ code: 'subscription_lane_busy' });
      }); expect(f.calls()).toHaveLength(1);
    });
    test('live competing owners cannot claim the same evaluation', async () => {
      await run(async () => {
        const parent = codexSubscriptionContext()!;
        const original = actions.retainCodexAction, fault = spyOn(actions, 'retainCodexAction').mockImplementationOnce(async (...args) => {
          await original(...args); await expect(withCodexSubscription(parent, () => runRollout(opts()))).rejects.toMatchObject({ code: 'subscription_owner_lost' });
        });
        try { expect((await runRollout(opts())).stop_reason).toBe('end'); } finally { fault.mockRestore(); }
      }); expect(f.calls()).toHaveLength(2);
    });
    test.each(['before', 'after'])('terminal transaction %s commit retains the same final answer', async when => {
      await run(async () => {
        const engine = f.engine(), original = engine.transaction;
        let injected = false;
        engine.transaction = async function(this: BrainEngine, fn) {
          const check = async (target: BrainEngine) => {
            if (injected) return;
            const rows = await target.executeRaw('SELECT job_id FROM codex_skillopt_rollouts WHERE trajectory IS NOT NULL');
            if (rows.length) { injected = true; throw new Error('synthetic terminal commit fault'); }
          };
          if (this !== engine) return original.call(this, fn);
          const value = await original.call(this, async tx => { const value = await fn(tx); if (when === 'before') await check(tx); return value; });
          if (when === 'after') await check(engine);
          return value;
        } as typeof engine.transaction;
        try { await expect(runRollout(opts())).rejects.toThrow('synthetic terminal commit fault'); }
        finally { engine.transaction = original; }
        expect(injected).toBe(true); await expire();
        expect((await runRollout(opts())).final_text).toContain('evidence');
        expect(await engine.executeRaw('SELECT status FROM minion_jobs')).toEqual([{ status: 'completed' }]);
      }); expect(f.calls()).toHaveLength(2);
    });
    test('recorded read results are not executed again after lost acknowledgement', async () => {
      await run(async () => {
        const original = actions.settleCodexAction, fault = spyOn(actions, 'settleCodexAction').mockImplementationOnce(async (...args) => {
          await original(...args); throw new Error('synthetic read result fault');
        });
        try { await expect(runRollout(opts())).rejects.toThrow('synthetic read result fault'); } finally { fault.mockRestore(); }
        await expire();
        const get = spyOn(f.engine(), 'getPage').mockImplementation(async () => { throw new Error('read must not repeat'); });
        try { expect((await runRollout(opts())).tool_calls[0]!.output).toMatchObject({ slug: 'notes/one' }); } finally { get.mockRestore(); }
      }); expect(f.calls()).toHaveLength(2);
    });
    test('stale owner cannot publish a trajectory after recording the final proposal', async () => {
      f.replies(f.final);
      await run(async () => {
        const original = actions.retainCodexAction, fault = spyOn(actions, 'retainCodexAction').mockImplementationOnce(async (...args) => {
          await original(...args);
          await f.engine().executeRaw("UPDATE minion_jobs SET lock_token='synthetic-new-owner',codex_claim_token=claim_generation+1,claim_generation=claim_generation+1 WHERE status='active'");
        });
        try { await expect(runRollout(opts())).rejects.toMatchObject({ code: 'subscription_owner_lost' }); } finally { fault.mockRestore(); }
        expect(await f.engine().executeRaw('SELECT trajectory FROM codex_skillopt_rollouts')).toEqual([{ trajectory: null }]);
        await expire(); expect((await runRollout(opts())).stop_reason).toBe('end');
      }); expect(f.calls()).toHaveLength(1);
    });
    test('cancellation cannot publish or erase the recorded proposal', async () => {
      f.replies(f.final); const abort = new AbortController();
      await run(async () => {
        const original = actions.retainCodexAction, fault = spyOn(actions, 'retainCodexAction').mockImplementationOnce(async (...args) => { await original(...args); abort.abort(); });
        try { await expect(runRollout(opts({ abortSignal: abort.signal }))).rejects.toThrow(); } finally { fault.mockRestore(); }
        expect(await f.engine().executeRaw('SELECT trajectory FROM codex_skillopt_rollouts')).toEqual([{ trajectory: null }]);
        await expire(); expect((await runRollout(opts())).stop_reason).toBe('end');
      }); expect(f.calls()).toHaveLength(1);
    });
    test('a queue worker without the parent scope cannot execute an optimizer child', async () => {
      await run(async () => {
        const original = actions.retainCodexAction, fault = spyOn(actions, 'retainCodexAction').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('synthetic crash'); });
        try { await expect(runRollout(opts())).rejects.toThrow(); } finally { fault.mockRestore(); }
      });
      const queue = new MinionQueue(f.engine()), [job] = await queue.getJobs();
      const signal = new AbortController().signal, ctx = buildJobContext(f.engine(), queue, job!, job!.lock_token!, signal, signal);
      await expect(runWithJobSpend(f.engine(), job!, ctx, makeCodexSubagentHandler(f.engine()))).rejects.toMatchObject({ code: 'subscription_required' });
      expect(f.calls()).toHaveLength(1);
    });
    test('ordinary pruning keeps rollout identity and still removes unrelated terminal jobs', async () => {
      await run(async () => {
        const result = await runRollout(opts()), queue = new MinionQueue(f.engine());
        const ordinary = await queue.add('sync', { source_id: 'default' });
        await queue.cancelJob(ordinary.id);
        expect(await queue.removeJob(result.codex!.job_id)).toBe(false);
        const args = { olderThan: new Date(Date.now() + 60000) };
        expect(await queue.prune({ ...args, dryRun: true })).toBe(1);
        expect(await queue.prune(args)).toBe(1);
        expect(await runRollout(opts())).toEqual(result);
      }); expect(f.calls()).toHaveLength(2);
    });
  });
}
