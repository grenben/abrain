import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { configPath } from '../config-path.ts';
import type { ConfigReader } from '../config-snapshot.ts';
import type { ResolveModelOpts, ResolvedModel } from '../model-config.ts';
import { validatePrivateSchedules, type PrivateSchedules } from './private-schedules.ts';
import { FILE_GENERATIVE_PINS, GENERATIVE_PIN_ENV } from './private-pin-plan.ts';

/** Local operator configuration only. A mounted brain/job cannot activate this. */
export interface PrivateCodexConfig {
  mode: 'strict';
  model: string;
  bin: string;
  scheduled_jobs?: PrivateSchedules;
}
export class PrivateRoutingError extends Error {
  constructor(public readonly source: string, public readonly code: 'private_config_invalid' | 'private_route_conflict' | 'private_native_loop_unsupported' = 'private_route_conflict') {
    super(`${code}: ${source}`); this.name = 'PrivateRoutingError';
  }
}
export function validatePrivateCodexConfig(value: unknown): PrivateCodexConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PrivateRoutingError('file:private_codex', 'private_config_invalid');
  const v = value as Record<string, unknown>;
  if (v.mode !== 'strict' || typeof v.model !== 'string' || !/^codex-cli:[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(v.model) ||
    typeof v.bin !== 'string' || !isAbsolute(v.bin) || Object.keys(v).some(k => !['mode','model','bin','scheduled_jobs'].includes(k))) {
    throw new PrivateRoutingError('file:private_codex', 'private_config_invalid');
  }
  let scheduled_jobs: PrivateSchedules | undefined;
  try { scheduled_jobs = validatePrivateSchedules(v.scheduled_jobs); }
  catch { throw new PrivateRoutingError('file:private_codex.scheduled_jobs', 'private_config_invalid'); }
  return { mode: 'strict', model: v.model, bin: v.bin, ...(scheduled_jobs === undefined ? {} : { scheduled_jobs }) };
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
  const check = (value: unknown, source: string) => {
    if (value === undefined || value === null || value === '') return;
    if (typeof value !== 'string' || value.trim() !== policy.model) conflicts.push(source);
  };
  for (const key of FILE_GENERATIVE_PINS) {
    if (key !== 'chat_fallback_chain') check(file[key], `file:${key}`);
    else if (file[key] !== undefined) {
      if (!Array.isArray(file[key])) conflicts.push(`file:${key}`);
      else for (const value of file[key]) check(value, `file:${key}`);
    }
  }
  for (const key of GENERATIVE_PIN_ENV) {
    if (key === 'GBRAIN_CHAT_FALLBACK_CHAIN') for (const value of (process.env[key] ?? '').split(',').filter(v => v.trim())) check(value, `env:${key}`);
    else check(process.env[key], `env:${key}`);
  }
  return [...new Set(conflicts)];
}

/** Explicit routes must equal the operator's configured model; aliases cannot evade this. */
export function assertPrivateRoute(model: string, source: string, policy = readPrivateCodexConfig()): void {
  if (policy) { const [conflict] = privatePinConflicts(policy); if (conflict) throw new PrivateRoutingError(conflict); }
  if (policy && model !== policy.model) throw new PrivateRoutingError(source);
}
export function assertPrivateNativeLoopAllowed(source: string): void {
  if (readPrivateCodexConfig()) throw new PrivateRoutingError(source, 'private_native_loop_unsupported');
}

/** Inspect EVERY applicable explicit pin, including shadowed pins. Never discover models. */
export async function resolvePrivateModel(engine: ConfigReader | null, opts: ResolveModelOpts, policy: PrivateCodexConfig): Promise<ResolvedModel> {
  const [conflict] = privatePinConflicts(policy); if (conflict) throw new PrivateRoutingError(conflict);
  const pins: Array<{ value: string | undefined | null; source: ResolvedModel['source']; label: string }> = [
    { value: opts.cliFlag, source: 'cli_flag', label: 'cli:model' },
  ];
  if (engine) {
    for (const [key, source] of [
      [opts.configKey, 'config_key'], [opts.deprecatedConfigKey, 'deprecated_key'],
      [opts.tier ? `models.tier.${opts.tier}` : undefined, 'tier_config'], ['models.default', 'models_default'],
    ] as const) if (key) pins.push({ value: await engine.getConfig(key), source, label: `db:${key}` });
  }
  const envKey = opts.envVar ?? 'GBRAIN_MODEL';
  pins.push({ value: process.env[envKey], source: 'env', label: `env:${envKey}` });
  for (const pin of pins) if (pin.value?.trim()) assertPrivateRoute(pin.value.trim(), pin.label, policy);
  return { model: policy.model, source: pins.find(pin => pin.value?.trim())?.source ?? 'private_default' };
}
