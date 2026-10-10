import type { SkillOptOpts } from './types.ts';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { CodexSubscriptionContext } from '../ai/subscription-context.ts';
import { createSubscriptionRun, SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../minions/subscription-jobs.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { digest, jsonBytes } from '../persistence/digest.ts';
import { ensureLocalOptimizerGrant } from './codex-local-grant.ts';
import type { BatchAllResult } from './batch.ts';
import { readOptimizerRun } from './codex-run-store.ts';
export interface BatchInput {
  protocol: 'codex-skillopt-batch-v1';
  entries: Array<{ skill: string; runId: string; inputHash: string; input: Record<string, unknown> }>;
  grant: { maxAttempts: number; maxTurns: number; deadline: string; auxiliaryUsd: number | null };
  scope: { sourceId: string | undefined; codex: SkillOptOpts['codex']; skillsDir: string };
  auxiliary: Array<{ budgetKey: string; capUsd: number | null }>;
  perSkill: { maxAttempts: number; maxTurns: number };
}
export interface BatchClaim { runId: string; inputHash: string; token: string }
export interface BatchRow { input: BatchInput; input_hash: string; protocol: number; state: string; result: BatchAllResult | null; result_hash: string | null }
const conflict = (): never => { throw new SubscriptionAdmissionError('subscription_identity_conflict'); };
export async function readOptimizerBatch(engine: BrainEngine, runId: string): Promise<BatchRow | undefined> {
  const [row] = await engine.executeRaw<BatchRow>('SELECT * FROM codex_skillopt_batches WHERE run_id=$1', [runId]);
  if (row && (row.protocol !== 1 || digest(row.input) !== row.input_hash || row.result && digest(row.result) !== row.result_hash)) conflict();
  return row;
}
export async function claimOptimizerBatch(host: CodexSubscriptionContext, input: BatchInput): Promise<{ claim: BatchClaim; row: BatchRow }> {
  if (input.entries.length > 20 || jsonBytes(input) > 8388608) conflict();
  const inputHash = digest(input), token = randomUUID();
  await host.checkAuthority?.(); host.signal?.throwIfAborted();
  const row = await host.engine.transaction(async tx => {
    await declareDurablePersistence(tx); await host.checkAuthorityInTransaction?.(tx);
    await ensureLocalOptimizerGrant(tx, host.runId, 'batch');
    await tx.executeRaw('SELECT gbrain_codex_subscription_lock_path($1)', [host.runId]);
    const [grant] = await tx.executeRaw<{ parent_run_id: string | null; account_lane: string; max_attempts: number; max_turns: number; deadline: string | Date }>('SELECT * FROM codex_subscription_runs WHERE run_id=$1 FOR UPDATE', [host.runId]);
    if (!grant || grant.parent_run_id || grant.account_lane !== CODEX_JOB_ACCOUNT_LANE) throw new SubscriptionAdmissionError('subscription_required');
    if (grant.max_attempts !== input.grant.maxAttempts || grant.max_turns !== input.grant.maxTurns || new Date(grant.deadline).toISOString() !== input.grant.deadline) conflict();
    if ((await tx.executeRaw('SELECT run_id FROM codex_skillopt_runs WHERE run_id=$1 UNION SELECT run_id FROM codex_skillopt_bootstraps WHERE run_id=$1 UNION SELECT run_id FROM codex_shared_skill_optimizations WHERE run_id=$1', [host.runId])).length) conflict();
    const prior = await readOptimizerBatch(tx, host.runId);
    if (prior && prior.input_hash !== inputHash) conflict();
    if (!prior) {
      await tx.executeRaw("INSERT INTO codex_skillopt_batches(run_id,protocol,input,input_hash,state) VALUES($1,1,$2::text::jsonb,$3,'idle')", [host.runId, JSON.stringify(input), inputHash]);
      for (const [ordinal, entry] of input.entries.entries()) {
        await createSubscriptionRun(tx, { runId: entry.runId, parentRunId: host.runId, accountLane: grant.account_lane,
          maxAttempts: input.perSkill.maxAttempts, maxTurns: input.perSkill.maxTurns, deadline: new Date(grant.deadline) });
        await tx.executeRaw('INSERT INTO codex_skillopt_batch_members(batch_run_id,ordinal,run_id,input_hash) VALUES($1,$2,$3,$4)', [host.runId, ordinal, entry.runId, entry.inputHash]);
      }
    }
    const members = await tx.executeRaw<{ ordinal: number; run_id: string; input_hash: string }>('SELECT ordinal,run_id,input_hash FROM codex_skillopt_batch_members WHERE batch_run_id=$1 ORDER BY ordinal', [host.runId]);
    if (digest(members) !== digest(input.entries.map((e, ordinal) => ({ ordinal, run_id: e.runId, input_hash: e.inputHash })))) conflict();
    const [pending] = await tx.executeRaw<{ pending: boolean }>(`WITH RECURSIVE tree AS (
      SELECT run_id FROM codex_subscription_runs WHERE run_id=$1 UNION ALL
      SELECT r.run_id FROM codex_subscription_runs r JOIN tree ON r.parent_run_id=tree.run_id)
      SELECT EXISTS(SELECT 1 FROM codex_subscription_attempts a JOIN tree USING(run_id) WHERE a.state IN ('active','unresolved')) AS pending`, [host.runId]);
    if (pending?.pending) throw new SubscriptionAdmissionError('subscription_lane_busy');
    const rows = await tx.executeRaw(`UPDATE codex_skillopt_batches SET owner_token=$2::uuid,lease_until=now()+interval '15 minutes',state=CASE WHEN result IS NULL THEN 'running' ELSE state END
      WHERE run_id=$1 AND (owner_token IS NULL OR lease_until<now()) RETURNING run_id`, [host.runId, token]);
    if (rows.length !== 1) throw new SubscriptionAdmissionError('subscription_owner_lost');
    return (await readOptimizerBatch(tx, host.runId))!;
  });
  return { claim: { runId: host.runId, inputHash, token }, row };
}
export async function fenceOptimizerBatch(tx: BrainEngine, host: CodexSubscriptionContext, claim: BatchClaim): Promise<void> {
  await declareDurablePersistence(tx); host.signal?.throwIfAborted(); await host.checkAuthorityInTransaction?.(tx);
  await tx.executeRaw('SELECT gbrain_codex_subscription_lock_path($1)', [claim.runId]);
  const rows = await tx.executeRaw(`UPDATE codex_skillopt_batches SET lease_until=now()+interval '15 minutes'
    WHERE run_id=$1 AND input_hash=$2 AND owner_token=$3::uuid AND lease_until>now() RETURNING run_id`, [claim.runId, claim.inputHash, claim.token]);
  if (rows.length !== 1) throw new SubscriptionAdmissionError('subscription_owner_lost');
}
export async function completeOptimizerBatch(host: CodexSubscriptionContext, claim: BatchClaim, result: BatchAllResult): Promise<void> {
  if (jsonBytes(result) > 2097152) conflict();
  await host.engine.transaction(async tx => {
    await fenceOptimizerBatch(tx, host, claim);
    const batch = (await readOptimizerBatch(tx, claim.runId)) ?? conflict();
    if (!batch || batch.result && digest(batch.result) !== digest(result) || result.per_skill.length !== batch.input.entries.length) conflict();
    for (const [ordinal, entry] of batch.input.entries.entries()) {
      const child = await readOptimizerRun(tx, entry.runId), reported = result.per_skill[ordinal];
      if (!child?.result || child.state !== 'complete' || child.input_hash !== entry.inputHash || reported?.skill !== entry.skill ||
          reported.outcome !== child.result.outcome || digest(reported.receipt) !== digest(child.result.receipt)) conflict();
    }
    const missing = await tx.executeRaw(`SELECT m.run_id FROM codex_skillopt_batch_members m LEFT JOIN codex_skillopt_runs r USING(run_id)
      WHERE m.batch_run_id=$1 AND (r.run_id IS NULL OR r.state<>'complete' OR r.input_hash<>m.input_hash)`, [claim.runId]);
    if (missing.length) conflict();
    await tx.executeRaw("UPDATE codex_skillopt_batches SET result=$2::text::jsonb,result_hash=$3,state='complete' WHERE run_id=$1", [claim.runId, JSON.stringify(result), digest(result)]);
  });
}
export async function releaseOptimizerBatch(host: CodexSubscriptionContext, claim: BatchClaim): Promise<void> {
  await host.engine.transaction(async tx => {
    await declareDurablePersistence(tx);
    await tx.executeRaw(`WITH RECURSIVE tree AS (SELECT run_id FROM codex_subscription_runs WHERE run_id=$1 UNION ALL
      SELECT r.run_id FROM codex_subscription_runs r JOIN tree ON r.parent_run_id=tree.run_id)
      UPDATE codex_skillopt_batches SET owner_token=NULL,lease_until=NULL,state=CASE
        WHEN EXISTS(SELECT 1 FROM codex_subscription_attempts a JOIN tree USING(run_id) WHERE a.state IN ('active','unresolved')) THEN 'needs_reconciliation'
        WHEN result IS NULL THEN 'idle' ELSE state END WHERE run_id=$1 AND owner_token=$2::uuid`, [claim.runId, claim.token]);
  });
}
