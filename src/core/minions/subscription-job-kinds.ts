import { SOURCE_FRESHNESS_PHASES } from '../cycle/phase-scope.ts';

/** Queue inventory only; feature acceptance is tracked separately. */
export const CODEX_GENERATIVE_JOBS: ReadonlySet<string> = new Set([
  'subagent', 'skillopt', 'extract-conversation-facts', 'enrich', 'facts-absorb',
  'contextual_reindex_per_chunk', 'autopilot-cycle', 'autopilot-global-maintenance',
  'synthesize', 'patterns', 'consolidate', 'extract-atoms-drain',
  'extract-takes-from-pages', 'chronicle_extract', 'loops_extract', 'edge_contradictions',
]);

/** Explicit freshness-only cycles must not acquire an inference dependency. */
export function jobMayGenerate(name: string, data: Record<string, unknown> = {}): boolean {
  if (!CODEX_GENERATIVE_JOBS.has(name)) return false;
  if (name !== 'autopilot-cycle') return true;
  // Missing/empty/invalid phases can select a full implicit cycle in legacy handlers.
  // Do not infer a safe phase set merely from a source ID or from a job title.
  return !Array.isArray(data.phases) || data.phases.length === 0 ||
    data.phases.some(p => typeof p !== 'string' || !SOURCE_FRESHNESS_PHASES.includes(p as never));
}
