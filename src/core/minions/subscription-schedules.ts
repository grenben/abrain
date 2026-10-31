import { privatePolicyFingerprint, readPrivateCodexConfig } from '../ai/private-policy.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { jobMayGenerate } from './subscription-job-kinds.ts';
import { jobSpendAuthorization } from './spend-authorization.ts';
import type { TrustedSubmitOpts } from './queue.ts';

/** Called by trusted scheduler code, never by the queue or by model-authored payloads. */
export function scheduledCodexSubmit(
  name: 'autopilot-cycle' | 'autopilot-global-maintenance' | 'extract-atoms-drain',
  data: Record<string, unknown>,
  slot: string,
  options?: { nowMs?: number; minRemainingMs?: number },
): TrustedSubmitOpts | undefined {
  if (options && ((options.nowMs !== undefined && (typeof options.nowMs !== 'number' || !Number.isFinite(options.nowMs) || options.nowMs < 0)) ||
      (options.minRemainingMs !== undefined && (typeof options.minRemainingMs !== 'number' || !Number.isFinite(options.minRemainingMs) || options.minRemainingMs <= 0)))) {
    throw new SubscriptionAdmissionError('subscription_invalid');
  }
  if (!jobMayGenerate(name, data)) return undefined;
  const policy = readPrivateCodexConfig();
  if (!policy) return undefined;
  const limits = policy.scheduled_jobs?.[name];
  if (!limits) throw new SubscriptionAdmissionError('subscription_required');
  const start = Date.parse(slot), now = options?.nowMs ?? Date.now();
  const deadline = new Date(start + limits.windowMs);
  // Absolute occurrence identity: polling/restarting cannot extend the allowance.
  const remainingMs = deadline.getTime() - now;
  if (!Number.isFinite(start) || new Date(start).toISOString() !== slot || start > now || remainingMs <= 0 ||
      (options?.minRemainingMs !== undefined && remainingMs < options.minRemainingMs)) {
    throw new SubscriptionAdmissionError('subscription_exhausted');
  }
  return { codexSubscription: { maxAttempts: limits.maxAttempts, maxTurns: limits.maxTurns, deadline },
    scheduledPolicyFingerprint: privatePolicyFingerprint(policy),
    ...(limits.auxiliaryMaxUsd === undefined ? {} : { spendAuthorization: jobSpendAuthorization({
      consented_effects: ['paid'], cap_usd: limits.auxiliaryMaxUsd, cap_source: 'user', via: 'preapproval',
    }, { command: `scheduled ${name}` }) }) };
}
