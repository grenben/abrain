import type { BrainEngine } from '../engine.ts';
import { PRIVATE_GENERATION_ROLES, type PrivateRole } from '../ai/private-roles.ts';
import { readPrivateCodexConfig, resolvePrivateModel } from '../ai/private-policy.ts';

const phases: Record<string, readonly PrivateRole[]> = {
  extract_atoms: ['atoms'], synthesize: ['dream-triage', 'dream-synthesis'], patterns: ['patterns'],
  synthesize_concepts: ['concepts'], drift: ['drift'], propose_takes: ['take-proposals'],
  grade_takes: ['take-grading'], calibration_profile: ['take-calibration', 'calibration-voice-judge'],
  edge_contradictions: ['edge-contradictions'], auto_think: ['auto-think'],
};
const jobs: Record<string, readonly PrivateRole[]> = {
  enrich: ['enrichment'], 'extract-conversation-facts': ['facts'], 'facts-absorb': ['facts'],
  'extract-atoms-drain': ['atoms'], synthesize: phases.synthesize!, patterns: ['patterns'],
  contextual_reindex_per_chunk: ['contextual-synopsis'], edge_contradictions: ['edge-contradictions'],
};

/** Fence known producers before insertion. Implicit cycles retain their phase-level
 * gates: optional, disabled phases must not become mandatory queue dependencies. */
export async function preflightCoreJobRoles(engine: BrainEngine, name: string, data: Record<string, unknown>): Promise<void> {
  const policy = readPrivateCodexConfig();
  if (!policy) return;
  const roles = name === 'autopilot-cycle' && Array.isArray(data.phases)
    ? data.phases.flatMap(phase => typeof phase === 'string' ? phases[phase] ?? [] : []) : jobs[name] ?? [];
  for (const role of new Set(roles)) {
    const [, key, tier] = PRIVATE_GENERATION_ROLES.find(([name]) => name === role)!;
    await resolvePrivateModel(engine, { privateRole: role, tier, configKey: role === 'enrichment' ? 'models.chat' : key,
      cliFlag: typeof data.model === 'string' ? data.model : undefined, fallback: 'unused' }, policy);
  }
}
