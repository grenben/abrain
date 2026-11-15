import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
const contexts = new AsyncLocalStorage<{ runId: string; inputHash: string }>();
export function withOptimizerCycle<T>(runId: string, inputHash: string, run: () => Promise<T>): Promise<T> {
  return contexts.run({ runId, inputHash }, run);
}
/** A scheduled selection cannot be adopted by an unrelated batch or single run. */
export async function assertOptimizerCycle(tx: BrainEngine, runId: string, kind: string): Promise<void> {
  const [cycle] = await tx.executeRaw<{ input_hash: string; state: string }>('SELECT input_hash,state FROM codex_skillopt_cycles WHERE run_id=$1', [runId]);
  if (cycle && (cycle.state === 'failed' || kind !== 'batch' || contexts.getStore()?.runId !== runId || contexts.getStore()?.inputHash !== cycle.input_hash))
    throw new SubscriptionAdmissionError('subscription_identity_conflict');
}
