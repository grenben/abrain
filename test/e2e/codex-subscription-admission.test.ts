import { beforeAll, afterAll, describe, test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import {
  createSubscriptionRun, reserveSubscriptionAttempt, settleSubscriptionAttempt,
  acceptSubscriptionTurn, type SubscriptionAttempt,
} from '../../src/core/ai/subscription-admission.ts';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('native PostgreSQL subscription ownership', () => {
  const database = `gbrain_test_codex_${randomUUID().replace(/-/g, '')}`;
  let admin: ReturnType<typeof postgres>;
  let first: PostgresEngine;
  let second: PostgresEngine;
  let databaseCreated = false;
  let target: string;

  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(url!);
    admin = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    databaseCreated = true;
    const parsed = new URL(url!); parsed.pathname = `/${database}`; target = parsed.toString();
    first = new PostgresEngine(); second = new PostgresEngine();
    await first.connect({ database_url: target, poolSize: 1 });
    await first.initSchema();
    await second.connect({ database_url: target, poolSize: 1 });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([first?.disconnect(), second?.disconnect()]);
    try {
      if (databaseCreated) await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
    } finally { await admin?.end({ timeout: 5 }); }
  });

  const envelope = (runId: string, accountLane = runId, maxAttempts = 3, maxTurns = maxAttempts) => ({
    runId, accountLane, maxAttempts, maxTurns, deadline: new Date(Date.now() + 120_000),
  });
  const reserve = (engine: PostgresEngine, runId: string, attemptId: string, requestHash = 'a'.repeat(64)) =>
    reserveSubscriptionAttempt(engine, { runId, attemptId, requestHash, timeoutMs: 1000 });
  const winner = (results: PromiseSettledResult<SubscriptionAttempt>[]) => {
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const result = results.find(r => r.status === 'fulfilled');
    if (result?.status !== 'fulfilled') throw new Error('expected one admitted attempt');
    return result.value;
  };

  test('independent connections serialize different runs on one account without charging the loser', async () => {
    const [a] = await first.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const [b] = await second.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(a!.pid).not.toBe(b!.pid);
    await createSubscriptionRun(first, envelope('race-a', 'shared'));
    await createSubscriptionRun(second, envelope('race-b', 'shared'));
    const results = await Promise.allSettled([reserve(first, 'race-a', 'race-a-1'), reserve(second, 'race-b', 'race-b-1')]);
    const admitted = winner(results);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'subscription_lane_busy' } });
    const rows = await first.executeRaw<{ attempts: number }>('SELECT attempts FROM codex_subscription_runs WHERE account_lane=$1', ['shared']);
    expect(rows.map(r => r.attempts).sort()).toEqual([0, 1]);
    await settleSubscriptionAttempt(second, admitted, { state: 'succeeded', usage: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3 } });
    const next = await reserve(first, 'race-b', 'race-next');
    await settleSubscriptionAttempt(first, next, { state: 'failed', failureCode: 'spawn' });
  });

  test('one run also serializes concurrent reservations at its attempt cap', async () => {
    await createSubscriptionRun(first, envelope('one-run', 'one-run', 1));
    const admitted = winner(await Promise.allSettled([reserve(first, 'one-run', 'one-a'), reserve(second, 'one-run', 'one-b')]));
    await settleSubscriptionAttempt(first, admitted, { state: 'failed', failureCode: 'spawn' });
    await expect(reserve(second, 'one-run', 'one-c')).rejects.toMatchObject({ code: 'subscription_exhausted' });
  });

  test('connection loss and unresolved termination retain durable ownership and null usage', async () => {
    await createSubscriptionRun(first, envelope('crash', 'held'));
    const attempt = await reserve(first, 'crash', 'crashed');
    await first.disconnect();
    await second.executeRaw("UPDATE codex_subscription_attempts SET created_at=now()-interval '2 days' WHERE attempt_id=$1", [attempt.attemptId]);
    await expect(reserve(second, 'crash', 'after-crash')).rejects.toMatchObject({ code: 'subscription_lane_busy' });
    await first.connect({ database_url: target, poolSize: 1 });
    await settleSubscriptionAttempt(first, attempt, { state: 'unresolved', failureCode: 'termination_unconfirmed' });
    await expect(reserve(second, 'crash', 'after-unresolved')).rejects.toMatchObject({ code: 'subscription_lane_busy' });
    const [row] = await second.executeRaw('SELECT state,input_tokens,settled_at FROM codex_subscription_attempts WHERE attempt_id=$1', [attempt.attemptId]);
    expect(row).toMatchObject({ state: 'unresolved', input_tokens: null, settled_at: null });
  });

  test('stale owners and changed identities cannot settle or dispatch again', async () => {
    const e = envelope('identity'); await createSubscriptionRun(first, e);
    await expect(createSubscriptionRun(second, { ...e, maxAttempts: 4 })).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
    const attempt = await reserve(first, 'identity', 'identity-1');
    await expect(settleSubscriptionAttempt(second, { ...attempt, ownerId: 'stale' }, { state: 'failed', failureCode: 'spawn' })).rejects.toMatchObject({ code: 'subscription_owner_lost' });
    await expect(reserve(second, 'identity', 'identity-1', 'b'.repeat(64))).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
    await settleSubscriptionAttempt(second, attempt, { state: 'succeeded', usage: null });
    await expect(reserve(first, 'identity', 'identity-1')).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
  });

  test('concurrent acceptance obeys turn cap and rolls back the losing acceptance', async () => {
    await createSubscriptionRun(first, envelope('acceptance', 'acceptance', 3, 1));
    const a = await reserve(first, 'acceptance', 'accept-a');
    await settleSubscriptionAttempt(first, a, { state: 'succeeded', usage: null });
    const b = await reserve(second, 'acceptance', 'accept-b');
    await settleSubscriptionAttempt(second, b, { state: 'succeeded', usage: null });
    const results = await Promise.allSettled([acceptSubscriptionTurn(first, a), acceptSubscriptionTurn(second, b)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'subscription_exhausted' } });
    const [run] = await first.executeRaw('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', ['acceptance']);
    expect(run).toMatchObject({ accepted_turns: 1 });
    const rows = await second.executeRaw('SELECT accepted FROM codex_subscription_attempts WHERE run_id=$1', ['acceptance']);
    expect(rows.filter(r => r.accepted)).toHaveLength(1);
    const accepted = results[0]?.status === 'fulfilled' ? a : b;
    await acceptSubscriptionTurn(second, accepted);
  });
});
