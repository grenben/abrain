import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { CodexSubscriptionContext } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { digest, jsonBytes } from '../persistence/digest.ts';
import { ensureLocalOptimizerGrant } from './codex-local-grant.ts';
import type { BootstrapFiles } from './codex-bootstrap-files.ts';
import type { BootstrapResult } from './bootstrap-benchmark.ts';
export interface BootstrapInput { controls: Record<string, unknown>; files: BootstrapFiles; sourceId: string; incarnation: string; model: string; bin: string; policy_fingerprint?: string }
export interface BootstrapAccepted { output: string; result: BootstrapResult }
export interface BootstrapRun { run_id: string; protocol: number; input: BootstrapInput; input_hash: string;
  request_id?: string | null; job_id?: number | string | null; owner_token: string | null; lease_until: Date | string | null; result: BootstrapAccepted | null; result_hash: string | null; completed: boolean }
export interface BootstrapClaim { runId: string; inputHash: string; token: string }
export const bootstrapConflict = (): never => { throw new SubscriptionAdmissionError('subscription_identity_conflict'); };
export async function readBootstrapRun(engine: BrainEngine, runId: string): Promise<BootstrapRun | undefined> {
  const [row] = await engine.executeRaw<BootstrapRun>('SELECT * FROM codex_skillopt_bootstraps WHERE run_id=$1', [runId]);
  if (row && (row.protocol !== 1 || digest(row.input) !== row.input_hash || row.result && digest(row.result) !== row.result_hash)) bootstrapConflict();
  return row;
}
export async function claimBootstrapRun(host: CodexSubscriptionContext, input: BootstrapInput): Promise<{ claim: BootstrapClaim; row: BootstrapRun }> {
  if (jsonBytes(input) > 2097152) bootstrapConflict();
  host.signal?.throwIfAborted(); await host.checkAuthority?.();
  const token = randomUUID(), inputHash = digest(input);
  const row = await host.engine.transaction(async tx => {
    await declareDurablePersistence(tx); await host.checkAuthorityInTransaction?.(tx);
    await ensureLocalOptimizerGrant(tx, host.runId, 'bootstrap');
    const [root] = await tx.executeRaw<{ parent_run_id: string | null }>('SELECT parent_run_id FROM codex_subscription_runs WHERE run_id=$1 FOR UPDATE', [host.runId]);
    if (!root || root.parent_run_id) throw new SubscriptionAdmissionError('subscription_required');
    const pending = await tx.executeRaw("SELECT attempt_id FROM codex_subscription_attempts WHERE run_id=$1 AND state IN ('active','unresolved') LIMIT 1", [host.runId]);
    if (pending.length) throw new SubscriptionAdmissionError('subscription_lane_busy');
    await tx.executeRaw('INSERT INTO codex_skillopt_bootstraps(run_id,protocol,input,input_hash) VALUES($1,1,$2::text::jsonb,$3) ON CONFLICT DO NOTHING',
      [host.runId, JSON.stringify(input), inputHash]);
    const previous = await readBootstrapRun(tx, host.runId);
    if (!previous) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    if (previous.input_hash !== inputHash) bootstrapConflict();
    const requestId = (input.controls.allowance as { requestId?: unknown } | undefined)?.requestId;
    if (previous.request_id != null && (typeof requestId !== 'string' || previous.request_id.toLowerCase() !== requestId.toLowerCase() ||
        !host.publicationFence || Number(previous.job_id) !== host.publicationFence.jobId)) bootstrapConflict();
    if (previous.request_id == null && host.publicationFence) bootstrapConflict();
    const updated = await tx.executeRaw("UPDATE codex_skillopt_bootstraps SET owner_token=$2::uuid,lease_until=now()+interval '15 minutes' WHERE run_id=$1 AND (owner_token IS NULL OR lease_until<now()) RETURNING run_id", [host.runId, token]);
    if (updated.length !== 1) throw new SubscriptionAdmissionError('subscription_owner_lost');
    return previous!;
  });
  return { claim: { runId: host.runId, inputHash, token }, row };
}
export async function fenceBootstrapRun(tx: BrainEngine, host: CodexSubscriptionContext, claim: BootstrapClaim, requireTime = true): Promise<void> {
  await declareDurablePersistence(tx); host.signal?.throwIfAborted(); await host.checkAuthorityInTransaction?.(tx);
  const rows = await tx.executeRaw(`UPDATE codex_skillopt_bootstraps p SET lease_until=now()+interval '15 minutes'
    FROM codex_subscription_runs r WHERE p.run_id=$1 AND r.run_id=p.run_id AND p.input_hash=$2 AND p.owner_token=$3::uuid
      AND p.lease_until>now() AND (NOT $4::boolean OR r.deadline>now()) RETURNING p.run_id`, [claim.runId, claim.inputHash, claim.token, requireTime]);
  if (rows.length !== 1) throw new SubscriptionAdmissionError('subscription_owner_lost');
}
export async function saveBootstrapAccepted(tx: BrainEngine, claim: BootstrapClaim, result: BootstrapAccepted): Promise<void> {
  if (jsonBytes(result) > 1048576) bootstrapConflict();
  const old = await readBootstrapRun(tx, claim.runId); if (old?.result && digest(old.result) !== digest(result)) bootstrapConflict();
  await tx.executeRaw('UPDATE codex_skillopt_bootstraps SET result=$2::text::jsonb,result_hash=$3 WHERE run_id=$1 AND owner_token=$4::uuid',
    [claim.runId, JSON.stringify(result), digest(result), claim.token]);
}
export async function completeBootstrapRun(tx: BrainEngine, claim: BootstrapClaim): Promise<void> {
  const rows = await tx.executeRaw('UPDATE codex_skillopt_bootstraps SET completed=true WHERE run_id=$1 AND owner_token=$2::uuid AND result IS NOT NULL RETURNING run_id', [claim.runId, claim.token]);
  if (rows.length !== 1) throw new SubscriptionAdmissionError('subscription_owner_lost');
}
export async function releaseBootstrapRun(host: CodexSubscriptionContext, claim: BootstrapClaim): Promise<void> {
  await host.engine.transaction(async tx => { await declareDurablePersistence(tx);
    await tx.executeRaw('UPDATE codex_skillopt_bootstraps SET owner_token=NULL,lease_until=NULL WHERE run_id=$1 AND owner_token=$2::uuid', [claim.runId, claim.token]); });
}
