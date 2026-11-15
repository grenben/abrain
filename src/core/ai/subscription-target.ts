import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { assertEphemeralBrain, withEphemeralBrainUse } from '../ephemeral-brain.ts';
import { readPrivateCodexConfig } from './private-policy.ts';
import { codexSubscriptionContext, withCodexSubscription, type CodexSubscriptionContext } from './subscription-context.ts';
import { SubscriptionAdmissionError } from './subscription-admission.ts';
import { CodexProposalError } from './providers/codex-contract.ts';

interface ScratchScope { engine: BrainEngine; brainId: string; ownerId: string; context: CodexSubscriptionContext; open: boolean }
const targets = new AsyncLocalStorage<ScratchScope>();
const conflict = () => new SubscriptionAdmissionError('subscription_identity_conflict');
async function brainId(engine: BrainEngine, lock = false): Promise<string> {
  const [row] = await engine.executeRaw<{ brain_id: string }>(`SELECT brain_id FROM persistence_brain WHERE singleton=1${lock ? ' FOR SHARE' : ''}`);
  if (!row) throw conflict();
  return row.brain_id;
}
function checkScope(scope: ScratchScope): void {
  if (!scope.open || codexSubscriptionContext() !== scope.context) throw conflict();
  if (scope.context.signal?.aborted) throw new CodexProposalError('aborted');
}
async function fenceOwner(tx: BrainEngine, context: CodexSubscriptionContext): Promise<void> {
  await context.checkAuthorityInTransaction?.(tx);
  const [run] = await tx.executeRaw<{ current: boolean }>(
    'SELECT deadline > now() AS current FROM codex_subscription_runs WHERE run_id=$1 FOR SHARE', [context.runId]);
  if (!run) throw new SubscriptionAdmissionError('subscription_required');
  if (!run.current) throw new SubscriptionAdmissionError('subscription_exhausted');
  if (context.signal?.aborted) throw new CodexProposalError('aborted');
}

/** Host scope for derived, disposable benchmark state. Durable outputs belong to the owner. */
export async function withSubscriptionScratch<T>(engine: BrainEngine, run: () => Promise<T>): Promise<T> {
  return withEphemeralBrainUse(engine, async () => {
    const original = codexSubscriptionContext();
    if (!readPrivateCodexConfig() || !original) return run();
    const targetId = await assertEphemeralBrain(engine), ownerId = await brainId(original.engine);
    if (engine === original.engine || targetId === ownerId || targets.getStore()) throw conflict();
    await original.checkAuthority?.();
    await original.engine.transaction(tx => fenceOwner(tx, original));
    const context = { ...original };
    const scope: ScratchScope = { engine, brainId: targetId, ownerId, context, open: true };
    context.checkAuthority = async () => {
      checkScope(scope);
      if (await assertEphemeralBrain(engine) !== targetId || await brainId(original.engine) !== ownerId) throw conflict();
      await original.checkAuthority?.();
    };
    return targets.run(scope, () => withCodexSubscription(context, async () => {
      try { const result = await run(); await context.checkAuthority!(); return result; }
      finally { scope.open = false; }
    }));
  });
}

/** Foreign brains require the exact live factory-owned scope, never a model-authored ID. */
export async function assertSubscriptionTarget(engine: BrainEngine): Promise<boolean> {
  const context = codexSubscriptionContext();
  if (!context) throw new SubscriptionAdmissionError('subscription_required');
  if (context.signal?.aborted) throw new CodexProposalError('aborted');
  const targetId = await brainId(engine), ownerId = await brainId(context.engine);
  if (targetId === ownerId) return false;
  const scope = targets.getStore();
  if (!scope || scope.engine !== engine || scope.brainId !== targetId || scope.ownerId !== ownerId) throw conflict();
  checkScope(scope);
  await assertEphemeralBrain(engine);
  return true;
}

/** Hold the owner's fence while committing scratch effects; never pass a foreign tx to its hook. */
export async function subscriptionTargetTransaction<T>(engine: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
  const context = codexSubscriptionContext();
  if (!context) throw new SubscriptionAdmissionError('subscription_required');
  const scratch = await assertSubscriptionTarget(engine);
  if (!scratch) return engine.transaction(async tx => { await context.checkAuthorityInTransaction?.(tx); return run(tx); });
  const scope = targets.getStore()!;
  try {
    return await context.engine.transaction(async owner => {
      checkScope(scope);
      if (await brainId(owner, true) !== scope.ownerId) throw conflict();
      await fenceOwner(owner, context);
      const value = await engine.transaction(async tx => {
        if (await brainId(tx, true) !== scope.brainId) throw conflict();
        const result = await run(tx);
        checkScope(scope);
        return result;
      });
      checkScope(scope);
      return value;
    });
  } catch (error) {
    // Cross-DB commits are not atomic. If the owner fails after the scratch
    // commit, invalidate this question: no later inference may use its state.
    scope.open = false;
    throw error;
  }
}
