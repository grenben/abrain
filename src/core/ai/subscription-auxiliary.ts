import type { BrainEngine } from '../engine.ts';
import { withAIInvocationGuard } from './invocation-guard.ts';
import { hasAdmittedCodexAttempt } from './subscription-context.ts';
import { SubscriptionAdmissionError } from './subscription-admission.ts';
import { reservationCostUsd, usageCostUsd } from '../budget/reservation-cost.ts';
import { reserveGroup, settle } from '../minions/budget-meter.ts';
/** A durable, independent API budget. Unknown effects retain their reservation.
 * The caller binds key and cap to its immutable subscription request identity. */
export async function withSubscriptionAuxiliaryBudget<T>(engine: BrainEngine, budgetKey: string, capUsd: number | undefined, run: () => Promise<T>): Promise<T> {
    let refusal: unknown;
    const result = await withAIInvocationGuard(async (call) => {
        if (refusal)
            throw refusal;
        if (hasAdmittedCodexAttempt(call.model))
            return { settle: async () => { } };
        try {
            if (capUsd === undefined || !Number.isFinite(capUsd) || capUsd <= 0 ||
                !['embedding', 'rerank'].includes(call.kind) || !Number.isSafeInteger(call.maxInputTokens) || call.maxInputTokens! < 0) {
                throw new SubscriptionAdmissionError('subscription_auxiliary_budget_required');
            }
            const kind = call.kind === 'embedding' ? 'embed' : 'rerank';
            const maximum = reservationCostUsd(call.model, kind, call.maxInputTokens!, 0);
            if (maximum === null)
                throw new SubscriptionAdmissionError('subscription_auxiliary_budget_required');
            const hold = await reserveGroup(engine, { budgetKey, capCents: capUsd * 100, estimatedCents: maximum * 100,
                model: call.model, provider: call.model.split(':')[0]!, estimateKnown: true, requireFullReservation: true });
            return { settle: async (usage) => {
                    try {
                        const measured = usage && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0
                            ? usageCostUsd(call.model, usage.inputTokens, 0, kind) : null;
                        if (measured !== null)
                            await settle(engine, hold.reservationId, measured * 100, call.operation);
                        else
                            await engine.executeRaw("UPDATE mcp_spend_reservations SET usage_unknown_reason='provider_usage_unknown' WHERE reservation_id=$1 AND status IN ('pending','expired')", [hold.reservationId]);
                    }
                    catch (error) {
                        refusal = error;
                        throw error;
                    }
                } };
        }
        catch (error) {
            refusal = error;
            throw error;
        }
    }, run, { inherit: true });
    // A retrieval layer catching an admission failure cannot turn it into success.
    if (refusal)
        throw refusal;
    return result;
}
