import { readPrivateCodexConfig } from '../ai/private-policy.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { jobMayGenerate } from './subscription-job-kinds.ts';
import { jobSpendAuthorization } from './spend-authorization.ts';
import type { TrustedSubmitOpts } from './queue.ts';

/** Called by trusted scheduler code, never by the queue or by model-authored payloads. */
export function scheduledCodexSubmit(name: 'autopilot-cycle' | 'autopilot-global-maintenance', data: Record<string, unknown>, slot: string): TrustedSubmitOpts | undefined {
  if (!jobMayGenerate(name, data)) return undefined;
  const policy = readPrivateCodexConfig();
  if (!policy) return undefined;
  const limits = policy.scheduled_jobs?.[name];
  if (!limits) throw new SubscriptionAdmissionError('subscription_required');
  const start = Date.parse(slot), now = Date.now();
  const deadline = new Date(start + limits.windowMs);
  // Absolute occurrence identity: polling/restarting cannot extend the allowance.
  if (!Number.isFinite(start) || new Date(start).toISOString() !== slot || start > now || deadline.getTime() <= now) {
    throw new SubscriptionAdmissionError('subscription_exhausted');
  }
  return { codexSubscription: { maxAttempts: limits.maxAttempts, maxTurns: limits.maxTurns, deadline },
    ...(limits.auxiliaryMaxUsd === undefined ? {} : { spendAuthorization: jobSpendAuthorization({
      consented_effects: ['paid'], cap_usd: limits.auxiliaryMaxUsd, cap_source: 'user', via: 'preapproval',
    }, { command: `scheduled ${name}` }) }) };
}
