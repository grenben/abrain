import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { assertPrivateRoute } from '../ai/private-policy.ts';
import { CODEX_READ_PROTOCOL, validateCodexReadJob } from '../minions/codex-action-contract.ts';
import { digest, jsonBytes } from '../persistence/digest.ts';
import { isWriteRequestId } from '../persistence/types.ts';

export const CODEX_BOOTSTRAP_JOB_PROTOCOL = 'codex-skillopt-bootstrap-job-v1';
const invalid = (): never => { throw new SubscriptionAdmissionError('subscription_invalid'); };
const conflict = (): never => { throw new SubscriptionAdmissionError('subscription_identity_conflict'); };

export interface CodexBootstrapJobData extends Record<string, unknown> {
  bootstrap_protocol: typeof CODEX_BOOTSTRAP_JOB_PROTOCOL;
  bootstrap_request_id: string;
  bootstrap_input_hash: string;
  bootstrap_options: Record<string, unknown>;
  bootstrap_models_plan: unknown[];
  bootstrap_strict: Record<string, unknown>;
  bootstrap_allowance: { requestId: string; maxAttempts: number; maxTurns: number; deadline: string; auxiliaryUsd: number | null };
  source_id: string;
  allowed_tools: string[];
  allowed_slug_prefixes: string[];
  read_registry?: 'codex-discovery-v1';
}

/** Job data carries only bounded host-selected values; the model never controls it. */
export const validateCodexBootstrapJob: (data: Record<string, unknown>) => asserts data is CodexBootstrapJobData = (data) => {
  if (data.bootstrap_protocol !== CODEX_BOOTSTRAP_JOB_PROTOCOL || !isWriteRequestId(data.bootstrap_request_id) ||
      typeof data.bootstrap_input_hash !== 'string' || !/^[a-f0-9]{64}$/.test(data.bootstrap_input_hash) ||
      !data.bootstrap_options || typeof data.bootstrap_options !== 'object' || Array.isArray(data.bootstrap_options) ||
      !Array.isArray(data.bootstrap_models_plan) || data.bootstrap_models_plan.length !== 1 ||
      !data.bootstrap_strict || typeof data.bootstrap_strict !== 'object' || Array.isArray(data.bootstrap_strict) ||
      !data.bootstrap_allowance || typeof data.bootstrap_allowance !== 'object' || Array.isArray(data.bootstrap_allowance) ||
      typeof data.source_id !== 'string' || !data.source_id || data.source_id.length > 200 ||
      !Array.isArray(data.allowed_tools) || !Array.isArray(data.allowed_slug_prefixes) || data.allowed_tools.length > 16 || data.allowed_slug_prefixes.length > 32 ||
      data.read_registry !== undefined && data.read_registry !== 'codex-discovery-v1') invalid();
  const options = data.bootstrap_options as Record<string, unknown>;
  if (Object.keys(options).sort().join(',') !== 'dryRun,force,maxCostSource,maxCostUsd,mode,modelsStrict,optimizer,skillName,skillsDir,taskCount' ||
      !['routing', 'skill'].includes(options.mode as string) || typeof options.skillsDir !== 'string' || !options.skillsDir.startsWith('/') ||
      typeof options.skillName !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.skillName) || options.skillName.length > 100 ||
      typeof options.force !== 'boolean' || options.dryRun !== false || typeof options.modelsStrict !== 'boolean' ||
      typeof options.maxCostUsd !== 'number' || !Number.isFinite(options.maxCostUsd) || options.maxCostUsd < 0 ||
      !['user', 'default'].includes(options.maxCostSource as string) || !Number.isSafeInteger(options.taskCount) || Number(options.taskCount) < 1 || Number(options.taskCount) > 50 ||
      !options.optimizer || typeof options.optimizer !== 'object' || Array.isArray(options.optimizer) || typeof (options.optimizer as Record<string, unknown>).model !== 'string') invalid();
  const optimizer = options.optimizer as Record<string, unknown>;
  if (Object.keys(optimizer).some(key => !['model', 'source', 'origin', 'substituted_from', 'substitution_reason'].includes(key)) ||
      typeof optimizer.model !== 'string' || optimizer.model.length > 200 || typeof optimizer.source !== 'string' || optimizer.source.length > 100 ||
      typeof optimizer.origin !== 'string' || optimizer.origin.length > 200 ||
      optimizer.substituted_from !== undefined && (typeof optimizer.substituted_from !== 'string' || optimizer.substituted_from.length > 200) ||
      optimizer.substitution_reason !== undefined && (typeof optimizer.substitution_reason !== 'string' || optimizer.substitution_reason.length > 200)) invalid();
  const allowance = data.bootstrap_allowance as Record<string, unknown>;
  if (Object.keys(allowance).sort().join(',') !== 'auxiliaryUsd,deadline,maxAttempts,maxTurns,requestId' ||
      !isWriteRequestId(allowance.requestId) || ![allowance.maxAttempts, allowance.maxTurns].every(v => Number.isSafeInteger(v) && Number(v) >= 1 && Number(v) <= 1000) ||
      Number(allowance.maxTurns) > Number(allowance.maxAttempts) || typeof allowance.deadline !== 'string' ||
      !Number.isFinite(Date.parse(allowance.deadline)) || allowance.auxiliaryUsd !== null && (typeof allowance.auxiliaryUsd !== 'number' || !Number.isFinite(allowance.auxiliaryUsd) || allowance.auxiliaryUsd <= 0 || allowance.auxiliaryUsd > 10000)) invalid();
  if (String(allowance.requestId).toLowerCase() !== String(data.bootstrap_request_id).toLowerCase()) conflict();
  if (jsonBytes(data) > 131072) invalid();
  assertPrivateRoute((options.optimizer as Record<string, unknown>).model as string, 'job:skillopt.bootstrap.optimizer_model');
  const strict = data.bootstrap_strict as Record<string, unknown>;
  if (Object.keys(strict).some(k => !['enabled', 'ok', 'violations', 'unrecognized_value'].includes(k)) ||
      typeof strict.enabled !== 'boolean' || typeof strict.ok !== 'boolean' || !Array.isArray(strict.violations)) invalid();
  for (const entry of data.bootstrap_models_plan as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(k => !['touchpoint', 'model', 'source', 'origin', 'active', 'inactive_reason'].includes(k)) ||
        typeof (entry as Record<string, unknown>).model !== 'string') invalid();
    assertPrivateRoute((entry as Record<string, unknown>).model as string, 'job:skillopt.bootstrap.models_plan');
  }
  const planEntry = (data.bootstrap_models_plan as Array<Record<string, unknown>>)[0]!;
  if (planEntry.touchpoint !== 'optimizer' || planEntry.active !== true || planEntry.model !== optimizer.model) invalid();
  validateCodexReadJob({ action_protocol: CODEX_READ_PROTOCOL, prompt: 'bootstrap authority scope', source_id: data.source_id,
    ...(data.read_registry !== undefined ? { read_registry: data.read_registry } : {}), allowed_tools: data.allowed_tools,
    allowed_slug_prefixes: data.allowed_slug_prefixes, max_turns: 16, no_self_fix: true });
}

export function bootstrapJobInputHash(value: unknown): string { return digest(value); }
