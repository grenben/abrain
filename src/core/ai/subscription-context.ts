import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import type { SubscriptionAttempt } from './subscription-admission.ts';

export interface CodexSubscriptionContext {
  engine: BrainEngine; runId: string; repair?: boolean;
  /** Host worker fencing, refreshed before dispatch and acceptance. Never supplied by the model. */
  checkAuthority?: () => Promise<void>;
  /** Lock the current job claim while accepting a durable publication. */
  checkAuthorityInTransaction?: (tx: BrainEngine) => Promise<void>;
  signal?: AbortSignal;
  /** Durable worker fence for deferred prepared writes; supplied only by the host. */
  publicationFence?: { jobId: number; lockToken: string; jobDigest: string };
}
const contexts = new AsyncLocalStorage<CodexSubscriptionContext>();
const admitted = new AsyncLocalStorage<SubscriptionAttempt>();
/** Host-owned scope, backed by an already-authorized durable envelope. No payload inference. */
export function withCodexSubscription<T>(context: CodexSubscriptionContext, run: () => Promise<T>): Promise<T> {
  return contexts.run(context, run);
}
export function codexSubscriptionContext(): CodexSubscriptionContext | undefined { return contexts.getStore(); }
export function withAdmittedCodexAttempt<T>(attempt: SubscriptionAttempt, run: () => Promise<T>): Promise<T> { return admitted.run(attempt, run); }
export function hasAdmittedCodexAttempt(model: string): boolean { return model.startsWith('codex-cli:') && admitted.getStore() !== undefined; }
