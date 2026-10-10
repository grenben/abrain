import { routeTrajectory } from '../../src/eval/longmemeval/trajectory-route.ts';
import { beforeAll, afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { createBenchmarkBrain, resetTables, runBenchmarkQuestion } from '../../src/eval/longmemeval/harness.ts';
import { assertEphemeralBrain } from '../../src/core/ephemeral-brain.ts';
import { assertSubscriptionTarget, withSubscriptionScratch, subscriptionTargetTransaction } from '../../src/core/ai/subscription-target.ts';
import { createSubscriptionRun, reserveSubscriptionAttempt, settleSubscriptionAttempt } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription, type CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { withCodexProposalCache } from '../../src/core/ai/codex-proposal-cache.ts';
import { makeGatewayThinkClient } from '../../src/eval/longmemeval/gateway-client.ts';
import { extractAndInsertClaims, makeAliasMap } from '../../src/eval/longmemeval/extract.ts';
import { digest } from '../../src/core/persistence/digest.ts';

interface Fixture {
  engine(): BrainEngine;
  run<T>(fn: (id: string) => Promise<T>, hooks?: Partial<CodexSubscriptionContext>, maxAttempts?: number): Promise<T>;
  reply(value: unknown): void; calls(): any[];
}
export function codexScratchContract(f: Fixture) { describe('host-owned disposable benchmark targets', () => {
  let scratch: PGLiteEngine;
  const body = 'On 2026-06-02, Aster moved to the coast.';
  const claim = { entity: 'Aster', metric: null, value: null, unit: null, period: null,
    event_type: 'location_change', valid_from: '2026-06-02', text: body };
  const extract = () => extractAndInsertClaims({ engine: scratch, client: makeGatewayThinkClient(), model: 'codex-cli:gpt-test',
    sessionSlug: 'chat/scratch', sessionId: 'scratch', sessionBody: body, sourceId: 'default', aliasMap: makeAliasMap() });
  const facts = () => scratch.executeRaw('SELECT fact FROM facts');
  const seed = () => scratch.putPage('chat/scratch', { type: 'note', title: 'Synthetic session', compiled_truth: body });
  beforeAll(async () => { scratch = await createBenchmarkBrain(); });
  afterAll(async () => { await scratch.disconnect(); });
  beforeEach(async () => { await resetTables(scratch); f.reply({ claims: [claim] }); });

  test('reset preserves factory identity while clearing corpus content', async () => {
    const id = await assertEphemeralBrain(scratch);
    await seed(); await resetTables(scratch);
    expect(await assertEphemeralBrain(scratch)).toBe(id);
    expect(await scratch.getPage('chat/scratch', { sourceId: 'default' })).toBeNull();
  });
  test('an arbitrary engine or forwarding proxy cannot be reset or branded', async () => {
    await f.run(async id => {
      await expect(resetTables(f.engine() as PGLiteEngine)).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      const [run] = await f.engine().executeRaw('SELECT run_id FROM codex_subscription_runs WHERE run_id=$1', [id]);
      expect(run).toBeDefined();
    });
    await expect(resetTables(new Proxy(scratch, {}))).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
  });
  test('reset refuses a scratch database with an unresolved subscription attempt', async () => {
    const runId = 'scratch-misplaced-grant';
    await createSubscriptionRun(scratch, { runId, accountLane: runId, maxAttempts: 1, maxTurns: 1, deadline: new Date(Date.now() + 600000) });
    const attempt = await reserveSubscriptionAttempt(scratch, { runId, attemptId: 'scratch-unresolved', requestHash: digest(runId), timeoutMs: 1000 });
    await settleSubscriptionAttempt(scratch, attempt, { state: 'unresolved', failureCode: 'termination_unconfirmed' });
    try {
      await expect(resetTables(scratch)).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      expect(await scratch.executeRaw('SELECT state FROM codex_subscription_attempts')).toEqual([{ state: 'unresolved' }]);
    } finally {
      await scratch.executeRaw('DELETE FROM codex_subscription_attempts WHERE run_id=$1', [runId]);
      await scratch.executeRaw('DELETE FROM codex_subscription_runs WHERE run_id=$1', [runId]);
    }
  });
  test('factory objects cannot reconnect to another database or reopen after disposal', async () => {
    await expect(scratch.connect({})).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
    const disposed = await createBenchmarkBrain(); await disposed.disconnect();
    await expect(assertEphemeralBrain(disposed)).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
    await expect(disposed.connect({})).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
  });
  test('foreign extraction requires a live host scope before inference', async () => {
    const before = f.calls().length;
    await f.run(async () => { await expect(extract()).rejects.toMatchObject({ code: 'subscription_identity_conflict' }); });
    expect(f.calls().length).toBe(before);
  });
  test('real extraction writes scratch facts but all attempts and retained proposals stay in the owner', async () => {
    const before = f.calls().length;
    await f.run(async id => withCodexProposalCache({ namespace: 'scratch-contract', bindingHash: digest(id) }, async () => {
      for (let i = 0; i < 2; i++) await runBenchmarkQuestion(scratch, async () => {
        await seed(); expect(await extract()).toMatchObject({ inserted: 1, cacheHit: i === 1 });
        expect(await facts()).toEqual([{ fact: body }]);
      });
      const [run] = await f.engine().executeRaw<{ attempts: number; accepted_turns: number }>(
        'SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [id]);
      expect(Number(run!.attempts)).toBe(1); expect(Number(run!.accepted_turns)).toBe(1);
      expect(await scratch.executeRaw('SELECT run_id FROM codex_subscription_runs')).toEqual([]);
      expect(await scratch.executeRaw('SELECT run_id FROM codex_proposal_cache')).toEqual([]);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_proposal_cache WHERE run_id=$1', [id])).toHaveLength(1);
    }), {}, 1);
    expect(f.calls().length - before).toBe(1);
  });
  test('owner publication hooks always receive the host transaction', async () => {
    let calls = 0;
    const [owner] = await f.engine().executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    await f.run(async id => withSubscriptionScratch(scratch, async () => {
      await seed(); expect((await extract()).inserted).toBe(1);
    }), { checkAuthorityInTransaction: async tx => {
      const [target] = await tx.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
      expect(target!.brain_id).toBe(owner!.brain_id); calls++;
    } });
    expect(calls).toBeGreaterThanOrEqual(2);
  });
  test('another worker, reset, disconnect and nested scope cannot overlap an active question', async () => {
    await f.run(() => withSubscriptionScratch(scratch, async () => {
      for (const action of [() => resetTables(scratch), () => scratch.disconnect(), () => withSubscriptionScratch(scratch, async () => {})])
        await expect(action()).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      expect(await assertSubscriptionTarget(scratch)).toBe(true);
    }));
    await resetTables(scratch);
  });
  test('missing or expired durable grants refuse a scratch scope', async () => {
    const before = f.calls().length;
    await expect(withCodexSubscription({ engine: f.engine(), runId: 'not-created' }, () => withSubscriptionScratch(scratch, extract)))
      .rejects.toMatchObject({ code: 'subscription_required' });
    await f.run(async id => {
      await f.engine().executeRaw("UPDATE codex_subscription_runs SET deadline=now()-interval '1 second' WHERE run_id=$1", [id]);
      await expect(withSubscriptionScratch(scratch, extract)).rejects.toMatchObject({ code: 'subscription_exhausted' });
    }); expect(f.calls().length).toBe(before);
  });
  test('cancellation after temporary effects rolls back the complete scratch transaction', async () => {
    const abort = new AbortController();
    await expect(f.run(() => withSubscriptionScratch(scratch, async () => {
      await expect(subscriptionTargetTransaction(scratch, async tx => {
        await tx.setConfig('scratch-effect', 'committed'); abort.abort();
      })).rejects.toMatchObject({ reason: 'aborted' });
    }), { signal: abort.signal })).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
    expect(await scratch.getConfig('scratch-effect')).toBeNull();
  });
  test('private trajectory failures cannot become a successful empty lookup', async () => {
    const broken = new Proxy(scratch, { get(target, key) {
      if (key === 'findTrajectory') return async () => { throw new Error('synthetic private storage error'); };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(routeTrajectory(broken, 'Aster', [], 'temporal')).rejects.toThrow('private_eval_trajectory_failed');
    expect((await routeTrajectory(scratch, 'Aster', [], 'temporal')).points).toBe(0);
  });
  test('a failed owner commit invalidates already-committed disposable state', async () => {
    let failCommit = false;
    const owner = new Proxy(f.engine(), { get(target, key) {
      if (key === 'transaction') return async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => {
        const value = await target.transaction(fn);
        if (failCommit) throw new Error('synthetic owner commit acknowledgement lost');
        return value;
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(f.run(() => withSubscriptionScratch(scratch, async () => {
      failCommit = true;
      await expect(subscriptionTargetTransaction(scratch, tx => tx.setConfig('scratch-uncertain', 'derived')))
        .rejects.toThrow('synthetic owner commit acknowledgement lost');
      await expect(extract()).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
    }), { engine: owner })).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
    expect(await scratch.getConfig('scratch-uncertain')).toBe('derived');
  });
}); }
