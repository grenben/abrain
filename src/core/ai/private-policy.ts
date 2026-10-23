import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { configPath } from '../config-path.ts';
import type { ConfigReader } from '../config-snapshot.ts';
import type { ResolveModelOpts, ResolvedModel } from '../model-config.ts';
import { validatePrivateSchedules, type PrivateSchedules } from './private-schedules.ts';
import { FILE_GENERATIVE_PINS, GENERATIVE_PIN_ENV } from './private-pin-plan.ts';
import { PRIVATE_GENERATION_ROLES, PRIVATE_MODEL_TIERS, isPrivateRole, privateRoleTier, type PrivateRole, type PrivateModelTier } from './private-roles.ts';
import { digest } from '../persistence/digest.ts';

/** Local operator configuration only. A mounted brain/job cannot activate this. */
interface PrivateCodexBase {
  mode: 'strict';
  bin: string;
  scheduled_jobs?: PrivateSchedules;
}
export type PrivateCodexConfig = PrivateCodexBase & (
  | { model: string; models?: never; enabled_roles?: never }
  | { model?: never; models: Readonly<Record<PrivateModelTier, string>>; enabled_roles: readonly PrivateRole[] }
);
export class PrivateRoutingError extends Error {
  constructor(public readonly source: string, public readonly code: 'private_config_invalid' | 'private_route_conflict' | 'private_native_loop_unsupported' | 'private_role_required' | 'private_role_disabled' = 'private_route_conflict') {
    super(`${code}: ${source}`); this.name = 'PrivateRoutingError';
  }
}
export function validatePrivateCodexConfig(value: unknown): PrivateCodexConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PrivateRoutingError('file:private_codex', 'private_config_invalid');
  const v = value as Record<string, unknown>;
  if (v.mode !== 'strict' || typeof v.bin !== 'string' || !isAbsolute(v.bin) ||
    Object.keys(v).some(k => !['mode','model','models','enabled_roles','bin','scheduled_jobs'].includes(k))) {
    throw new PrivateRoutingError('file:private_codex', 'private_config_invalid');
  }
  let scheduled_jobs: PrivateSchedules | undefined;
  try { scheduled_jobs = validatePrivateSchedules(v.scheduled_jobs); }
  catch { throw new PrivateRoutingError('file:private_codex.scheduled_jobs', 'private_config_invalid'); }
  const base: PrivateCodexBase = { mode: 'strict', bin: v.bin, ...(scheduled_jobs === undefined ? {} : { scheduled_jobs }) };
  const validModel = (model: unknown): model is string => typeof model === 'string' && /^codex-cli:[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(model);
  if (v.models === undefined && v.enabled_roles === undefined && validModel(v.model)) return { ...base, model: v.model };
  const models = v.models as Record<string, unknown> | undefined, roles = v.enabled_roles;
  if (v.model !== undefined || !models || typeof models !== 'object' || Array.isArray(models) ||
      Object.keys(models).length !== PRIVATE_MODEL_TIERS.length || PRIVATE_MODEL_TIERS.some(t => !validModel(models[t])) ||
      !Array.isArray(roles) || roles.some(role => !isPrivateRole(role)) || new Set(roles).size !== roles.length) {
    throw new PrivateRoutingError('file:private_codex', 'private_config_invalid');
  }
  return { ...base, models: Object.freeze(Object.fromEntries(PRIVATE_MODEL_TIERS.map(t => [t, models[t]])) as Record<PrivateModelTier, string>),
    enabled_roles: Object.freeze([...roles].sort() as PrivateRole[]) };
}

export function privateModelForTier(policy: PrivateCodexConfig, tier: PrivateModelTier): string {
  return policy.models ? policy.models[tier] : policy.model;
}

/** Missing identities never inherit the chat permission in a tiered rollout. */
export function requirePrivateRole(policy: PrivateCodexConfig, role: PrivateRole | undefined): PrivateRole {
  if (!role && policy.models) throw new PrivateRoutingError('dispatch:role', 'private_role_required');
  const selected = role ?? 'chat';
  if (!isPrivateRole(selected)) throw new PrivateRoutingError('dispatch:role', 'private_role_required');
  if (policy.enabled_roles && !policy.enabled_roles.includes(selected))
    throw new PrivateRoutingError(`role:${selected}`, 'private_role_disabled');
  return selected;
}

export function privateModelForRole(policy: PrivateCodexConfig, role: PrivateRole): string {
  return privateModelForTier(policy, privateRoleTier(requirePrivateRole(policy, role)));
}

/** Bind admission/recovery to every tier and activation switch, not one legacy model. */
export function privatePolicyFingerprint(policy: PrivateCodexConfig): string {
  return digest(policy);
}

export interface PrivatePolicyBinding { model: string; bin: string; policy_fingerprint?: string }
/** Preserve scalar replay identities; tiered jobs bind the complete policy. */
export function privatePolicyBinding(policy: PrivateCodexConfig): PrivatePolicyBinding {
  return { model: privateModelForTier(policy, 'reasoning'), bin: policy.bin,
    ...(policy.models ? { policy_fingerprint: privatePolicyFingerprint(policy) } : {}) };
}
export function privatePolicyMatchesBinding(policy: PrivateCodexConfig, binding: PrivatePolicyBinding): boolean {
  return digest(privatePolicyBinding(policy)) === digest({ model: binding.model, bin: binding.bin,
    ...(binding.policy_fingerprint ? { policy_fingerprint: binding.policy_fingerprint } : {}) });
}

/** Parse failure is not permission to resume paid inference. No env/token reads. */
function readPrivateConfigFile(): Record<string, unknown> {
  let text: string;
  try { text = readFileSync(configPath(), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new PrivateRoutingError('file:config', 'private_config_invalid');
  }
  let config: Record<string, unknown>;
  try { config = JSON.parse(text); } catch { throw new PrivateRoutingError('file:config', 'private_config_invalid'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new PrivateRoutingError('file:config', 'private_config_invalid');
  return config;
}
export function readPrivateCodexConfig(): PrivateCodexConfig | undefined {
  return validatePrivateCodexConfig(readPrivateConfigFile().private_codex);
}
/** Inspect explicit file and environment pins independently, including shadowed values. */
export function privatePinConflicts(policy: PrivateCodexConfig): string[] {
  const file = readPrivateConfigFile(), conflicts: string[] = [];
  const check = (value: unknown, source: string, tier?: PrivateModelTier) => {
    if (value === undefined || value === null || value === '') return;
    const targets = tier ? [privateModelForTier(policy, tier)] : PRIVATE_MODEL_TIERS.map(t => privateModelForTier(policy, t));
    if (typeof value !== 'string' || targets.some(target => value.trim() !== target)) conflicts.push(source);
  };
  for (const key of FILE_GENERATIVE_PINS) {
    if (key !== 'chat_fallback_chain') check(file[key], `file:${key}`, key === 'chat_model' ? 'reasoning' : 'utility');
    else if (file[key] !== undefined) {
      if (!Array.isArray(file[key])) conflicts.push(`file:${key}`);
      else for (const value of file[key]) check(value, `file:${key}`, 'reasoning');
    }
  }
  for (const key of GENERATIVE_PIN_ENV) {
    if (key === 'GBRAIN_CHAT_FALLBACK_CHAIN') for (const value of (process.env[key] ?? '').split(',').filter(v => v.trim())) check(value, `env:${key}`, 'reasoning');
    else check(process.env[key], `env:${key}`, key === 'GBRAIN_MODEL' ? undefined : key === 'GBRAIN_CHAT_MODEL' ? 'reasoning' : 'utility');
  }
  return [...new Set(conflicts)];
}

/** Explicit routes must equal the operator's configured model; aliases cannot evade this. */
export function assertPrivateRoute(model: string, source: string, policy = readPrivateCodexConfig(), role?: PrivateRole): void {
  if (policy) { const [conflict] = privatePinConflicts(policy); if (conflict) throw new PrivateRoutingError(conflict); }
  if (policy) {
    const allowed = role ? [privateModelForRole(policy, role)] : PRIVATE_MODEL_TIERS.map(t => privateModelForTier(policy, t));
    if (!allowed.includes(model)) throw new PrivateRoutingError(source);
  }
}
export function assertPrivateNativeLoopAllowed(source: string): void {
  if (readPrivateCodexConfig()) throw new PrivateRoutingError(source, 'private_native_loop_unsupported');
}

/** Inspect EVERY applicable explicit pin, including shadowed pins. Never discover models. */
export async function resolvePrivateModel(engine: ConfigReader | null, opts: ResolveModelOpts, policy: PrivateCodexConfig): Promise<ResolvedModel> {
  const [conflict] = privatePinConflicts(policy); if (conflict) throw new PrivateRoutingError(conflict);
  const tier = opts.privateRole ? privateRoleTier(requirePrivateRole(policy, opts.privateRole)) : opts.tier ??
    PRIVATE_GENERATION_ROLES.find(([, key]) => key !== undefined && key === opts.configKey)?.[2] ?? 'reasoning';
  if (opts.privateRole && opts.tier && tier !== opts.tier) throw new PrivateRoutingError('role:tier');
  const model = privateModelForTier(policy, tier);
  const pins: Array<{ value: string | undefined | null; source: ResolvedModel['source']; label: string }> = [
    { value: opts.cliFlag, source: 'cli_flag', label: 'cli:model' },
  ];
  if (engine) {
    for (const [key, source] of [
      [opts.configKey, 'config_key'], [opts.deprecatedConfigKey, 'deprecated_key'],
      [`models.tier.${tier}`, 'tier_config'], ['models.default', 'models_default'],
    ] as const) if (key) pins.push({ value: await engine.getConfig(key), source, label: `db:${key}` });
  }
  const envKey = opts.envVar ?? 'GBRAIN_MODEL';
  pins.push({ value: process.env[envKey], source: 'env', label: `env:${envKey}` });
  for (const pin of pins) if (pin.value?.trim() && pin.value.trim() !== model) throw new PrivateRoutingError(pin.label);
  return { model, source: pins.find(pin => pin.value?.trim())?.source ?? 'private_default' };
}
