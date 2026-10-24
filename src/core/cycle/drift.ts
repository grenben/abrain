import { withPrivateRoleScope } from '../ai/private-role-scope.ts';
import { formatCycleCost } from './budget-meter.ts';
import { readPrivateCodexConfig } from '../ai/private-policy.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { codexDriftJudge, CODEX_DRIFT_VERSION, bindPrivateDriftSource } from './drift-codex.ts';
/**
 * Drift dream phase (#2653 — wired v0.42.x; scaffold shipped v0.28).
 *
 * Detects takes whose underlying evidence has shifted since the take was
 * made. Two stages:
 *   1. Cheap SQL heuristic (findDriftCandidates): soft-band takes
 *      (weight 0.3–0.85, active, unresolved) on pages with fresh
 *      timeline_entries evidence inside the lookback window.
 *   2. LLM judge: each candidate's claim is compared against the recent
 *      timeline evidence; the judge returns {drifted, confidence,
 *      reasoning, suggested_weight}. BudgetMeter-gated.
 *
 * Output is REPORT-ONLY (v1 conservative posture): judged candidates land
 * on a `reports/drift-<date>` page. `dream.drift.auto_update` mutates
 * NOTHING in v1 — it is recorded in the report so operators can see the
 * flag state, and a future wave may wire weight adjustment behind it.
 *
 * Default-disabled. Operator opts in:
 *   gbrain config set dream.drift.enabled true
 *   gbrain config set dream.drift.lookback_days 30
 *   gbrain config set dream.drift.max_per_cycle 20
 *   gbrain config set dream.drift.budget 1.0
 */

import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { BudgetMeter, loadAllowUnpriced, loadPricingOverrides, parseBudgetUsd } from './budget-meter.ts';
import { resolveSynthMaxOutputTokens } from './synthesize-concepts.ts';
import { resolveCycleDate, shiftCalendarDate } from './cycle-date.ts';
import { resolveModel } from '../model-config.ts';
import type { DreamPhaseResult } from './auto-think.ts';
import { maintenancePreflight, publishMaintenancePage } from '../persistence/prepared-maintenance.ts';
import { serializeMarkdown } from '../markdown.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { publishOrHold, type PublicationHold } from '../persistence/accepted-pending.ts';

export interface DriftPhaseOpts {
  /** Private drift is source-scoped; legacy brain-global behavior is unchanged. */
  sourceId?: string;
  brainDir?: string;
  dryRun: boolean;
  /** Override the audit ledger path (tests). */
  auditPath?: string;
  /** issue #2860 --once: bypass the dream.drift.enabled gate for this run only. */
  forceEnabled?: boolean;
  /** Inject the judge model call (tests). Defaults to gateway chat. */
  judge?: DriftJudgeFn;
  /** C-15: the cycle's calendar date (runCycle resolves one per cycle). */
  cycleDate?: string;
}

export interface DriftConfig {
  enabled: boolean;
  lookbackDays: number;
  budgetUsd: number;
  allowUnpriced: boolean;
  autoUpdate: boolean;
  maxPerCycle: number;
}

async function loadDriftConfig(engine: BrainEngine): Promise<DriftConfig> {
  const enabledStr = await engine.getConfig('dream.drift.enabled');
  const lookbackStr = await engine.getConfig('dream.drift.lookback_days');
  const budgetStr = await engine.getConfig('dream.drift.budget');
  const autoStr = await engine.getConfig('dream.drift.auto_update');
  const maxPerStr = await engine.getConfig('dream.drift.max_per_cycle');
  return {
    enabled: enabledStr === 'true',
    lookbackDays: lookbackStr ? Math.max(1, parseInt(lookbackStr, 10) || 30) : 30,
    budgetUsd: parseBudgetUsd(budgetStr, 1.0),
    allowUnpriced: await loadAllowUnpriced(engine),
    autoUpdate: autoStr === 'true',
    maxPerCycle: maxPerStr ? Math.max(1, parseInt(maxPerStr, 10) || 20) : 20,
  };
}

export interface DriftCandidate {
  sourceId?: string;
  pageRevision?: string;
  takeId: number;
  pageId: number;
  pageSlug: string;
  rowNum: number;
  claim: string;
  weight: number;
  /** Number of timeline entries within the lookback window for the same page. */
  recentEvidenceCount: number;
}

/** Judge verdict: has the claim drifted relative to the evidence? */
export interface DriftVerdict {
  source_quote?: string;
  drifted: boolean;
  confidence: number;
  reasoning: string;
  /** Judge's suggested new weight (advisory only — v1 never applies it). */
  suggested_weight?: number;
}

/** Judge function signature — injected for tests. */
export type DriftJudgeFn = (input: {
  candidate: DriftCandidate;
  evidence: string;
  modelHint?: string;
  maxOutputTokens?: number;
}) => Promise<DriftVerdict>;

export const DRIFT_JUDGE_PROMPT = `You are auditing a knowledge-base "take" (a weighted claim) for drift:
has newer evidence shifted the ground under this claim since it was made?

Output ONLY one JSON object with these fields:
- drifted          (boolean) — true when the evidence meaningfully contradicts,
                   supersedes, or reframes the claim; false when it is
                   consistent or merely adjacent.
- confidence       (number in [0,1]) — your confidence in the drifted verdict.
- reasoning        (string, <=300 chars) — what in the evidence drove the verdict.
- suggested_weight (number in [0,1], optional) — where the take's weight should
                   move if drifted. Advisory only.

If the evidence is sparse or unrelated to the claim, return drifted=false with
low confidence.

TAKE:
  Claim:   {CLAIM}
  Weight:  {WEIGHT}
  Page:    {PAGE}

RECENT EVIDENCE (timeline entries on the same page):
{EVIDENCE_BLOCK}
`;

/** The judge prompt for one candidate; also the basis of its budget estimate. */
export function buildDriftPrompt(candidate: Pick<DriftCandidate, 'claim' | 'weight' | 'pageSlug'>, evidence: string): string {
  return DRIFT_JUDGE_PROMPT
    .replace('{CLAIM}', candidate.claim)
    .replace('{WEIGHT}', String(candidate.weight))
    .replace('{PAGE}', candidate.pageSlug)
    .replace('{EVIDENCE_BLOCK}', evidence);
}

/**
 * Parse the judge model's JSON output. Tolerant of fence wrapping and
 * leading prose; returns null on unrecoverable parse failure.
 */
export function parseDriftOutput(raw: string): DriftVerdict | null {
  if (!raw || raw.trim().length === 0) return null;
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = (fenced[1] ?? '').trim();
  const firstObj = text.indexOf('{');
  if (firstObj === -1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(firstObj));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.drifted !== 'boolean') return null;
  const confRaw = typeof r.confidence === 'number' ? r.confidence : Number.parseFloat(String(r.confidence ?? ''));
  if (!Number.isFinite(confRaw)) return null;
  const verdict: DriftVerdict = {
    drifted: r.drifted,
    confidence: Math.max(0, Math.min(1, confRaw)),
    reasoning: typeof r.reasoning === 'string' ? r.reasoning.slice(0, 300) : '',
  };
  const sw = typeof r.suggested_weight === 'number' ? r.suggested_weight : NaN;
  if (Number.isFinite(sw)) verdict.suggested_weight = Math.max(0, Math.min(1, sw));
  return verdict;
}

/** Production judge — calls gateway.chat with the DRIFT_JUDGE_PROMPT. */
export async function defaultDriftJudge(input: {
  candidate: DriftCandidate;
  evidence: string;
  modelHint?: string;
  maxOutputTokens?: number;
}): Promise<DriftVerdict> {
  if (readPrivateCodexConfig()) return codexDriftJudge(input);
  const { chat } = await import('../ai/gateway.ts');
  const result = await chat({
    messages: [{ role: 'user', content: buildDriftPrompt(input.candidate, input.evidence) }],
    ...(input.modelHint ? { model: input.modelHint } : {}),
    maxTokens: input.maxOutputTokens ?? resolveSynthMaxOutputTokens(input.modelHint ?? ''),
    allowFallback: false,
  });
  const parsed = parseDriftOutput(result.text);
  if (!parsed) {
    // Failed parse — conservative no-drift at zero confidence so the row
    // still surfaces in the report instead of disappearing silently.
    return { drifted: false, confidence: 0, reasoning: 'judge_output_parse_failed' };
  }
  return parsed;
}

/**
 * Cheap pre-LLM heuristic: takes that have substantial recent timeline
 * evidence on the same page MAY have drifted. Surface them; the LLM judge
 * decides.
 */
async function findDriftCandidates(
  engine: BrainEngine,
  lookbackDays: number,
  cycleDate?: string,
  sourceId?: string,
): Promise<DriftCandidate[]> {
  const cutoffIso = shiftCalendarDate(cycleDate ?? await resolveCycleDate(engine), -lookbackDays);
  // Only consider takes with weight in the "soft" middle band (0.3..0.85)
  // — facts (1.0) don't drift, very-low hunches (<0.3) aren't actionable yet.
  const rows = await engine.executeRaw<{
    take_id: number; page_id: number; page_slug: string; row_num: number;
    claim: string; weight: number; recent_evidence: number; source_id: string; page_revision: string;
  }>(`
    SELECT t.id AS take_id, p.id AS page_id, p.slug AS page_slug, t.row_num,
           t.claim, t.weight, p.source_id, p.knowledge_revision::text AS page_revision,
           (SELECT count(*)::int FROM timeline_entries te
              WHERE te.page_id = p.id
                AND te.date >= $1::date)
             AS recent_evidence
    FROM takes t
    JOIN pages p ON p.id = t.page_id
    WHERE t.active
      AND t.weight >= 0.3 AND t.weight <= 0.85
      AND t.resolved_at IS NULL AND ($2::text IS NULL OR (p.source_id=$2 AND p.deleted_at IS NULL))
    ORDER BY recent_evidence DESC, t.weight DESC
    LIMIT 200
  `, [cutoffIso, sourceId ?? null]);
  return rows
    .filter(r => Number(r.recent_evidence) >= 1)
    .map(r => ({
      takeId: Number(r.take_id),
      pageId: Number(r.page_id),
      pageSlug: String(r.page_slug),
      rowNum: Number(r.row_num),
      claim: String(r.claim),
      weight: Number(r.weight),
      recentEvidenceCount: Number(r.recent_evidence),
      sourceId: r.source_id, pageRevision: r.page_revision,
    }));
}

/** Format the candidate page's recent timeline entries as judge evidence. */
async function loadEvidence(
  engine: BrainEngine,
  pageId: number,
  cutoffIso: string,
  bounded = false,
): Promise<string> {
  const rows = await engine.executeRaw<{ date: string; source: string; summary: string }>(
    `SELECT date::text AS date, CASE WHEN $3 THEN left(source,128) ELSE source END AS source,
       CASE WHEN $3 THEN left(summary,1800) ELSE summary END AS summary FROM timeline_entries
     WHERE page_id = $1 AND date >= $2::date
     ORDER BY date DESC LIMIT 12`,
    [pageId, cutoffIso, bounded],
  );
  if (rows.length === 0) {
    if (bounded) throw new CodexProposalError('invalid_input');
    return '(no timeline entries in window)';
  }
  return rows.map(r => `- ${r.date} [${r.source}] ${r.summary}`).join('\n');
}

interface JudgedCandidate {
  candidate: DriftCandidate;
  verdict: DriftVerdict;
}

function buildReportBody(
  judged: JudgedCandidate[],
  cfg: DriftConfig,
  modelId: string,
  privateReport = false,
  failed = 0,
): string {
  const drifted = judged.filter(j => j.verdict.drifted);
  const lines: string[] = [
    `Drift check over active soft-band takes (weight 0.3–0.85) with timeline`,
    `evidence from the last ${cfg.lookbackDays} day(s). Judge model: ${modelId}.`,
    ``,
    `**Report-only:** no takes were modified. \`dream.drift.auto_update\` is`,
    `${cfg.autoUpdate ? 'set but ignored in v1 (report-only posture)' : 'off'}; review and adjust weights manually.`,
    ``,
    `${drifted.length} of ${judged.length} judged take(s) look drifted.`,
    ``,
  ];
  if (privateReport) lines.push(`Judgment protocol: ${CODEX_DRIFT_VERSION}. This report records the evidence snapshot supplied to the judge.`,
    `Failed judgments: ${failed}. Missing judgments are not stability findings.`, '');
  for (const { candidate: c, verdict: v } of judged) {
    lines.push(`## ${v.drifted ? 'DRIFTED' : 'stable'} — ${c.pageSlug} (take #${c.rowNum})`);
    lines.push(`- Claim: ${c.claim}`);
    lines.push(`- Weight: ${c.weight}${v.suggested_weight !== undefined ? ` → suggested ${v.suggested_weight}` : ''}`);
    lines.push(`- Confidence: ${v.confidence.toFixed(2)}`);
    if (v.reasoning) lines.push(`- Reasoning: ${v.reasoning}`);
    if (privateReport) lines.push(`- Evidence: [Source: [[${c.pageSlug}]], take ${c.takeId}, page revision ${c.pageRevision}]`,
      `- Quotation: ${JSON.stringify(v.source_quote)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function skipped(_reason: string, detail: string): DreamPhaseResult {
  return { name: 'drift', status: 'skipped', detail, duration_ms: 0 };
}

export async function runPhaseDrift(
  engine: BrainEngine,
  opts: DriftPhaseOpts,
): Promise<DreamPhaseResult> {
  const start = Date.now();
  const config = await loadDriftConfig(engine);
  if (!config.enabled && !opts.forceEnabled) {
    return skipped('not_configured', 'dream.drift.enabled is false');
  }

  const cycleDate = opts.cycleDate ?? await resolveCycleDate(engine);
  const privateMode = !!readPrivateCodexConfig(), sourceId = privateMode ? opts.sourceId ?? 'default' : 'default';
  const sourceBinding = privateMode ? await bindPrivateDriftSource(engine, sourceId) : undefined;
  const candidates = await findDriftCandidates(engine, config.lookbackDays, cycleDate, privateMode ? sourceId : undefined);
  if (candidates.length === 0) {
    return {
      name: 'drift',
      status: 'complete',
      detail: 'no candidates: no soft-band takes with recent timeline evidence',
      totals: { candidates: 0 },
      duration_ms: Date.now() - start,
    };
  }

  if (opts.dryRun) {
    return {
      name: 'drift',
      status: 'skipped',
      detail: `dry-run: ${Math.min(candidates.length, config.maxPerCycle)} of ${candidates.length} candidates would be evaluated`,
      totals: { candidates: candidates.length },
      duration_ms: Date.now() - start,
    };
  }

  return withPrivateRoleScope(['drift'], async () => {
  // #5280: a managed brain publishes the report through the maintenance
  // coordinator; the preflight refuses a missing canonical owner before any
  // judge spend. Null on an unmanaged brain.
  const maintenance = await maintenancePreflight(engine, sourceId);
  if (sourceBinding) await bindPrivateDriftSource(engine, sourceId, sourceBinding);
  const modelId = await resolveModel(engine, {
    privateRole: 'drift', configKey: 'models.drift',
    deprecatedConfigKey: 'dream.drift.model',
    tier: 'reasoning',
    fallback: 'sonnet',
  });
  const meter = new BudgetMeter({
    budgetUsd: config.budgetUsd,
    allowUnpriced: config.allowUnpriced,
    pricingOverrides: await loadPricingOverrides(engine),
    phase: 'drift',
    auditPath: opts.auditPath,
  });
  const maxOutputTokens = resolveSynthMaxOutputTokens(modelId);
  const judge = privateMode ? defaultDriftJudge : opts.judge ?? defaultDriftJudge;
  const cutoffIso = shiftCalendarDate(cycleDate, -config.lookbackDays);

  const judged: JudgedCandidate[] = [];
  let budgetExhausted = false;
  let failed = 0;
  for (const candidate of candidates.slice(0, config.maxPerCycle)) {
    if (sourceBinding) await bindPrivateDriftSource(engine, sourceId, sourceBinding);
    let evidence: string;
    try { evidence = await loadEvidence(engine, candidate.pageId, cutoffIso, privateMode); }
    catch (error) {
      if (!(error instanceof CodexProposalError)) throw error;
      failed += 1;
      continue;
    }
    const check = meter.check({
      modelId,
      // ~4 chars per token over the prompt the judge actually sends.
      estimatedInputTokens: Math.ceil(buildDriftPrompt(candidate, evidence).length / 4),
      maxOutputTokens,
      label: `drift:${candidate.pageSlug}#${candidate.rowNum}`,
    });
    if (!check.allowed) {
      budgetExhausted = true;
      break;
    }
    try {
      const verdict = await judge({ candidate, evidence, modelHint: modelId, maxOutputTokens });
      judged.push({ candidate, verdict });
    } catch (e) {
      failed += 1;
      const reason = privateMode ? (e instanceof CodexProposalError ? e.reason : e instanceof SubscriptionAdmissionError ? e.code : 'judgment_failed') : (e as Error).message;
      process.stderr.write(`[drift] judge failed on take ${candidate.takeId}: ${reason}\n`);
      if (privateMode && e instanceof SubscriptionAdmissionError) { budgetExhausted = true; break; }
      if (privateMode && e instanceof CodexProposalError && ['aborted','timeout','termination_unconfirmed'].includes(e.reason)) break;
    }
  }

  const driftedCount = judged.filter(j => j.verdict.drifted).length;
  let reportSlug: string | undefined;
  let reportHold: PublicationHold | null = null;
  if (judged.length > 0) {
    if (privateMode) await codexSubscriptionContext()?.checkAuthority?.();
    if (sourceBinding) await bindPrivateDriftSource(engine, sourceId, sourceBinding);
    reportSlug = `reports/drift-${cycleDate}`;
    // Report-only v1: the report page is the ONLY write this phase makes.
    // Typed `note` (+ report_type) so the default pack declares it (#5881).
    // Private reports stay in the selected source; legacy reports are brain-global.
    // Same-day re-runs upsert the same slug.
    if (maintenance) {
      const snapshot = await engine.readPageSnapshot(reportSlug, { sourceId });
      const report = serializeMarkdown({ report_type: 'drift', ...(privateMode ? { visibility: 'private', judgment_protocol: CODEX_DRIFT_VERSION } : {}) }, buildReportBody(judged, config, modelId, privateMode, failed), '',
        { type: 'note', title: `Drift report ${cycleDate}`, tags: [] });
      // #6052: a held report is not on the page yet, so it is neither linked nor counted as written.
      reportHold = await publishOrHold(() => publishMaintenancePage(engine, maintenance, reportSlug!, report,
        { expectedRevision: snapshot?.revision ?? null, file: false }));
      if (reportHold) reportSlug = undefined;
    } else {
      await maintenanceTransaction(engine, async tx => {
        if (sourceBinding) {
          await codexSubscriptionContext()?.checkAuthorityInTransaction?.(tx);
          await bindPrivateDriftSource(tx, sourceId, sourceBinding, true);
        }
        return tx.putPage(reportSlug!, {
        type: 'note',
        frontmatter: { report_type: 'drift', ...(privateMode ? { visibility: 'private', judgment_protocol: CODEX_DRIFT_VERSION } : {}) },
        title: `Drift report ${cycleDate}`,
        compiled_truth: buildReportBody(judged, config, modelId, privateMode, failed),
      }, { sourceId }); });
    }
  }

  const detail =
    `judged ${judged.length}/${candidates.length} candidates: ${driftedCount} drifted` +
    (reportSlug ? ` → ${reportSlug}` : '') +
    (reportHold === 'pending' ? ' (report accepted, still publishing)' : '') +
    (reportHold === 'contention' ? ' (report not admitted: database contention; the next cycle writes it)' : '') +
    (budgetExhausted ? ' (budget exhausted)' : '') +
    (failed > 0 ? ` (${failed} judge failure(s))` : '') +
    `. Cumulative cost: ${formatCycleCost(meter.totalSpent)} / $${config.budgetUsd.toFixed(2)}` +
    `. Report-only: auto_update=${config.autoUpdate} mutates nothing in v1.`;

  return {
    name: 'drift',
    status: judged.length > 0
      ? (budgetExhausted || failed > 0 || reportHold !== null || privateMode && judged.length < candidates.length ? 'partial' : 'complete')
      // Zero judged: budget capped before any judge ran → partial (capped,
      // not broken); otherwise every judge call failed → failed.
      : (budgetExhausted ? 'partial' : 'failed'),
    detail,
    totals: {
      candidates: candidates.length,
      judged: judged.length,
      drifted: driftedCount,
      failed,
      reports_written: Number(reportSlug !== undefined),
      publish_deferred: Number(reportHold !== null),
    },
    duration_ms: Date.now() - start,
  };
  }, false);
}

/** Test helper: expose findDriftCandidates without running the full phase. */
export const __testing = { findDriftCandidates };

/** Cycle adapter keeps source routing and outcome translation together. */
export async function runCycleDrift(engine: BrainEngine, opts: DriftPhaseOpts): Promise<PhaseResult> {
  const result = await runPhaseDrift(engine, opts);
  return { phase: 'drift', duration_ms: 0, summary: result.detail, details: { ...result.totals },
    status: result.status === 'complete' ? 'ok' : result.status === 'partial' ? 'warn' : result.status === 'failed' ? 'fail' : 'skipped' };
}

/** The dispatcher can report a disconnected phase without importing provider state. */
export async function runCycleDriftOrSkip(engine:BrainEngine|null,opts:DriftPhaseOpts):Promise<PhaseResult>{
  if(!engine)return{phase:'drift',status:'skipped',duration_ms:0,summary:'no database connected',details:{reason:'no_database'}};
  return runCycleDrift(engine,opts);
}
