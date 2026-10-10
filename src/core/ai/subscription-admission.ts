import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { CodexUsage } from './providers/codex-contract.ts';

export class SubscriptionAdmissionError extends Error {
  constructor(public readonly code: 'subscription_required' | 'subscription_exhausted' | 'subscription_lane_busy' | 'subscription_identity_conflict' | 'subscription_owner_lost' | 'subscription_invalid' | 'subscription_auxiliary_budget_required') {
    super(code); this.name = 'SubscriptionAdmissionError';
  }
}
export interface SubscriptionEnvelope {
  runId: string; accountLane: string; maxAttempts: number; maxTurns: number; deadline: Date;
  /** Trusted host-only child binding. The root enforces aggregate admission; no nested groups. */
  parentRunId?: string;
}
export interface SubscriptionAttempt { attemptId: string; runId: string; accountLane: string; ownerId: string }
const idValid = (v: string) => /^[A-Za-z0-9._:-]{1,160}$/.test(v);

/** Trusted host entry, before enqueue/dispatch. USD limits are independent, never inferred here. */
export async function createSubscriptionRun(engine: BrainEngine, envelope: SubscriptionEnvelope): Promise<void> {
  if (!idValid(envelope.runId) || !idValid(envelope.accountLane) ||
    envelope.parentRunId !== undefined && (!idValid(envelope.parentRunId) || envelope.parentRunId === envelope.runId) ||
    ![envelope.maxAttempts, envelope.maxTurns].every(v => Number.isSafeInteger(v) && v >= 1 && v <= 1000) ||
    envelope.maxTurns > envelope.maxAttempts || !Number.isFinite(envelope.deadline.getTime()) ||
    envelope.deadline.getTime() <= Date.now() || envelope.deadline.getTime() > Date.now() + 86_400_000) throw new SubscriptionAdmissionError('subscription_invalid');
  const rows = await engine.executeRaw<{ run_id: string }>(`
    INSERT INTO codex_subscription_runs(run_id,account_lane,max_attempts,max_turns,deadline,parent_run_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id) DO UPDATE SET run_id=EXCLUDED.run_id
    WHERE codex_subscription_runs.account_lane=EXCLUDED.account_lane
      AND codex_subscription_runs.max_attempts=EXCLUDED.max_attempts
      AND codex_subscription_runs.max_turns=EXCLUDED.max_turns
      AND codex_subscription_runs.deadline=EXCLUDED.deadline
      AND codex_subscription_runs.parent_run_id IS NOT DISTINCT FROM EXCLUDED.parent_run_id RETURNING run_id`,
  [envelope.runId, envelope.accountLane, envelope.maxAttempts, envelope.maxTurns, envelope.deadline.toISOString(), envelope.parentRunId ?? null]).catch(subscriptionDatabaseError);
  if (rows.length !== 1) throw new SubscriptionAdmissionError('subscription_identity_conflict');
}

/** Map the database guard's stable codes to typed admission errors. */
function subscriptionDatabaseError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  for (const code of ['subscription_exhausted', 'subscription_identity_conflict', 'subscription_invalid'] as const)
    if (message === code) throw new SubscriptionAdmissionError(code);
  throw error;
}
async function lockSubscriptionParent(tx: BrainEngine, runId: string): Promise<void> {
  await tx.executeRaw(`SELECT run_id FROM codex_subscription_runs
    WHERE run_id=(SELECT parent_run_id FROM codex_subscription_runs WHERE run_id=$1) FOR UPDATE`, [runId]);
}

/** No TTL reclamation: a crashed or ambiguous call continues occupying the shared account lane. */
export async function reserveSubscriptionAttempt(engine: BrainEngine, input: {
  runId: string; attemptId: string; requestHash: string; repair?: boolean; timeoutMs: number;
}): Promise<SubscriptionAttempt> {
  if (!idValid(input.runId) || !idValid(input.attemptId) || !/^[a-f0-9]{64}$/.test(input.requestHash) ||
    !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600_000) throw new SubscriptionAdmissionError('subscription_invalid');
  return engine.transaction(async tx => {
    await lockSubscriptionParent(tx, input.runId);
    // Lock order is stable across workers; account uniqueness below also protects separate runs.
    const runs = await tx.executeRaw<{ account_lane: string; available: boolean }>(`
      SELECT account_lane, (attempts < max_attempts AND accepted_turns < max_turns
        AND deadline >= now()+($2::double precision * interval '1 millisecond')
        AND (NOT $3::boolean OR repairs < 1)) AS available
      FROM codex_subscription_runs WHERE run_id=$1 FOR UPDATE`, [input.runId, input.timeoutMs, input.repair === true]);
    if (!runs[0]) throw new SubscriptionAdmissionError('subscription_required');
    const previous = await tx.executeRaw<{ request_hash: string }>('SELECT request_hash FROM codex_subscription_attempts WHERE attempt_id=$1', [input.attemptId]);
    if (previous.length) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    if (!runs[0].available) throw new SubscriptionAdmissionError('subscription_exhausted');
    const [parent] = await tx.executeRaw<{ available: boolean }>(`SELECT
      attempts<max_attempts AND accepted_turns<max_turns AND (NOT $2::boolean OR repairs<1) AS available
      FROM codex_subscription_runs WHERE run_id=(SELECT parent_run_id FROM codex_subscription_runs WHERE run_id=$1)`, [input.runId, input.repair === true]);
    if (parent && !parent.available) throw new SubscriptionAdmissionError('subscription_exhausted');
    const ownerId = randomUUID();
    const rows = await tx.executeRaw<{ attempt_id: string }>(`
      INSERT INTO codex_subscription_attempts(attempt_id,run_id,account_lane,request_hash,owner_id,state)
      VALUES($1,$2,$3,$4,$5,'active') ON CONFLICT DO NOTHING RETURNING attempt_id`,
    [input.attemptId, input.runId, runs[0].account_lane, input.requestHash, ownerId]);
    if (!rows.length) throw new SubscriptionAdmissionError('subscription_lane_busy');
    await tx.executeRaw('UPDATE codex_subscription_runs SET attempts=attempts+1,repairs=repairs+$2 WHERE run_id=$1', [input.runId, input.repair ? 1 : 0]);
    return { attemptId: input.attemptId, runId: input.runId, accountLane: runs[0].account_lane, ownerId };
  }).catch(subscriptionDatabaseError);
}

export async function settleSubscriptionAttempt(engine: BrainEngine, attempt: SubscriptionAttempt, outcome:
  { state: 'succeeded'; usage: CodexUsage | null } | { state: 'failed' | 'unresolved'; failureCode: string; usage?: CodexUsage | null }): Promise<void> {
  if (outcome.state !== 'succeeded' && !/^[a-z_]{1,64}$/.test(outcome.failureCode)) throw new SubscriptionAdmissionError('subscription_invalid');
  const usage = outcome.usage ?? null;
  if (usage && (![usage.inputTokens,usage.cachedInputTokens,usage.outputTokens].every(v => Number.isSafeInteger(v) && v >= 0) || usage.cachedInputTokens > usage.inputTokens)) throw new SubscriptionAdmissionError('subscription_invalid');
  const rows = await engine.executeRaw<{ attempt_id: string }>(`
    UPDATE codex_subscription_attempts SET state=$4,input_tokens=$5,cached_input_tokens=$6,output_tokens=$7,
      failure_code=$8,settled_at=CASE WHEN $4='unresolved' THEN NULL ELSE now() END
    WHERE attempt_id=$1 AND run_id=$2 AND owner_id=$3 AND state='active' RETURNING attempt_id`,
  [attempt.attemptId,attempt.runId,attempt.ownerId,outcome.state,usage?.inputTokens ?? null,usage?.cachedInputTokens ?? null,usage?.outputTokens ?? null,
    outcome.state === 'succeeded' ? null : outcome.failureCode]);
  if (rows.length !== 1) throw new SubscriptionAdmissionError('subscription_owner_lost');
}

/** Semantic acceptance is explicit and idempotent; schema success alone is not acceptance. */
export async function acceptSubscriptionTurn(engine: BrainEngine, attempt: SubscriptionAttempt): Promise<void> {
  await engine.transaction(async tx => {
    await lockSubscriptionParent(tx, attempt.runId);
    const rows = await tx.executeRaw<{ run_id: string }>(`
      UPDATE codex_subscription_attempts SET accepted=true WHERE attempt_id=$1 AND run_id=$2
      AND owner_id=$3 AND state='succeeded' AND NOT accepted RETURNING run_id`, [attempt.attemptId,attempt.runId,attempt.ownerId]);
    if (rows.length) {
      const accepted = await tx.executeRaw<{ run_id: string }>(`UPDATE codex_subscription_runs SET accepted_turns=accepted_turns+1
        WHERE run_id=$1 AND accepted_turns<max_turns RETURNING run_id`, [attempt.runId]);
      if (!accepted.length) throw new SubscriptionAdmissionError('subscription_exhausted');
    } else {
      const prior = await tx.executeRaw('SELECT attempt_id FROM codex_subscription_attempts WHERE attempt_id=$1 AND run_id=$2 AND owner_id=$3 AND accepted=true', [attempt.attemptId,attempt.runId,attempt.ownerId]);
      if (!prior.length) throw new SubscriptionAdmissionError('subscription_owner_lost');
    }
  }).catch(subscriptionDatabaseError);
}
