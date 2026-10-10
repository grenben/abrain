import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { assertPrivateRoute } from '../ai/private-policy.ts';
import { CODEX_READ_PROTOCOL, validateCodexReadJob } from '../minions/codex-action-contract.ts';
import { isWriteRequestId } from '../persistence/types.ts';
export const CODEX_OPTIMIZER_JOB_PROTOCOL = 'codex-skillopt-workflow-v1';
export function validateCodexOptimizerJob(data: Record<string, unknown>): void {
  if (data.optimizer_protocol !== CODEX_OPTIMIZER_JOB_PROTOCOL || !isWriteRequestId(data.optimizer_request_id) ||
      typeof data.optimizer_input_hash !== 'string' || !/^[a-f0-9]{64}$/.test(data.optimizer_input_hash))
    throw new SubscriptionAdmissionError('subscription_identity_conflict');
  validateCodexReadJob({ action_protocol: CODEX_READ_PROTOCOL, prompt: 'optimizer scope', source_id: data.source_id,
    allowed_tools: data.allowed_tools, allowed_slug_prefixes: data.allowed_slug_prefixes, max_turns: 16, no_self_fix: true });
  for (const key of ['optimizer_model', 'target_model', 'judge_model']) {
    if (typeof data[key] !== 'string') throw new SubscriptionAdmissionError('subscription_invalid');
    assertPrivateRoute(data[key], `job:skillopt.${key}`);
  }
  const flags = data.model_flags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) throw new SubscriptionAdmissionError('subscription_invalid');
  for (const [key, value] of Object.entries(flags)) {
    if (!['optimizer', 'target', 'judge'].includes(key) || typeof value !== 'string') throw new SubscriptionAdmissionError('subscription_invalid');
    assertPrivateRoute(value, `job:skillopt.model_flags.${key}`);
  }
}
