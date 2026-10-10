import { digest } from '../persistence/digest.ts';
import { OperationError } from '../ops/contract.ts';
import { PRIVATE_GENERATION_ROLES } from './private-roles.ts';

export const FILE_GENERATIVE_PINS = ['chat_model', 'expansion_model', 'embedding_image_ocr_model', 'chat_fallback_chain'] as const;
export const DB_GENERATIVE_PINS = [...new Set<string>([
  ...FILE_GENERATIVE_PINS, ...PRIVATE_GENERATION_ROLES.flatMap(r => r[1] ? [r[1]] : []),
  'models.default', ...['utility','reasoning','deep','subagent'].map(t => `models.tier.${t}`),
  'models.dream.synthesize_verdict', 'models.brainstorm.judge',
  ...['a','b','c'].map(t => `models.eval.cross_modal.slot_${t}`),
  'dream.synthesize.model', 'dream.patterns.model', 'dream.synthesize.verdict_model', 'dream.drift.model',
])].sort();
export const GENERATIVE_PIN_ENV = ['GBRAIN_MODEL', 'GBRAIN_CHAT_MODEL', 'GBRAIN_EXPANSION_MODEL', 'GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL', 'GBRAIN_EMBEDDING_IMAGE_OCR_MODEL', 'GBRAIN_CHAT_FALLBACK_CHAIN'] as const;
export interface PinChange { key: string; before: string | string[]; after: string | string[] }
export interface PinPlan {
  version: 1; kind: 'pins'; plane: 'file' | 'database'; identity: string; generation: string;
  target: string; changes: PinChange[]; snapshot_hash: string; plan_hash: string;
}
export function pinError(reason: string): never {
  throw new OperationError('invalid_params', `Codex pin migration refused: ${reason}.`, 'Inspect a fresh preview. Apply or roll back only its unchanged routing plan; private activation is a separate step.');
}
export function validatePinTarget(target: string): void {
  if (!/^codex-cli:[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(target)) pinError('invalid_target');
}
function validModel(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-z][a-z0-9_-]{0,31}:[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}|opus|sonnet|haiku|gemini|gpt|claude-[a-zA-Z0-9._-]{1,100})$/.test(value);
}
/** Only model-routing slots can enter a receipt; unknown/malformed values are not echoed. */
export function makePinPlan(plane: PinPlan['plane'], identity: string, generation: string, target: string, values: Record<string, unknown>, snapshotHash = digest(values)): PinPlan {
  validatePinTarget(target);
  const changes: PinChange[] = [], keys = plane === 'file' ? FILE_GENERATIVE_PINS : DB_GENERATIVE_PINS;
  for (const key of keys) {
    const before = values[key];
    if (before === undefined || before === null || before === '') continue;
    if (key === 'chat_fallback_chain') {
      let chain: unknown = before;
      if (plane === 'database' && typeof before === 'string') {
        try { chain = before.trim().startsWith('[') ? JSON.parse(before) : before.split(',').map(s => s.trim()).filter(Boolean); } catch { pinError(`invalid_pin:${key}`); }
      }
      if (!Array.isArray(chain) || chain.length > 16 || chain.some(v => !validModel(v))) pinError(`invalid_pin:${key}`);
      if ((chain as string[]).some(v => v !== target)) changes.push({ key, before: before as string | string[], after: plane === 'file' ? [target] : target });
    } else {
      if (!validModel(before)) pinError(`invalid_pin:${key}`);
      if (before !== target) changes.push({ key, before: before as string, after: target });
    }
  }
  const body = { version: 1 as const, kind: 'pins' as const, plane, identity, generation, target, changes, snapshot_hash: snapshotHash };
  return { ...body, plan_hash: digest(body) };
}
export function validatePinPlan(plan: PinPlan): void {
  if (!plan || plan.version !== 1 || plan.kind !== 'pins' || !['file','database'].includes(plan.plane) ||
      typeof plan.identity !== 'string' || typeof plan.generation !== 'string' || !/^[a-f0-9]{64}$/.test(plan.snapshot_hash) || !Array.isArray(plan.changes) || plan.changes.length > 128) pinError('invalid_plan');
  const values = Object.fromEntries(plan.changes.map(c => [c.key, c.before]));
  const rebuilt = makePinPlan(plan.plane, plan.identity, plan.generation, plan.target, values, plan.snapshot_hash);
  if (digest(rebuilt) !== digest(plan)) pinError('invalid_plan');
}
export function pinPreview(plan: PinPlan) {
  return { ...plan, activation: 'unchanged', inference: 'none',
    pin_inventory: 'registered generative slots only; other feature overrides require audit',
    environment: GENERATIVE_PIN_ENV.map(key => ({ key, present: !!process.env[key]?.trim(), action: process.env[key]?.trim() ? 'review_in_owning_launcher' : 'none' })),
    uninspected_planes: [...(plan.plane === 'file' ? ['database'] : ['file']), 'workers', 'queued_jobs'], coverage_complete: false };
}
