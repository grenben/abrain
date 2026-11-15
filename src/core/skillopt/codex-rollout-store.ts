import { assertOptimizerBatchMember } from './codex-batch-context.ts';
import { assertOptimizerCycle } from './codex-cycle-context.ts';
import type { CodexSubscriptionContext } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from '../minions/queue.ts';
import { semanticJobPayload } from '../minions/admission.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../minions/subscription-jobs.ts';
import { APPLICATION_AUTHORITY } from '../minions/submission-authority.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { digest } from '../persistence/digest.ts';
import type { Trajectory } from './types.ts';

export const rolloutConflict = (): never => { throw new SubscriptionAdmissionError('subscription_identity_conflict'); };
export interface RolloutBinding { run_id: string; invocation_id: string; protocol: number; input_hash: string; job_id: number; trajectory: Trajectory | null; trajectory_hash: string | null }
export async function fenceRolloutParent(tx: BrainEngine, host: CodexSubscriptionContext): Promise<void> {
  await declareDurablePersistence(tx);
  host.signal?.throwIfAborted();
  await host.checkAuthorityInTransaction?.(tx);
}
export async function bindRollout(host: CodexSubscriptionContext, invocationId: string, inputHash: string, data: Record<string, unknown>, incarnation: string): Promise<RolloutBinding> {
  await host.checkAuthority?.();
  return host.engine.transaction(async tx => {
    await fenceRolloutParent(tx, host);
    await tx.executeRaw('SELECT gbrain_codex_subscription_lock_path($1)', [host.runId]);
    await assertOptimizerCycle(tx, host.runId, 'rollout');
    const [grant] = await tx.executeRaw<{ account_lane: string; parent_run_id: string | null; max_attempts: number; max_turns: number; deadline: Date | string }>(
      'SELECT account_lane,parent_run_id,max_attempts,max_turns,deadline FROM codex_subscription_runs WHERE run_id=$1 FOR UPDATE', [host.runId]);
    if (!grant || grant.account_lane !== CODEX_JOB_ACCOUNT_LANE) rolloutConflict();
    if (grant!.parent_run_id) await assertOptimizerBatchMember(tx, host.runId, grant!.parent_run_id);
    else if ((await tx.executeRaw('SELECT run_id FROM codex_skillopt_batches WHERE run_id=$1', [host.runId])).length) rolloutConflict();
    const [prior] = await tx.executeRaw<RolloutBinding>('SELECT * FROM codex_skillopt_rollouts WHERE run_id=$1 AND invocation_id=$2 FOR UPDATE', [host.runId, invocationId]);
    if (prior) {
      if (prior.protocol !== 1 || prior.input_hash !== inputHash || prior.trajectory && digest(prior.trajectory) !== prior.trajectory_hash) rolloutConflict();
      const job = await new MinionQueue(tx).getJob(Number(prior.job_id));
       if (!job || digest(semanticJobPayload(job.data)) !== digest(semanticJobPayload(data)) ||
           prior.trajectory && job.status !== 'completed') rolloutConflict();
      await checkSource(tx, data.source_id, incarnation);
      return prior;
    }
    const [count] = await tx.executeRaw<{ count: string }>('SELECT count(*)::text AS count FROM codex_skillopt_rollouts WHERE run_id=$1', [host.runId]);
    if (Number(count?.count) >= grant!.max_attempts) throw new SubscriptionAdmissionError('subscription_exhausted');
    const key = `skillopt-codex-${digest({ runId: host.runId, invocationId })}`;
    const queue = new MinionQueue(tx);
    const job = await queue.add('subagent', data, { queue: key, idempotency_key: key,
      max_attempts: 1, max_stalled: 5, remove_on_complete: false, remove_on_fail: false,
      timeout_ms: Math.max(1, new Date(grant!.deadline).getTime() - Date.now()), lock_duration_ms: 900000 },
    { submissionAuthority: APPLICATION_AUTHORITY, allowProtectedSubmit: true, codexSubscription: {
      parentRunId: host.runId, maxAttempts: grant!.max_attempts, maxTurns: grant!.max_turns, deadline: new Date(grant!.deadline) } });
    const [row] = await tx.executeRaw<RolloutBinding>(`INSERT INTO codex_skillopt_rollouts(run_id,invocation_id,protocol,input_hash,job_id)
      VALUES($1,$2,1,$3,$4) RETURNING *`, [host.runId, invocationId, inputHash, job.id]);
    await checkSource(tx, data.source_id, incarnation);
    return row!;
  });
}

/** Only reclaim this evaluation, never sweep unrelated work. Ambiguous inference retains its lane. */
export async function recoverRollout(host: CodexSubscriptionContext, binding: RolloutBinding): Promise<void> {
  await host.engine.transaction(async tx => {
    await fenceRolloutParent(tx, host);
    const pending = await tx.executeRaw(`SELECT attempt_id FROM codex_subscription_attempts WHERE run_id LIKE $1 AND state IN ('active','unresolved')`, [`codex-job:${binding.job_id}:%`]);
    if (pending.length) throw new SubscriptionAdmissionError('subscription_lane_busy');
    await tx.executeRaw(`UPDATE minion_jobs SET status='waiting',lock_token=NULL,lock_until=NULL,stalled_counter=stalled_counter+1
      WHERE id=$1 AND status='active' AND lock_until<now()-interval '15 seconds' AND stalled_counter+1<max_stalled`, [binding.job_id]);
  });
}

async function checkSource(tx: BrainEngine, sourceId: unknown, incarnation: string): Promise<void> {
  const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [sourceId]);
  if (!source || source.archived || source.incarnation !== incarnation) rolloutConflict();
}
