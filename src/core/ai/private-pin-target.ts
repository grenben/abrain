import { PRIVATE_GENERATION_ROLES, PRIVATE_MODEL_TIERS, privateRoleTier, type PrivateModelTier } from './private-roles.ts';
import { OperationError } from '../ops/contract.ts';

export type PinTarget = string | Record<PrivateModelTier, string>;
const fail = (): never => { throw new OperationError('invalid_params', 'Codex pin migration refused: invalid_target.', 'Supply one Codex model or exactly four explicit Codex tier pins.'); };
export function validatePinTarget(target: PinTarget): void {
  const valid = (model: unknown) => typeof model === 'string' && /^codex-cli:[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(model);
  if (typeof target === 'string') { if (!valid(target)) fail(); return; }
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).length !== 4 ||
    PRIVATE_MODEL_TIERS.some(t => !Object.hasOwn(target, t) || !valid(target[t]))) fail();
}

/** A global default cannot represent distinct tiers. Its reviewed deletion is
 * journaled and reversible; no activation, auxiliary or environment setting moves. */
export function pinTargetForKey(target: PinTarget, key: string): string | null {
  if (typeof target === 'string') return target;
  if (key === 'models.default') return null;
  if (key.startsWith('models.tier.')) return target[key.slice('models.tier.'.length) as PrivateModelTier];
  const tier = PRIVATE_GENERATION_ROLES.find(([, config]) => config === key)?.[2];
  if (tier) return target[tier];
  if (key === 'embedding_image_ocr_model') return target[privateRoleTier('ocr')];
  const utility = ['expansion_model', 'models.dream.synthesize_verdict', 'dream.synthesize.verdict_model', 'contextual_retrieval.haiku_model'];
  if (utility.includes(key)) return target.utility;
  if (/^models\.eval\.cross_modal\.slot_[abc]$/.test(key)) return target.deep;
  return target.reasoning;
}
