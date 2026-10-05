import { validateManagedTargetConfig } from './engine-target.ts';

export class ConfigFileParseError extends Error {
  constructor() { super('Config file is invalid'); this.name = 'ConfigFileParseError'; }
}

/** Shared file-only JSON and legacy-shape semantics for readers and publishers. */
export function parseFileOnlyConfig(raw: string, validateTarget = true): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ConfigFileParseError(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigFileParseError();
  const parsed = value as Record<string, unknown>;
  let config = parsed;
  if (parsed.embedding_model === undefined && typeof parsed.provider === 'string'
    && parsed.provider && typeof parsed.model === 'string' && parsed.model) {
    config = { ...parsed, embedding_model: `${parsed.provider}:${parsed.model}` };
    delete config.provider;
    delete config.model;
    console.warn('[config] Legacy embedding settings were migrated in memory.');
  }
  if (validateTarget) validateManagedTargetConfig(config as never);
  return config;
}
