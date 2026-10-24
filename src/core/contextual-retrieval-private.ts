import { assertSubscriptionTarget, subscriptionTargetTransaction } from './ai/subscription-target.ts';
import type { BrainEngine } from './engine.ts';
import type { ReembedPageArgs } from './contextual-retrieval-service.ts';
import { readPrivateCodexConfig, assertPrivateRoute } from './ai/private-policy.ts';
import { resolveModel } from './model-config.ts';
import { codexSubscriptionContext } from './ai/subscription-context.ts';
import { SubscriptionAdmissionError } from './ai/subscription-admission.ts';
import { CodexProposalError } from './ai/providers/codex-contract.ts';
import { hasAIInvocationGuard, withAIInvocationPreflight } from './ai/invocation-guard.ts';
import { pageBodyBytes } from './page-body/page-shape.ts';

/** Resolve every explicit pin, including a shadowed legacy argument, before work. */
export async function privateContextualModel(args: ReembedPageArgs, fallback: string): Promise<string> {
  if (!readPrivateCodexConfig()) return fallback;
  for (const [key, value] of [['synopsisModel', args.synopsisModel], ['haikuModel', args.haikuModel]] as const)
    if (value !== undefined) assertPrivateRoute(value, `contextual:${key}`);
  if (args.generateSynopsis) throw new CodexProposalError('invalid_input');
  const selection = { privateRole: args.privateRole ?? 'contextual-synopsis', cliFlag: args.synopsisModel ?? args.haikuModel,
    configKey: 'models.contextual_synopsis', deprecatedConfigKey: 'contextual_retrieval.haiku_model',
    envVar: 'GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL', tier: 'utility' as const, fallback };
  const owner = codexSubscriptionContext()?.engine;
  if (owner && owner !== args.engine) await resolveModel(owner, selection);
  return resolveModel(args.engine, selection);
}

/** A subscription grant authorizes summaries, never unpriced/unbounded paid embeddings. */
export async function withPrivateContextualPreparation<T>(args: ReembedPageArgs, synopsis: boolean, chunks: number, run: () => Promise<T>): Promise<T> {
  if (!readPrivateCodexConfig()) return run();
  const context = codexSubscriptionContext();
  if (synopsis && !context) throw new SubscriptionAdmissionError('subscription_required');
  if (!context) return run(); // Standalone embedding-only workflows retain their own admission.
  if (chunks > 256 || args.synopsisMaxTokens !== undefined && (!Number.isSafeInteger(args.synopsisMaxTokens) || args.synopsisMaxTokens < 16 || args.synopsisMaxTokens > 8192)) throw new CodexProposalError('invalid_input');
  await assertSubscriptionTarget(args.engine);
  if (!hasAIInvocationGuard()) throw new SubscriptionAdmissionError('subscription_auxiliary_budget_required');
  if (context.signal?.aborted || args.abortSignal?.aborted) throw new CodexProposalError('aborted');
  await context.checkAuthority?.();
  return withAIInvocationPreflight(async () => {
    if (context.signal?.aborted || args.abortSignal?.aborted) throw new CodexProposalError('aborted');
    await context.checkAuthority?.();
  }, run);
}

/** Fence the real publication transaction before taking its page locks. */
export async function fencePrivateContextualPublication(tx: BrainEngine, sourceId: string, incarnation: string, signal?: AbortSignal): Promise<void> {
  if (!readPrivateCodexConfig()) return;
  const context = codexSubscriptionContext();
  if (context?.signal?.aborted || signal?.aborted) throw new CodexProposalError('aborted');
  const [source] = await tx.executeRaw<{incarnation:string;archived:boolean}>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [sourceId]);
  if (!source || source.archived || source.incarnation !== incarnation) throw new SubscriptionAdmissionError('subscription_identity_conflict');
}

export function contextualSignal(signal?: AbortSignal): AbortSignal | undefined {
  const inherited = readPrivateCodexConfig() ? codexSubscriptionContext()?.signal : undefined;
  return inherited && signal ? AbortSignal.any([inherited, signal]) : inherited ?? signal;
}

/** The host fence stays in its own database, including for disposable benchmark targets. */
export function contextualPublicationTransaction<T>(engine: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return readPrivateCodexConfig() && codexSubscriptionContext()
    ? subscriptionTargetTransaction(engine, run) : engine.transaction(run);
}

/** Empty inventory is not proof that a nonempty page was successfully indexed. */
export function assertPrivateEmptyProjection(page: { compiled_truth: string; timeline: string; body_storage?: 'inline' | 'segmented' | null; body_bytes?: number | null }): void {
  if (readPrivateCodexConfig() && pageBodyBytes(page) > 0)
    throw new Error('private_contextual_projection_incomplete');
}
