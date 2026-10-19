import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';

interface PinnedRun { engine: BrainEngine; runId: string }
const pinned = new AsyncLocalStorage<PinnedRun>();

/** Only the corpus-pinning CLI wrapper opens this scope for a private probe. */
export function withPrivateEvalCorpusPin<T>(engine: BrainEngine, runId: string, run: () => Promise<T>): Promise<T> {
  return pinned.run({ engine, runId }, run);
}

export function assertPrivateEvalCorpusPin(engine: BrainEngine): void {
  const bound = pinned.getStore(), context = codexSubscriptionContext();
  if (!bound || bound.engine !== engine || bound.runId !== context?.runId) {
    throw new SubscriptionAdmissionError('subscription_identity_conflict');
  }
}
