import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { assertPrivateRoute } from '../ai/private-policy.ts';
import { CODEX_READ_PROTOCOL, validateCodexReadJob } from '../minions/codex-action-contract.ts';
import type { SkillOptOpts } from './types.ts';
import { skillName } from '../shared-skills/manifest.ts';
import { isWriteRequestId } from '../persistence/types.ts';
import { CODEX_SKILLOPT_BATCH_JOB_PROTOCOL } from '../minions/codex-action-contract.ts';
import { digest } from '../persistence/digest.ts';
export const CODEX_OPTIMIZER_JOB_PROTOCOL = 'codex-skillopt-workflow-v1';
export const CODEX_SHARED_OPTIMIZER_JOB_PROTOCOL = 'codex-shared-skillopt-workflow-v1';
export { CODEX_SKILLOPT_BATCH_JOB_PROTOCOL };
export function sharedOptimizerTarget(value: unknown): NonNullable<SkillOptOpts['sharedSkill']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SubscriptionAdmissionError('subscription_invalid');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'expected_revision,pack_id,request_id,source_id,source_incarnation' ||
      typeof v.source_id !== 'string' || !v.source_id || v.source_id.length > 200 ||
      !isWriteRequestId(v.source_incarnation) || !isWriteRequestId(v.expected_revision) || !isWriteRequestId(v.request_id))
    throw new SubscriptionAdmissionError('subscription_invalid');
  return { source_id: v.source_id, pack_id: skillName(v.pack_id, 'pack_id'), source_incarnation: (v.source_incarnation as string).toLowerCase(),
    expected_revision: (v.expected_revision as string).toLowerCase(), request_id: (v.request_id as string).toLowerCase() };
}
export function validateCodexOptimizerJob(data: Record<string, unknown>): void {
  if (![CODEX_OPTIMIZER_JOB_PROTOCOL, CODEX_SHARED_OPTIMIZER_JOB_PROTOCOL].includes(data.optimizer_protocol as string) || !isWriteRequestId(data.optimizer_request_id) ||
      typeof data.optimizer_input_hash !== 'string' || !/^[a-f0-9]{64}$/.test(data.optimizer_input_hash))
    throw new SubscriptionAdmissionError('subscription_identity_conflict');
  if (data.optimizer_protocol === CODEX_SHARED_OPTIMIZER_JOB_PROTOCOL) {
    const target = sharedOptimizerTarget(data.shared_skill);
    if (target.source_id !== data.source_id || target.request_id !== data.optimizer_request_id)
      throw new SubscriptionAdmissionError('subscription_identity_conflict');
  } else if (data.shared_skill !== undefined) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  validateCodexReadJob({ action_protocol: CODEX_READ_PROTOCOL, prompt: 'optimizer scope', source_id: data.source_id,
    ...(data.read_registry !== undefined ? { read_registry: data.read_registry } : {}), allowed_tools: data.allowed_tools, allowed_slug_prefixes: data.allowed_slug_prefixes, max_turns: 16, no_self_fix: true });
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
  if (data.optimizer_batch_protocol !== undefined) {
    const entries = data.optimizer_batch_entries;
    const selection = data.optimizer_batch_selection;
    if (data.optimizer_batch_protocol !== CODEX_SKILLOPT_BATCH_JOB_PROTOCOL || data.optimizer_protocol !== CODEX_OPTIMIZER_JOB_PROTOCOL ||
        data.shared_skill !== undefined || typeof data.skills_dir !== 'string' || !Array.isArray(entries) || entries.length > 20 ||
        !Array.isArray(selection) || selection.length !== entries.length || selection.some((s, i) => s !== (entries[i] as { skill?: unknown })?.skill) ||
        digest(entries) !== data.optimizer_input_hash ||
        entries.some((entry, i) => !entry || typeof entry !== 'object' || Array.isArray(entry) ||
          Object.keys(entry).sort().join(',') !== 'inputHash,skill' || typeof entry.skill !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.skill) ||
          typeof entry.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.inputHash) || i > 0 && (entries[i - 1] as { skill: string }).skill >= entry.skill))
      throw new SubscriptionAdmissionError('subscription_identity_conflict');
  } else if (data.optimizer_batch_entries !== undefined) throw new SubscriptionAdmissionError('subscription_identity_conflict');
}
