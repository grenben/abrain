/**
 * `gbrain eval brainstorm` — three-axis evaluation gate for the v0.37.0
 * brainstorm + LSD wave (D3 + codex round 2 #11).
 *
 * Three independent axes (conjunctive pass — ALL three must clear):
 *
 *   1. DISTANCE — mean(distance_score) of passing ideas. Anchored against
 *      Open Collider's published 4-13× distance shift over default-prompt
 *      baseline. Target ≥0.4 (a normalized 0-1 distance; the 4× floor in
 *      Open Collider's space maps roughly to the upper half of our [0,1]).
 *
 *   2. USEFULNESS — mean weighted-score from the brainstorm judge over the
 *      held-out fixture. Target ≥3.5/5. Below this the ideas may be far
 *      but they aren't worth reading.
 *
 *   3. GROUNDING — fraction of ideas that cite ≥1 real slug from the test
 *      brain. Target 1.0 (every idea must cite a real slug). Without this
 *      we ship a feature that's gameable: a model returning "fluff that
 *      doesn't reference your notes" would still pass distance + usefulness.
 *
 * Distance alone is gameable (codex r2 #11) — that's why this is a
 * three-axis gate rather than the single-axis "4-13× distance shift" that
 * Open Collider's paper anchors on.
 *
 * The fixture is JSONL with one object per line: `{question}` (minimum).
 * Optional `expected_far_prefixes` for spot-check assertions on which
 * brain regions the domain-bank should surface.
 *
 * Exit codes mirror gbrain's eval convention:
 *   0 = pass (all three thresholds clear)
 *   1 = fail (at least one axis below threshold)
 *   2 = inconclusive (fewer than 2 fixtures produced parseable results)
 */

import type { BrainEngine } from '../core/engine.ts';
import { readFileSync, existsSync } from 'fs';
import { runBrainstorm, BRAINSTORM_PROFILE } from '../core/brainstorm/orchestrator.ts';
import { runPrivateBrainstormEval } from '../eval/brainstorm/codex.ts';
import { withBrainstormAllowance, BRAINSTORM_ALLOWANCE_HELP } from '../core/brainstorm/codex-local-grant.ts';
import { readPrivateCodexConfig } from '../core/ai/private-policy.ts';
import { loadConfig } from '../core/config.ts';

import { DEFAULT_BRAINSTORM_THRESHOLDS, summarizeFixture, computeVerdict, type BrainstormEvalFixture, type BrainstormEvalThresholds, type PerFixtureResult, type BrainstormEvalReport } from '../eval/brainstorm/metrics.ts';
export * from '../eval/brainstorm/metrics.ts';

export interface EvalBrainstormCliArgs {
  fixture?: string;
  source?: string;
  json: boolean;
  limit?: number;
  help: boolean;
  error?: string;
  distance_min?: number;
  usefulness_min?: number;
  grounding_min?: number;
}

function parseArgs(args: string[]): EvalBrainstormCliArgs {
  const out: EvalBrainstormCliArgs = { json: false, help: false };
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--source') {
      const source=args[++i];
      if(!source||source.startsWith('--')||out.source!==undefined){out.error='--source requires one source ID';return out;}
      out.source=source;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--limit') {
      const v = args[++i];
      const n = v ? parseInt(v, 10) : NaN;
      if (!Number.isFinite(n) || n <= 0) {
        out.error = `--limit requires a positive integer (got ${v})`;
        return out;
      }
      out.limit = n;
    } else if (a === '--distance-min') {
      const n = parseFloat(args[++i]);
      if (!Number.isFinite(n)) { out.error = '--distance-min requires a number'; return out; }
      out.distance_min = n;
    } else if (a === '--usefulness-min') {
      const n = parseFloat(args[++i]);
      if (!Number.isFinite(n)) { out.error = '--usefulness-min requires a number'; return out; }
      out.usefulness_min = n;
    } else if (a === '--grounding-min') {
      const n = parseFloat(args[++i]);
      if (!Number.isFinite(n)) { out.error = '--grounding-min requires a number'; return out; }
      out.grounding_min = n;
    } else if (a.startsWith('--')) {
      out.error = `unknown flag: ${a}`;
      return out;
    } else {
      positional.push(a);
    }
    i++;
  }
  if (positional.length > 0) out.fixture = positional[0];
  return out;
}

const HELP = `Usage: gbrain eval brainstorm <fixture.jsonl> [options]

Three-axis evaluation gate for \`gbrain brainstorm\`. Runs the fixture's
questions through the brainstorm orchestrator, then scores DISTANCE +
USEFULNESS + GROUNDING against pass thresholds. All three must clear.

Fixture format (JSONL, one object per line):
  {"question": "why are AI coding tools converging on the same UX?"}
  {"question": "the unspoken assumption in venture pricing"}

Options:
  --limit N             Cap to N fixtures (default: all)
  --json                Emit BrainstormEvalReport as JSON
  --distance-min X      Override distance threshold (default 0.4)
  --usefulness-min X    Override usefulness threshold (default 3.5)
  --grounding-min X     Override grounding threshold (default 1.0)
  --help, -h            Show this help

Exit codes: 0 pass, 1 fail, 2 inconclusive (< 2 fixtures parseable).
Cost: ~$0.05-0.15 per fixture × N — budget accordingly.
`;

/** Parse JSONL fixture file. Skips blank lines and lines that fail JSON.parse. */
export function readBrainstormEvalFixture(path: string): BrainstormEvalFixture[] {
  if (!existsSync(path)) {
    throw new Error(`fixture not found: ${path}`);
  }
  const text = readFileSync(path, 'utf8');
  const fixtures: BrainstormEvalFixture[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed rows; we report parseable_fixtures separately
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.question !== 'string' || obj.question.trim().length === 0) continue;
    fixtures.push({
      question: obj.question,
      expected_far_prefixes: Array.isArray(obj.expected_far_prefixes)
        ? obj.expected_far_prefixes.filter((x): x is string => typeof x === 'string')
        : undefined,
      notes: typeof obj.notes === 'string' ? obj.notes : undefined,
    });
  }
  return fixtures;
}

/** Build the set of slugs known to exist in the brain (for grounding check). */
async function loadRealSlugs(engine: BrainEngine): Promise<Set<string>> {
  const refs = await engine.listAllPageRefs();
  return new Set(refs.map((r) => r.slug));
}

/** CLI entry. Exits with 0/1/2 mirroring eval convention. */
export async function runEvalBrainstorm(engine: BrainEngine, args: string[]): Promise<number> {
  return withBrainstormAllowance(engine,args,clean=>runEvalBrainstormArgs(engine,clean));
}
async function runEvalBrainstormArgs(engine:BrainEngine,args:string[]):Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    console.log(HELP+BRAINSTORM_ALLOWANCE_HELP);
    return 0;
  }
  if (parsed.error) {
    console.error(`gbrain eval brainstorm: ${parsed.error}`);
    console.error(HELP);
    return 2;
  }
  if (!parsed.fixture) {
    console.error('gbrain eval brainstorm: fixture path required');
    console.error(HELP);
    return 2;
  }
  if(readPrivateCodexConfig()) {
    const report=await runPrivateBrainstormEval(engine,{path:parsed.fixture,source:parsed.source,limit:parsed.limit,
      thresholds:{distance_min:parsed.distance_min??DEFAULT_BRAINSTORM_THRESHOLDS.distance_min,
        usefulness_min:parsed.usefulness_min??DEFAULT_BRAINSTORM_THRESHOLDS.usefulness_min,grounding_min:parsed.grounding_min??DEFAULT_BRAINSTORM_THRESHOLDS.grounding_min}});
    if(parsed.json)console.log(JSON.stringify(report,null,2));
    else {console.log(`Brainstorm evaluation: ${report.verdict}; ${report.completed_fixtures}/${report.selected_fixtures} fixtures completed; cost unknown (subscription).`);for(const reason of report.reasons)console.log(reason);}
    return report.verdict==='pass'?0:report.verdict==='fail'?1:2;
  }
  let fixtures: BrainstormEvalFixture[];
  try {
    fixtures = readBrainstormEvalFixture(parsed.fixture);
  } catch (err) {
    console.error(`gbrain eval brainstorm: ${err instanceof Error ? err.message : err}`);
    return 2;
  }
  const thresholds: BrainstormEvalThresholds = {
    distance_min: parsed.distance_min ?? DEFAULT_BRAINSTORM_THRESHOLDS.distance_min,
    usefulness_min: parsed.usefulness_min ?? DEFAULT_BRAINSTORM_THRESHOLDS.usefulness_min,
    grounding_min: parsed.grounding_min ?? DEFAULT_BRAINSTORM_THRESHOLDS.grounding_min,
  };
  const slice = parsed.limit ? fixtures.slice(0, parsed.limit) : fixtures;

  const config = loadConfig() ?? {};
  const realSlugs = await loadRealSlugs(engine);

  const perFixture: PerFixtureResult[] = [];
  let totalCost: number | null = 0;
  for (const [idx, fix] of slice.entries()) {
    if (!parsed.json) {
      console.error(`[eval-brainstorm] ${idx + 1}/${slice.length}: ${fix.question.slice(0, 60)}...`);
    }
    try {
      const result = await runBrainstorm(engine, config, {
        question: fix.question,
        profile: BRAINSTORM_PROFILE,
        skipCostPreview: true,
      });
      const summary = summarizeFixture(fix.question, result, realSlugs);
      perFixture.push(summary);
      totalCost = totalCost === null || summary.cost_usd === null ? null : totalCost + summary.cost_usd;
    } catch (err) {
      totalCost = null;
      const msg = err instanceof Error ? err.message : String(err);
      if (!parsed.json) {
        console.error(`[eval-brainstorm] fixture ${idx + 1} failed: ${msg}`);
      }
      perFixture.push({
        question: fix.question,
        pass_count: 0,
        total_ideas: 0,
        mean_distance: 0,
        mean_usefulness: Number.NaN,
        grounding_rate: 0,
        short_of_target: false,
        cost_usd: null,
        judge_failed: true,
      });
    }
  }

  const { aggregate, verdict, reasons } = computeVerdict(perFixture, thresholds);
  const report: BrainstormEvalReport = {
    schema_version: 1,
    fixture_path: parsed.fixture,
    total_fixtures: fixtures.length,
    parseable_fixtures: perFixture.filter((r) => !r.judge_failed && r.total_ideas > 0).length,
    thresholds,
    per_fixture: perFixture,
    aggregate,
    verdict,
    reasons,
    total_cost_usd: totalCost,
  };

  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n=== gbrain eval brainstorm ===`);
    console.log(`Fixture: ${parsed.fixture}`);
    console.log(`Parseable: ${report.parseable_fixtures}/${report.total_fixtures}`);
    console.log(`Distance:   ${aggregate.distance.toFixed(3)} (threshold ${thresholds.distance_min})`);
    console.log(`Usefulness: ${aggregate.usefulness.toFixed(2)} (threshold ${thresholds.usefulness_min})`);
    console.log(`Grounding:  ${aggregate.grounding.toFixed(3)} (threshold ${thresholds.grounding_min})`);
    console.log(`Cost:       ${totalCost === null ? 'unknown' : '$'+totalCost.toFixed(2)}`);
    console.log(`Verdict:    ${verdict.toUpperCase()}`);
    for (const r of reasons) {
      console.log(`  - ${r}`);
    }
  }

  return verdict === 'pass' ? 0 : verdict === 'fail' ? 1 : 2;
}
