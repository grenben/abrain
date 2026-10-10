import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { CodexSubscriptionContext } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../minions/subscription-jobs.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { digest, jsonBytes } from '../persistence/digest.ts';
import type { RejectedEntry } from './rejected-buffer.ts';
import type { RunSkillOptResult } from './orchestrator.ts';

export interface OptimizerCheckpoint {
  bestText: string; bestScore: number | null; baselineScore: number | null;
  nextStep: number; acceptedSteps: number; rejected: RejectedEntry[];
  decisions: Array<{ step: number; accepted: boolean; score?: number; reason: string }>;
}
export interface OptimizerRun {
  run_id: string; protocol: number; input_hash: string; input: Record<string, unknown>;
  checkpoint: OptimizerCheckpoint; checkpoint_hash: string; result: RunSkillOptResult | null;
  result_hash: string | null; state: string; created_at: Date | string; deadline: Date | string;
}
export interface OptimizerClaim { runId: string; inputHash: string; token: string; deadline: number }
const conflict = (): never => { throw new SubscriptionAdmissionError('subscription_identity_conflict'); };
export async function readOptimizerRun(engine: BrainEngine, runId: string): Promise<OptimizerRun | undefined> {
  const [row] = await engine.executeRaw<OptimizerRun>('SELECT * FROM codex_skillopt_runs WHERE run_id=$1', [runId]);
  if (row && (row.protocol !== 1 || digest(row.input) !== row.input_hash || digest(row.checkpoint) !== row.checkpoint_hash || row.result && digest(row.result) !== row.result_hash)) conflict();
  return row;
}
export async function claimOptimizerRun(host: CodexSubscriptionContext, input: Record<string, unknown>, skillText: string, runtimeMs: number): Promise<{ claim: OptimizerClaim; row: OptimizerRun }> {
  if (jsonBytes(input) > 2097152) conflict();
  const inputHash = digest(input), token = randomUUID();
  await host.checkAuthority?.(); host.signal?.throwIfAborted();
  const row = await host.engine.transaction(async tx => {
    await declareDurablePersistence(tx); await host.checkAuthorityInTransaction?.(tx);
    const [grant] = await tx.executeRaw<{ account_lane: string; parent_run_id: string | null; deadline: Date | string }>('SELECT account_lane,parent_run_id,deadline FROM codex_subscription_runs WHERE run_id=$1 FOR UPDATE', [host.runId]);
    if (!grant || grant.parent_run_id || grant.account_lane !== CODEX_JOB_ACCOUNT_LANE) throw new SubscriptionAdmissionError('subscription_required');
    const initial: OptimizerCheckpoint = { bestText: skillText, bestScore: null, baselineScore: null, nextStep: 0, acceptedSteps: 0, rejected: [], decisions: [] };
    await tx.executeRaw(`INSERT INTO codex_skillopt_runs(run_id,protocol,input_hash,input,checkpoint,checkpoint_hash,deadline,state)
      VALUES($1,1,$2,$3::text::jsonb,$4::text::jsonb,$5,$6,'idle') ON CONFLICT DO NOTHING`,
    [host.runId, inputHash, JSON.stringify(input), JSON.stringify(initial), digest(initial), new Date(Math.min(Date.now() + runtimeMs, new Date(grant.deadline).getTime())).toISOString()]);
    const prior = await readOptimizerRun(tx, host.runId);
    if (!prior || prior.input_hash !== inputHash) conflict();
    const pending = await tx.executeRaw(`SELECT a.attempt_id FROM codex_subscription_attempts a JOIN codex_subscription_runs r USING(run_id)
      WHERE (r.run_id=$1 OR r.parent_run_id=$1) AND a.state IN ('active','unresolved') LIMIT 1`, [host.runId]);
    if (pending.length) throw new SubscriptionAdmissionError('subscription_lane_busy');
    const rows = await tx.executeRaw(`UPDATE codex_skillopt_runs SET owner_token=$2::uuid,lease_until=now()+interval '15 minutes',state=CASE WHEN result IS NULL THEN 'running' ELSE state END
      WHERE run_id=$1 AND (owner_token IS NULL OR lease_until<now()) RETURNING run_id`, [host.runId, token]);
    if (rows.length !== 1) throw new SubscriptionAdmissionError('subscription_owner_lost');
    return prior!;
  });
  return { claim: { runId: host.runId, inputHash, token, deadline: new Date(row.deadline).getTime() }, row };
}
export async function fenceOptimizerRun(tx: BrainEngine, host: CodexSubscriptionContext, claim: OptimizerClaim, requireTime = true): Promise<void> {
  await declareDurablePersistence(tx); host.signal?.throwIfAborted(); await host.checkAuthorityInTransaction?.(tx);
  const rows = await tx.executeRaw(`UPDATE codex_skillopt_runs SET lease_until=now()+interval '15 minutes'
    WHERE run_id=$1 AND input_hash=$2 AND owner_token=$3::uuid AND lease_until>now() AND (NOT $4::boolean OR deadline>now()) RETURNING run_id`,
  [claim.runId, claim.inputHash, claim.token, requireTime]);
  if (rows.length !== 1) throw new SubscriptionAdmissionError('subscription_owner_lost');
}
export async function saveOptimizerCheckpoint(host: CodexSubscriptionContext, claim: OptimizerClaim, value: OptimizerCheckpoint): Promise<void> {
  if (jsonBytes(value) > 524288) conflict();
  await host.engine.transaction(async tx => {
    await fenceOptimizerRun(tx, host, claim);
    await tx.executeRaw('UPDATE codex_skillopt_runs SET checkpoint=$2::text::jsonb,checkpoint_hash=$3 WHERE run_id=$1 AND result IS NULL', [claim.runId, JSON.stringify(value), digest(value)]);
  });
}
export async function saveOptimizerResult(host: CodexSubscriptionContext, claim: OptimizerClaim, result: RunSkillOptResult): Promise<void> {
  if (jsonBytes(result) > 524288) conflict();
  await host.engine.transaction(async tx => {
    await fenceOptimizerRun(tx, host, claim);
    const row = await readOptimizerRun(tx, claim.runId);
    if (row?.result && digest(row.result) !== digest(result)) conflict();
    await tx.executeRaw("UPDATE codex_skillopt_runs SET result=$2::text::jsonb,result_hash=$3,state='computed' WHERE run_id=$1 AND result IS NULL", [claim.runId, JSON.stringify(result), digest(result)]);
  });
}
export async function releaseOptimizerRun(host: CodexSubscriptionContext, claim: OptimizerClaim): Promise<void> {
  await host.engine.transaction(async tx => {
    await declareDurablePersistence(tx);
    const [pending] = await tx.executeRaw<{ pending: boolean }>(`SELECT EXISTS(SELECT 1 FROM codex_subscription_attempts a JOIN codex_subscription_runs r USING(run_id)
      WHERE (r.run_id=$1 OR r.parent_run_id=$1) AND a.state IN ('active','unresolved')) AS pending`, [claim.runId]);
    await tx.executeRaw(`UPDATE codex_skillopt_runs SET owner_token=NULL,lease_until=NULL,state=CASE WHEN $3 THEN 'needs_reconciliation' WHEN result IS NULL THEN 'idle' ELSE state END
      WHERE run_id=$1 AND owner_token=$2::uuid`, [claim.runId, claim.token, pending?.pending === true]);
  });
}

/** Effects have already been reconciled; only the host's publication receipt may differ. */
export async function completeOptimizerRun(tx: BrainEngine, host: CodexSubscriptionContext, claim: OptimizerClaim, result: RunSkillOptResult): Promise<void> {
  await fenceOptimizerRun(tx, host, claim, false);
  const row = await readOptimizerRun(tx, claim.runId);
  if (!row?.result || row.result.finalText !== result.finalText || digest(row.result.receipt) !== digest(result.receipt) || row.result.outcome !== result.outcome) conflict();
  await tx.executeRaw("UPDATE codex_skillopt_runs SET result=$2::text::jsonb,result_hash=$3,state='complete' WHERE run_id=$1", [claim.runId, JSON.stringify(result), digest(result)]);
}
