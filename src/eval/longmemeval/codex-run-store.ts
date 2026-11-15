import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../core/engine.ts';
import type { CodexSubscriptionContext } from '../../core/ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../../core/ai/subscription-admission.ts';
import { declareDurablePersistence } from '../../core/persistence/protocol.ts';
import { digest, jsonBytes } from '../../core/persistence/digest.ts';

export type EvalStage = 'answer' | 'judged';
export interface EvalClaim { runId: string; bindingHash: string; token: string; count: number; stage: EvalStage }
export interface EvalOutcome { row: Record<string, unknown>; rerankerSkipped: boolean; vectorDegraded: boolean; expansionFailed: boolean }
const conflict = () => new SubscriptionAdmissionError('subscription_identity_conflict');
const lost = () => new SubscriptionAdmissionError('subscription_owner_lost');
const leaseMs = 900000; // longer than the maximum native call; no reclaim while any attempt is unsettled

async function hostFence(tx: BrainEngine, host: CodexSubscriptionContext): Promise<void> {
  await declareDurablePersistence(tx);
  await host.checkAuthorityInTransaction?.(tx);
  host.signal?.throwIfAborted();
}

export async function claimEvalRun(host: CodexSubscriptionContext, bindingHash: string, count: number, stage: EvalStage): Promise<EvalClaim> {
  if (!/^[a-f0-9]{64}$/.test(bindingHash) || !Number.isSafeInteger(count) || count < 1 || count > 1000) throw conflict();
  await host.checkAuthority?.();
  const claim: EvalClaim = { runId: host.runId, bindingHash, count, stage, token: randomUUID() };
  await host.engine.transaction(async tx => {
    await hostFence(tx, host);
    const [grant] = await tx.executeRaw('SELECT run_id FROM codex_subscription_runs WHERE run_id=$1 FOR UPDATE', [host.runId]);
    if (!grant) throw new SubscriptionAdmissionError('subscription_required');
    await tx.executeRaw(`INSERT INTO codex_eval_runs(run_id,protocol,binding_hash,question_count,required_stage,state)
      VALUES($1,1,$2,$3,$4,'idle') ON CONFLICT DO NOTHING`, [host.runId,bindingHash,count,stage]);
    const [row] = await tx.executeRaw<{ protocol: number; binding_hash: string; question_count: number; required_stage: string; busy: boolean }>(
      `SELECT *,owner_token IS NOT NULL AND lease_until>now() AS busy FROM codex_eval_runs WHERE run_id=$1 FOR UPDATE`, [host.runId]);
    if (!row || row.protocol !== 1 || row.binding_hash !== bindingHash || row.question_count !== count || row.required_stage !== stage) throw conflict();
    if (row.busy) throw lost();
    const pending = await tx.executeRaw("SELECT attempt_id FROM codex_subscription_attempts WHERE run_id=$1 AND state IN ('active','unresolved')", [host.runId]);
    if (pending.length) throw new SubscriptionAdmissionError('subscription_lane_busy');
    await tx.executeRaw(`UPDATE codex_eval_runs SET owner_token=$2::uuid,lease_until=now()+($3::double precision*interval '1 millisecond'),state='running' WHERE run_id=$1`, [host.runId,claim.token,leaseMs]);
  });
  return claim;
}

/** Called within the host transaction, retaining the owner fence through publication. */
export async function fenceEvalRun(tx: BrainEngine, host: CodexSubscriptionContext, claim: EvalClaim): Promise<void> {
  await hostFence(tx, host);
  const rows = await tx.executeRaw(`UPDATE codex_eval_runs SET lease_until=now()+($4::double precision*interval '1 millisecond')
    WHERE run_id=$1 AND binding_hash=$2 AND owner_token=$3::uuid AND lease_until>now() AND state='running' RETURNING run_id`,
  [claim.runId,claim.bindingHash,claim.token,leaseMs]);
  if (rows.length !== 1) throw lost();
}

export async function readEvalResult<T extends EvalOutcome>(tx: BrainEngine, claim: EvalClaim, question: unknown, stage: EvalStage): Promise<T | undefined> {
  const key = digest((question as { question_id: string }).question_id), inputHash = digest(question);
  const [row] = await tx.executeRaw<{ input_hash: string; payload: T; payload_hash: string }>(
    'SELECT input_hash,payload,payload_hash FROM codex_eval_results WHERE run_id=$1 AND question_key=$2 AND stage=$3', [claim.runId,key,stage]);
  if (!row) return undefined;
  if (row.input_hash !== inputHash || digest(row.payload) !== row.payload_hash || !validEvalOutcome(row.payload, stage)) throw conflict();
  return row.payload;
}

export function validEvalOutcome(out: EvalOutcome, stage: EvalStage): boolean {
  return !!out && typeof out.row?.question_id === 'string' && out.rerankerSkipped === false && out.vectorDegraded === false && out.expansionFailed === false &&
    typeof out.row.error !== 'string' && (stage === 'answer' || typeof out.row.judge_correct === 'boolean' &&
    typeof out.row.judge_error !== 'string' && out.row.judge_skipped !== 'budget') && jsonBytes(out) <= 524288;
}

export async function retainEvalResult<T extends EvalOutcome>(tx: BrainEngine, claim: EvalClaim, question: unknown, stage: EvalStage, outcome: T): Promise<T> {
  const owners = await tx.executeRaw(`SELECT run_id FROM codex_eval_runs WHERE run_id=$1 AND binding_hash=$2
    AND owner_token=$3::uuid AND lease_until>now() AND state='running' FOR UPDATE`, [claim.runId,claim.bindingHash,claim.token]);
  if (owners.length !== 1) throw lost();
  if (!validEvalOutcome(outcome, stage) || outcome.row.question_id !== (question as { question_id: string }).question_id) throw new Error('private_eval_result_incomplete');
  const prior = await readEvalResult<T>(tx, claim, question, stage);
  if (prior) { if (digest(prior) !== digest(outcome)) throw conflict(); return prior; }
  if (stage === 'judged' && !await readEvalResult(tx, claim, question, 'answer')) throw conflict();
  await tx.executeRaw(`INSERT INTO codex_eval_results(run_id,question_key,input_hash,stage,payload,payload_hash)
    VALUES($1,$2,$3,$4,$5::text::jsonb,$6)`, [claim.runId,digest((question as { question_id: string }).question_id),digest(question),stage,JSON.stringify(outcome),digest(outcome)]);
  return (await readEvalResult<T>(tx, claim, question, stage))!;
}

/** Uncertain native attempts keep the account lane; releasing a stopped run never refunds them. */
export async function releaseEvalRun(host: CodexSubscriptionContext, claim: EvalClaim, success: boolean): Promise<void> {
  await host.engine.transaction(async tx => {
    await declareDurablePersistence(tx);
    if (success) await hostFence(tx, host);
    const [row] = await tx.executeRaw<{ current: boolean; live: boolean }>('SELECT owner_token=$2::uuid AS current,lease_until>now() AS live FROM codex_eval_runs WHERE run_id=$1 FOR UPDATE', [claim.runId,claim.token]);
    if (!row?.current || success && !row.live) throw lost();
    const pending = await tx.executeRaw("SELECT attempt_id FROM codex_subscription_attempts WHERE run_id=$1 AND state IN ('active','unresolved')", [claim.runId]);
    const [results] = await tx.executeRaw<{ count: number }>('SELECT count(*)::int AS count FROM codex_eval_results WHERE run_id=$1 AND stage=$2', [claim.runId,claim.stage]);
    if (success) {
      if (pending.length || results?.count !== claim.count) throw new Error('private_eval_result_incomplete');
    }
    await tx.executeRaw(`UPDATE codex_eval_runs SET owner_token=NULL,lease_until=NULL,state=$2 WHERE run_id=$1`,
      [claim.runId,pending.length ? 'needs_reconciliation' : success ? 'complete' : 'idle']);
  });
}
