/** Dispatch inventory, not a claim that every feature has passed private acceptance. */
export const PRIVATE_GENERATION_ROLES = [
  ['chat','models.chat','reasoning','ai/gateway.ts'],
  ['facts','facts.extraction_model','reasoning','facts/extract.ts'],
  ['classifiers',undefined,'utility','facts/classify.ts'],
  ['atoms','models.dream.extract_atoms','utility','cycle/extract-atoms-model.ts'],
  ['dream-triage','models.dream.triage','utility','cycle/synthesize.ts'],
  ['dream-synthesis','models.dream.synthesize','reasoning','cycle/synthesize.ts'],
  ['patterns','models.dream.patterns','reasoning','cycle/patterns.ts'],
  ['concepts','models.dream.synthesize','reasoning','cycle/synthesize-concepts.ts'],
  ['drift','models.drift','reasoning','cycle/drift.ts'],
  ['take-grading',undefined,'utility','cycle/grade-takes.ts'],
  ['take-proposals',undefined,'reasoning','cycle/propose-takes.ts'],
  ['take-calibration',undefined,'reasoning','cycle/calibration-profile.ts'],
  ['calibration-voice-judge',undefined,'utility','calibration/voice-gate.ts'],
  ['calibration-think-ab','models.think','deep','calibration/think-ab-codex.ts'],
  ['think','models.think','deep','think/index.ts'],
  ['auto-think','models.auto_think','deep','cycle/auto-think.ts'],
  ['query-expansion','models.expansion','utility','ai/gateway.ts'],
  ['enrichment',undefined,'reasoning','../commands/enrich.ts'],
  ['contextual-synopsis','models.contextual_synopsis','utility','contextual-retrieval-service.ts'],
  ['page-summary',undefined,'utility','page-summary.ts'],
  ['brainstorm',undefined,'deep','brainstorm/'],
  ['brainstorm-judge','models.brainstorm.judge','utility','brainstorm/judges.ts'],
  ['skillopt-judge',undefined,'reasoning','skillopt/score.ts'],
  ['skillopt-optimizer',undefined,'deep','skillopt/reflect.ts'],
  ['skillopt-bootstrap',undefined,'deep','skillopt/bootstrap-benchmark.ts'],
  ['parser-fallback',undefined,'utility','conversation-parser/llm-codex-fallback.ts'],
  ['parser-polish',undefined,'utility','conversation-parser/llm-base.ts'],
  ['ocr',undefined,'reasoning','ai/gateway.ts'],
  ['nightly-probes','models.eval.longmemeval','reasoning','../commands/autopilot-probes.ts'],
  ['longmemeval-reader','models.eval.longmemeval','reasoning','../eval/longmemeval/reader.ts'],
  ['longmemeval-fact-keys-paper',undefined,'utility','../eval/longmemeval/codex-fact-keys-extract.ts'],
  ['longmemeval-fact-keys-production','facts.extraction_model','reasoning','../eval/longmemeval/codex-fact-keys-extract.ts'],
  ['longmemeval-synopsis','models.contextual_synopsis','utility','../eval/longmemeval/codex-synopsis-tier.ts'],
  ['longmemeval-extractor',undefined,'utility','../eval/longmemeval/extract.ts'],
  ['longmemeval-judge','models.eval.longmemeval_judge','deep','../eval/shared/judge-runner.ts'],
  ['contradiction-probe','models.eval.contradictions_judge','utility','eval-contradictions/judge.ts'],
  ['edge-contradictions','models.dream.edge_contradictions','utility','cycle/edge-contradictions.ts'],
  ['fence-repair','models.fence_repair','deep','fence-repair/'],
  ['iterative-minions','models.subagent','subagent','minions/handlers/subagent.ts'],
] as const;

export type PrivateRole = typeof PRIVATE_GENERATION_ROLES[number][0];
export const PRIVATE_MODEL_TIERS = ['utility', 'reasoning', 'deep', 'subagent'] as const;
export type PrivateModelTier = typeof PRIVATE_MODEL_TIERS[number];

/** Release assignment only. Neither membership nor inventory presence activates a role. */
export const PRIVATE_CORE_ROLES: readonly PrivateRole[] = [
  'chat', 'think', 'query-expansion', 'enrichment', 'contextual-synopsis', 'page-summary', 'ocr',
  'facts', 'classifiers', 'atoms', 'dream-triage', 'dream-synthesis', 'patterns', 'concepts', 'drift',
  'take-grading', 'take-proposals', 'take-calibration', 'calibration-voice-judge',
  'edge-contradictions', 'fence-repair',
];

export function isPrivateRole(value: unknown): value is PrivateRole {
  return typeof value === 'string' && PRIVATE_GENERATION_ROLES.some(([role]) => role === value);
}

export function privateRoleTier(role: PrivateRole): PrivateModelTier {
  const entry = PRIVATE_GENERATION_ROLES.find(([name]) => name === role);
  if (!entry) throw new Error('unknown_private_role');
  return entry[2];
}

/** Agent-authored content saved by GBrain is outside its model dispatch boundary. */
export const PRIVATE_NON_DISPATCH_SURFACES = [
  { surface: 'report-authoring', author: 'calling_agent_or_operator',
    save_entrypoint: 'src/commands/report.ts', model_call: 'outside_gbrain',
    note: 'The report CLI saves supplied text. GBrain-owned model-judged drift reports are the drift role.' },
] as const;
