import type { BrainstormResult } from '../../core/brainstorm/orchestrator.ts';

export interface BrainstormEvalFixture {
  question: string;
  /** Optional: prefixes the domain-bank should surface (asserted in --strict mode). */
  expected_far_prefixes?: string[];
  notes?: string;
}

export interface BrainstormEvalThresholds {
  /** Mean normalized distance of passing ideas. Default 0.4. */
  distance_min: number;
  /** Mean judge weighted_score of passing ideas. Default 3.5. */
  usefulness_min: number;
  /** Fraction of ideas that cite a real slug from the brain. Default 1.0. */
  grounding_min: number;
}

export const DEFAULT_BRAINSTORM_THRESHOLDS: BrainstormEvalThresholds = Object.freeze({
  distance_min: 0.4,
  usefulness_min: 3.5,
  grounding_min: 1.0,
});

export interface PerFixtureResult {
  question: string;
  /** Number of generated ideas that passed the judge threshold. */
  pass_count: number;
  /** Number of ideas total (before judge filtering). */
  total_ideas: number;
  /** Mean distance_score over passing ideas. */
  mean_distance: number;
  /** Mean judge weighted_score over passing ideas (NaN if no judge scores). */
  mean_usefulness: number | null;
  outcome?: 'complete' | 'empty';
  /** Fraction of ideas citing a real slug. */
  grounding_rate: number;
  /** Did the domain-bank surface enough prefixes? D11 sparse signal. */
  short_of_target: boolean;
  /** Cost in USD (actual). */
  cost_usd: number | null;
  /** True iff judge failed mid-run for this fixture. */
  judge_failed: boolean;
}

export interface BrainstormEvalReport {
  schema_version: 1;
  fixture_path: string;
  total_fixtures: number;
  parseable_fixtures: number;
  thresholds: BrainstormEvalThresholds;
  per_fixture: PerFixtureResult[];
  aggregate: {
    distance: number;
    usefulness: number;
    grounding: number;
  };
  /** pass / fail / inconclusive. */
  verdict: 'pass' | 'fail' | 'inconclusive';
  /** Reasons supporting the verdict. */
  reasons: string[];
  total_cost_usd: number | null;
}

/** Verify grounding: a real slug means a slug present in `realSlugs`. Returns the fraction of ideas citing ≥1 real slug. */
export function computeGroundingRate(
  ideas: Array<{ close_slug: string; far_slug: string }>,
  realSlugs: Set<string>
): number {
  if (ideas.length === 0) return 0;
  let grounded = 0;
  for (const idea of ideas) {
    const closeReal = realSlugs.has(idea.close_slug);
    const farReal = realSlugs.has(idea.far_slug);
    if (closeReal || farReal) grounded++;
  }
  return grounded / ideas.length;
}

/**
 * Aggregate one fixture's brainstorm result into the three-axis metrics.
 * `realSlugs` is the set of slugs known to exist in the test brain (so we
 * can detect hallucinated citations — codex r2 #11's grounding signal).
 */
export function summarizeFixture(
  question: string,
  result: BrainstormResult,
  realSlugs: Set<string>
): PerFixtureResult {
  const passing = result.ideas.filter((i) => i.passes);
  const meanDistance = passing.length === 0
    ? 0
    : passing.reduce((s, i) => s + i.distance_score, 0) / passing.length;
  const judgedPassing = passing.filter((i) => i.judge !== undefined);
  const meanUsefulness = judgedPassing.length === 0
    ? Number.NaN
    : judgedPassing.reduce((s, i) => s + (i.judge!.weighted_score), 0) / judgedPassing.length;
  const grounding = computeGroundingRate(result.ideas, realSlugs);

  return {
    question,
    pass_count: passing.length,
    total_ideas: result.ideas.length,
    mean_distance: meanDistance,
    mean_usefulness: meanUsefulness,
    grounding_rate: grounding,
    short_of_target: result.short_of_target,
    cost_usd: result.cost.actual_usd,
    judge_failed: result.judge_failed,
  };
}

/** Compute the three aggregate axes across all parseable fixtures + the verdict. */
export function computeVerdict(
  perFixture: PerFixtureResult[],
  thresholds: BrainstormEvalThresholds
): { aggregate: { distance: number; usefulness: number; grounding: number }; verdict: 'pass' | 'fail' | 'inconclusive'; reasons: string[] } {
  const usable = perFixture.filter((r) => r.pass_count > 0 && !r.judge_failed);
  if (usable.length < 2) {
    return {
      aggregate: { distance: 0, usefulness: 0, grounding: 0 },
      verdict: 'inconclusive',
      reasons: [`Only ${usable.length} fixture(s) produced parseable, judged ideas. Need at least 2 to compute meaningful aggregates.`],
    };
  }
  const distance = usable.reduce((s, r) => s + r.mean_distance, 0) / usable.length;
  const validUseful = usable.filter((r) => Number.isFinite(r.mean_usefulness));
  const usefulness = validUseful.length === 0
    ? 0
    : validUseful.reduce((s, r) => s + r.mean_usefulness!, 0) / validUseful.length;
  const grounding = usable.reduce((s, r) => s + r.grounding_rate, 0) / usable.length;

  const reasons: string[] = [];
  if (distance < thresholds.distance_min) {
    reasons.push(`distance ${distance.toFixed(3)} < ${thresholds.distance_min} (ideas too close to the question — domain-bank not surfacing distant pages)`);
  }
  if (usefulness < thresholds.usefulness_min) {
    reasons.push(`usefulness ${usefulness.toFixed(2)} < ${thresholds.usefulness_min} (ideas far but low judge score)`);
  }
  if (grounding < thresholds.grounding_min) {
    reasons.push(`grounding ${grounding.toFixed(3)} < ${thresholds.grounding_min} (some ideas cite non-existent slugs — hallucination signal)`);
  }
  if (reasons.length > 0) {
    return { aggregate: { distance, usefulness, grounding }, verdict: 'fail', reasons };
  }
  return {
    aggregate: { distance, usefulness, grounding },
    verdict: 'pass',
    reasons: [`all three axes cleared: distance ${distance.toFixed(3)} >= ${thresholds.distance_min}, usefulness ${usefulness.toFixed(2)} >= ${thresholds.usefulness_min}, grounding ${grounding.toFixed(3)} >= ${thresholds.grounding_min}`],
  };
}
