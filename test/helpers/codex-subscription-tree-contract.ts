import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createSubscriptionRun, reserveSubscriptionAttempt, settleSubscriptionAttempt, acceptSubscriptionTurn } from '../../src/core/ai/subscription-admission.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../../src/core/ai/subscription-context.ts';
import { runReflect } from '../../src/core/skillopt/reflect.ts';
import type { SubscriptionGroupFixture } from './codex-subscription-group-contract.ts';
import { v332 } from '../../src/core/schema-migrations/v332-codex-subscription-groups.ts';
import { v338 } from '../../src/core/schema-migrations/v338-codex-subscription-tree.ts';

export function codexSubscriptionTreeContract(f: SubscriptionGroupFixture) {
  describe('bounded Codex subscription tree', () => {
    async function child(parentRunId: string, maxAttempts?: number, maxTurns = maxAttempts) {
      const [parent] = await f.engine().executeRaw<any>('SELECT * FROM codex_subscription_runs WHERE run_id=$1', [parentRunId]);
      const runId = randomUUID();
      await createSubscriptionRun(f.engine(), { runId, parentRunId, accountLane: parent.account_lane,
        maxAttempts: maxAttempts ?? parent.max_attempts, maxTurns: maxTurns ?? parent.max_turns, deadline: new Date(parent.deadline) });
      return runId;
    }
    const reserve = (runId: string, repair = false) => reserveSubscriptionAttempt(f.engine(), {
      runId, attemptId: randomUUID(), requestHash: 'a'.repeat(64), timeoutMs: 1000, repair,
    });
    const counts = async (runId: string) => (await f.engine().executeRaw('SELECT attempts,accepted_turns,repairs FROM codex_subscription_runs WHERE run_id=$1', [runId]))[0];
    const failed = async (runId: string, repair = false) => settleSubscriptionAttempt(f.engine(), await reserve(runId, repair), { state: 'failed', failureCode: 'invalid_output' });
    const success = async (runId: string) => {
      const attempt = await reserve(runId);
      await settleSubscriptionAttempt(f.engine(), attempt, { state: 'succeeded', usage: null });
      return attempt;
    };
    test('native proposals charge root, intermediate and leaf once and preserve honest usage', async () => {
      f.reply({ edits: [] }); const before = f.calls().length;
      await f.run(async root => {
        const host = codexSubscriptionContext()!, middle = await child(root), leaf = await child(middle);
        const propose = () => runReflect({ skillBodyText: '## Method\nUse evidence.', optimizerModel: 'codex-cli:gpt-test', successes: [], failures: [{ score: 0.2, trajectory: { task_id: 'tree-fixture', task: 'Use evidence.', final_text: 'Evidence.', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, turns: 1, stop_reason: 'end', duration_ms: 1 } }], rejected: [] });
        for (const runId of [root, middle, leaf]) {
          const result = await withCodexSubscription({ ...host, runId }, propose);
          expect(result.billing).toMatchObject({ costUsd: null, remainingQuota: null });
        }
        expect(await counts(root)).toEqual({ attempts: 3, accepted_turns: 3, repairs: 0 });
        expect(await counts(middle)).toEqual({ attempts: 2, accepted_turns: 2, repairs: 0 });
        expect(await counts(leaf)).toEqual({ attempts: 1, accepted_turns: 1, repairs: 0 });
        const other = await child(await child(root));
        await expect(withCodexSubscription({ ...host, runId: other }, propose)).rejects.toMatchObject({ code: 'subscription_exhausted' });
        expect(await counts(other)).toEqual({ attempts: 0, accepted_turns: 0, repairs: 0 });
        expect(await f.engine().executeRaw('SELECT count(*)::int AS calls,sum(input_tokens)::int AS tokens FROM codex_subscription_attempts WHERE account_lane=$1', [root])).toEqual([{ calls: 3, tokens: 63 }]);
      }, {}, 3);
      expect(f.calls().length - before).toBe(3);
    });
    test('each level independently bounds attempts and failed calls cannot be refunded', async () => {
      await f.run(async root => {
        const middle = await child(root, 2), one = await child(middle, 1), two = await child(middle, 1);
        await failed(one);
        await expect(reserve(one)).rejects.toMatchObject({ code: 'subscription_exhausted' });
        await failed(two);
        await expect(reserve(await child(middle))).rejects.toMatchObject({ code: 'subscription_exhausted' });
        for (const runId of [root, middle, one])
          await expect(f.engine().executeRaw('UPDATE codex_subscription_runs SET attempts=0 WHERE run_id=$1', [runId])).rejects.toThrow('subscription_invalid');
        await failed(await child(await child(root)));
        expect(await counts(root)).toEqual({ attempts: 3, accepted_turns: 0, repairs: 0 });
        expect(await counts(middle)).toEqual({ attempts: 2, accepted_turns: 0, repairs: 0 });
      }, {}, 3);
    });
    test('aggregate exhaustion rolls back the inserted attempt and every descendant counter', async () => {
      await f.run(async root => {
        const middle = await child(root), leaf = await child(middle);
        await failed(root);
        // Immediate parent is unused: failure must come from the root trigger,
        // after the reservation inserted its attempt and tried to charge the leaf.
        await expect(reserve(leaf)).rejects.toMatchObject({ code: 'subscription_exhausted' });
        for (const runId of [middle, leaf]) expect(await counts(runId)).toEqual({ attempts: 0, accepted_turns: 0, repairs: 0 });
        expect(await f.engine().executeRaw('SELECT count(*)::int AS calls FROM codex_subscription_attempts WHERE account_lane=$1', [root])).toEqual([{ calls: 1 }]);
      }, {}, 1);
    });
    test('one repair spans all branches and failed repair remains charged', async () => {
      await f.run(async root => {
        const a = await child(root), b = await child(root), one = await child(a), two = await child(b);
        await failed(one, true);
        await expect(reserve(two, true)).rejects.toMatchObject({ code: 'subscription_exhausted' });
        for (const runId of [root, a, one]) expect(await counts(runId)).toEqual({ attempts: 1, accepted_turns: 0, repairs: 1 });
        for (const runId of [b, two]) expect(await counts(runId)).toEqual({ attempts: 0, accepted_turns: 0, repairs: 0 });
      });
    });
    test('acceptance is idempotent across all ancestors and a losing acceptance rolls back', async () => {
      await f.run(async root => {
        await f.engine().executeRaw('UPDATE codex_subscription_runs SET max_turns=1 WHERE run_id=$1', [root]);
        const a = await child(root), b = await child(root), one = await child(a), two = await child(b);
        const good = await success(one), loser = await success(two);
        await acceptSubscriptionTurn(f.engine(), good); await acceptSubscriptionTurn(f.engine(), good);
        await expect(acceptSubscriptionTurn(f.engine(), loser)).rejects.toMatchObject({ code: 'subscription_exhausted' });
        for (const runId of [root, a, one]) expect((await counts(runId))!.accepted_turns).toBe(1);
        for (const runId of [b, two]) expect((await counts(runId))!.accepted_turns).toBe(0);
        expect(await f.engine().executeRaw('SELECT accepted FROM codex_subscription_attempts WHERE attempt_id=$1', [loser.attemptId])).toEqual([{ accepted: false }]);
      });
    });
    test('an intermediate accepted-turn cap leaves capacity for another branch', async () => {
      await f.run(async root => {
        const middle = await child(root, 3, 1), leaf = await child(middle);
        await acceptSubscriptionTurn(f.engine(), await success(leaf));
        await expect(reserve(await child(middle))).rejects.toMatchObject({ code: 'subscription_exhausted' });
        await acceptSubscriptionTurn(f.engine(), await success(await child(await child(root))));
        expect((await counts(root))!.accepted_turns).toBe(2);
      });
    });
    test('unresolved leaf attempts block ancestors and separate branches without refunds', async () => {
      await f.run(async root => {
        const middle = await child(root), leaf = await child(middle), other = await child(await child(root));
        const attempt = await reserve(leaf);
        await settleSubscriptionAttempt(f.engine(), attempt, { state: 'unresolved', failureCode: 'termination_unconfirmed' });
        for (const runId of [root, middle, leaf, other]) await expect(reserve(runId)).rejects.toMatchObject({ code: 'subscription_lane_busy' });
        for (const runId of [root, middle, leaf]) expect((await counts(runId))!.attempts).toBe(1);
        expect((await counts(other))!.attempts).toBe(0);
      });
    });
    test('migration preserves spent legacy child allowances and is safe to replay', async () => {
      await f.run(async root => {
        // Restore the historical guard only in this isolated fixture, then run
        // the real registered upgrade against already-spent parent/child rows.
        await f.engine().transaction(tx => tx.runMigration(v332.version, v332.sql));
        try {
          const middle = await child(root);
          await failed(middle);
          await expect(child(middle)).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
          await f.engine().transaction(tx => tx.runMigration(v338.version, v338.sql));
          await f.engine().transaction(tx => tx.runMigration(v338.version, v338.sql));
          const leaf = await child(middle);
          const attempt = await success(leaf);
          await acceptSubscriptionTurn(f.engine(), attempt);
          for (const runId of [root, middle]) expect(await counts(runId)).toEqual({ attempts: 2, accepted_turns: 1, repairs: 0 });
          expect(await counts(leaf)).toEqual({ attempts: 1, accepted_turns: 1, repairs: 0 });
          await expect(reserve(leaf)).rejects.toMatchObject({ code: 'subscription_exhausted' });
        } finally { await f.engine().transaction(tx => tx.runMigration(v338.version, v338.sql)); }
      }, {}, 2);
    });
  });
}
