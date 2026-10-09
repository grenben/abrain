import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { readPrivateCodexConfig, assertPrivateRoute } from '../ai/private-policy.ts';
import { splitProviderModelId } from '../model-id.ts';
import type { BudgetCheckResult, SubmitEstimate } from './budget-meter.ts';

/** Cycle preflight is not a reservation: the gateway still atomically admits every attempt. */
export function cycleSubscriptionBudget(estimate: SubmitEstimate, budgetUsd: number): BudgetCheckResult | undefined {
  if (splitProviderModelId(estimate.modelId).provider !== 'codex-cli') return undefined;
  const policy = readPrivateCodexConfig();
  assertPrivateRoute(estimate.modelId, 'cycle:budget', policy);
  const allowed = !!policy && !!codexSubscriptionContext();
  return { allowed, estimatedCostUsd: null, cumulativeCostUsd: null, budgetUsd, billing: 'subscription', unpriced: true,
    ...(allowed ? {} : { reason: 'subscription_required: a USD limit, price override or allow_unpriced cannot authorize Codex calls' }) };
}
