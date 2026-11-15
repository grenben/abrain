import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import type { BatchClaim } from './codex-batch-store.ts';
const members = new AsyncLocalStorage<{ claim: BatchClaim; runId: string; inputHash: string }>();
/** Only the batch coordinator creates this host scope; no serialized job field can grant it. */
export function withOptimizerBatchMember<T>(claim: BatchClaim, runId: string, inputHash: string, run: () => Promise<T>): Promise<T> {
  return members.run({ claim, runId, inputHash }, run);
}
export async function assertOptimizerBatchMember(tx: BrainEngine, runId: string, parentRunId: string, inputHash?: string): Promise<void> {
  const member = members.getStore();
  if (!member || member.runId !== runId || member.claim.runId !== parentRunId || inputHash !== undefined && member.inputHash !== inputHash)
    throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const rows = await tx.executeRaw(`SELECT m.run_id FROM codex_skillopt_batch_members m JOIN codex_skillopt_batches b ON b.run_id=m.batch_run_id
    WHERE m.run_id=$1 AND m.input_hash=$2 AND b.run_id=$3 AND b.input_hash=$4 AND b.owner_token=$5::uuid
      AND b.lease_until>now() AND b.state='running' FOR UPDATE OF b,m`,
  [runId, member.inputHash, parentRunId, member.claim.inputHash, member.claim.token]);
  if (rows.length !== 1) throw new SubscriptionAdmissionError('subscription_owner_lost');
}
