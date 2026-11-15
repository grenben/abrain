import type { BrainEngine } from '../engine.ts';
import { resolveModel } from '../model-config.ts';
import { normalizeModelId } from '../model-id.ts';
import { assertPrivateRoute, readPrivateCodexConfig, PrivateRoutingError, privatePolicyFingerprint } from '../ai/private-policy.ts';
import { prepareCodexSchema } from '../ai/providers/codex-schema.ts';

/** Separate identity from legacy prompt-only verdicts, including their backoff markers. */
export const CODEX_TRIAGE_VERSION = 1001;
export const isCodexTriageModel = (model: string): boolean => normalizeModelId(model).startsWith('codex-cli:');
export const triageVersionForModel = (model: string, legacy: number): number => isCodexTriageModel(model) ? CODEX_TRIAGE_VERSION : legacy;

/** Cache metadata only; never dispatch this policy-qualified key as a model. */
export function triageCacheModel(model: string): string {
  const policy = readPrivateCodexConfig();
  return policy && isCodexTriageModel(model) ? `${model}#${privatePolicyFingerprint(policy)}` : model;
}

export function assertTriageRoute(model: string, hasDecide = false): void {
  const policy = readPrivateCodexConfig();
  assertPrivateRoute(normalizeModelId(model), 'dream:triage', policy, 'dream-triage');
  if (policy && hasDecide) throw new PrivateRoutingError('dream:triage_decide');
}

export const CODEX_TRIAGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['score', 'content_type', 'segments', 'entities', 'reasons'],
  properties: {
    score: { type: 'number', minimum: 0, maximum: 1 },
    content_type: { type: 'string', enum: ['reflection', 'idea', 'people', 'strategy', 'technical', 'routine', 'mixed'] },
    segments: { type: 'array', maxItems: 8, items: {
      type: 'object', additionalProperties: false, required: ['quote', 'note'],
      properties: { quote: { type: 'string', minLength: 1, maxLength: 200 }, note: { type: 'string', minLength: 1, maxLength: 200 } },
    } },
    entities: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 80 } },
    reasons: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string', minLength: 1, maxLength: 200 } },
  },
};
let validate: ((value: unknown) => boolean) | undefined;
export function codexTriageSchema(model: string, validateCodexProposal?: (text: string) => void) {
  return isCodexTriageModel(model) ? { name: 'dream_triage_v1', schema: CODEX_TRIAGE_SCHEMA, validateCodexProposal } : undefined;
}

/** Reject the whole verdict before cache/publishing decisions; no fabricated rejection or repair loop. */
export function validateCodexTriage(model: string, text: string, sample: string, original = sample): void {
  if (!isCodexTriageModel(model)) return;
  const invalid = (): never => { throw new Error('private_triage_invalid'); };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid(); }
  validate ??= prepareCodexSchema(CODEX_TRIAGE_SCHEMA).validate;
  if (!validate(value)) return invalid();
  const verdict = value as { segments: Array<{ quote: string; note: string }>; entities: string[]; reasons: string[] };
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
  const source = collapse(sample);
  const quotes = new Set<string>();
  for (const segment of verdict.segments) {
    const quote = collapse(segment.quote), note = collapse(segment.note);
    if (!quote || !note || note.split(' ').length > 12 || !source.includes(quote) || !collapse(original).includes(quote) || quotes.has(quote)) return invalid();
    quotes.add(quote);
  }
  if (verdict.entities.some(e => !collapse(e) || !source.toLowerCase().includes(collapse(e).toLowerCase())) ||
      verdict.reasons.some(r => !collapse(r))) return invalid();
}

/** Validate both deprecated spellings even when the preferred pin shadows them. */
export async function privateTriageModel(engine: BrainEngine): Promise<string> {
  const model = await resolveModel(engine, { privateRole: 'dream-triage', configKey: 'models.dream.triage',
    deprecatedConfigKey: 'models.dream.synthesize_verdict', tier: 'utility', fallback: 'haiku' });
  const shadowed = await engine.getConfig('dream.synthesize.verdict_model');
  if (shadowed?.trim()) assertPrivateRoute(shadowed.trim(), 'dream.synthesize.verdict_model', undefined, 'dream-triage');
  return model;
}
