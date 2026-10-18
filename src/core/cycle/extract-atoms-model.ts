import type { BrainEngine } from '../engine.ts';
import { resolveAlias, resolveTierDefault, resolveModelDetailed } from '../model-config.ts';
import { readPrivateCodexConfig } from '../ai/private-policy.ts';

export async function resolveExtractAtomsModelWithSource(
  engine: BrainEngine,
): Promise<{ model: string; source: 'config' | 'tier_config' | 'tier_default'; label?: string }> {
  if (readPrivateCodexConfig()) {
    const r = await resolveModelDetailed(engine,{configKey:'models.dream.extract_atoms',tier:'utility',fallback:'unused'});
    return {model:r.model,source:r.source==='config_key'?'config':r.source==='tier_config'?'tier_config':'tier_default'};
  }
  try {
    const configuredModel = (await engine.getConfig('models.dream.extract_atoms'))?.trim();
    if (configuredModel) return {model:await resolveAlias(engine,configuredModel),source:'config',label:'config: models.dream.extract_atoms'};
    const tierModel = (await engine.getConfig('models.tier.utility'))?.trim();
    if (tierModel) return {model:await resolveAlias(engine,tierModel),source:'tier_config',label:'config: models.tier.utility'};
  } catch {
    // Fail-soft — fall through to the tier default.
  }
  return { model: resolveTierDefault('utility'), source: 'tier_default' };
}

/** String-returning wrapper for runtime callers (`runPhaseExtractAtoms`). */
export async function resolveExtractAtomsModel(engine: BrainEngine): Promise<string> {
  return (await resolveExtractAtomsModelWithSource(engine)).model;
}
