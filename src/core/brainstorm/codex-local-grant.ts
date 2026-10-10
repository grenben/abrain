import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../ai/subscription-context.ts';
import { readPrivateCodexConfig } from '../ai/private-policy.ts';
import { withSubscriptionAuxiliaryBudget } from '../ai/subscription-auxiliary.ts';
import { createSubscriptionRun, SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../minions/subscription-jobs.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { splitEvalAllowance, type EvalAllowance } from '../../eval/longmemeval/codex-allowance-flags.ts';
import { usageError } from '../../cli/cli-error.ts';
const pending = new AsyncLocalStorage<Readonly<EvalAllowance>>();
export const BRAINSTORM_ALLOWANCE_HELP = `
Private Codex: --codex-max-attempts N --codex-max-turns N --codex-deadline UTC
  --codex-request-id UUID  Reuse the same request and limits for recovery.
  --aux-max-usd N         Explicit paid embedding/reranking allowance.
Subscription cost is unknown. Ordinary --max-usd never grants native calls.
`;
/** Validate local consent before the command; persist it only with the actual run binding. */
export async function withBrainstormAllowance<T>(engine: BrainEngine, args: string[], run: (args: string[]) => Promise<T>): Promise<T> {
    const split = splitEvalAllowance(args), grant = split.allowance;
    if (!grant)
        return run(split.args);
    if (!readPrivateCodexConfig() || codexSubscriptionContext())
        throw usageError('New brainstorm allowance flags require local private mode without an enclosing grant.', 'Reuse the existing host grant without extra allowance flags.');
    const runId = `codex-brainstorm:${grant.requestId}`, saved = Object.freeze({ ...grant, deadline: new Date(grant.deadline) });
    return pending.run(saved, () => withCodexSubscription({ engine, runId }, () => withSubscriptionAuxiliaryBudget(engine, `group:${runId}`, grant.auxiliaryUsd, () => run(split.args))));
}
/** Same transaction creates the grant and its immutable material-input binding. */
export async function ensureLocalBrainstormGrant(tx: BrainEngine, runId: string): Promise<void> {
    const grant = pending.getStore();
    if (!grant)
        return;
    if (runId !== `codex-brainstorm:${grant.requestId}`)
        throw new SubscriptionAdmissionError('subscription_identity_conflict');
    await tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    await declareDurablePersistence(tx);
    const [prior] = await tx.executeRaw<{
        account_lane: string;
        max_attempts: number;
        max_turns: number;
        deadline: string | Date;
    }>('SELECT account_lane,max_attempts,max_turns,deadline FROM codex_subscription_runs WHERE run_id=$1 FOR UPDATE', [runId]);
    if (prior) {
        if (prior.account_lane !== CODEX_JOB_ACCOUNT_LANE || prior.max_attempts !== grant.maxAttempts || prior.max_turns !== grant.maxTurns || new Date(prior.deadline).getTime() !== grant.deadline.getTime())
            throw new SubscriptionAdmissionError('subscription_identity_conflict');
    }
    else
        await createSubscriptionRun(tx, { ...grant, runId, accountLane: CODEX_JOB_ACCOUNT_LANE });
}
/** Emit the generated recovery identity only after grant and input binding commit. */
export function reportBrainstormAllowance(): void {
    const grant = pending.getStore();
    if (!grant)
        return;
    process.stderr.write(`[brainstorm] subscription request ${grant.requestId} ${JSON.stringify({ billing: 'subscription', max_attempts: grant.maxAttempts,
        max_turns: grant.maxTurns, deadline: grant.deadline.toISOString(), auxiliary_cap_usd: grant.auxiliaryUsd ?? null, monetary_cost_usd: null, remaining_quota: null })}\n`);
}
