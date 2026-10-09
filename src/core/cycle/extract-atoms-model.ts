import type { BrainEngine } from '../engine.ts';
import { resolveTierDefault, resolveModelDetailed } from '../model-config.ts';
import { readPrivateCodexConfig } from '../ai/private-policy.ts';

export async function resolveExtractAtomsModelWithSource(
  engine: BrainEngine,
): Promise<{ model: string; source: 'config' | 'tier_default' }> {
  if (readPrivateCodexConfig()) {
    const r = await resolveModelDetailed(engine,{configKey:'models.dream.extract_atoms',tier:'utility',fallback:'unused'});
    return {model:r.model,source:r.source==='config_key'?'config':'tier_default'};
  }
  let configuredModel: string | null = null;
  try {
    configuredModel = await engine.getConfig('models.dream.extract_atoms');
  } catch {
    // Fail-soft — fall through to the tier default.
  }
  return configuredModel
    ? { model: configuredModel, source: 'config' }
    : { model: resolveTierDefault('utility'), source: 'tier_default' };
}

/** String-returning wrapper for runtime callers (`runPhaseExtractAtoms`). */
export async function resolveExtractAtomsModel(engine: BrainEngine): Promise<string> {
  return (await resolveExtractAtomsModelWithSource(engine)).model;
}
