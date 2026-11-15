import { subscriptionTargetTransaction } from '../ai/subscription-target.ts';
import { withPrivateRoleScope } from '../ai/private-role-scope.ts';
/**
 * Dream phase `edge_contradictions`: an LLM flags which live state
 * relationships of one subject cannot both hold now ("works_at acme-example"
 * vs "works_at widget-co"); deterministic date arithmetic (`closeContradiction`
 * in src/core/link-validity.ts) decides which one ended and when. The model
 * never supplies dates.
 *
 * Modes (`dream.edge_contradictions.mode`):
 *   propose  record a proposal; `gbrain edge-proposals accept <id>` applies it
 *   apply    apply automatically (default only for certified models)
 *   off      do nothing
 * Applying writes one timeline line on the subject page through the
 * coordinated add_timeline_entry mutation:
 *   - **2025-03-01** | gbrain-dream (inferred) — Ended works_at [[companies/acme-example]] (superseded by works_at companies/widget-co)
 * then re-derives that page's links, so the closure lands through the
 * deterministic extractor (transition producer 'dream'). Deleting the line
 * reopens the relationship; the proposal is then marked reverted_by_user and
 * never re-proposed until the evidence changes.
 *
 * Candidates: subjects with ≥2 live relationships of the same state type to
 * different targets whose combined evidence hash has no proposal yet.
 * Bounded by max_subjects and the cycle budget meter (max_usd).
 */
import { redactProviderKeys } from '../ai/key-redact.ts';
import { redactConnectionInfo } from '../audit/redact-connection-info.ts';
import { applyRedaction, planRedaction } from '../secret-scan.ts';
import { LINK_EXTRACTION_GENERATION_KEY } from '../line-grammar.ts';
import { linkExtractorWatermarkFor } from '../link-extraction-watermark.ts';
import { NON_EMPLOYER_PREFIXES, NON_EMPLOYER_TYPES } from '../link-target-roles.ts';
import { entityTypePredicateSql, resolvePersonTypes } from '../schema-pack/entity-types.ts';
import { renderFragment, sqlFragment } from '../engine-sql/fragment.ts';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { BudgetMeter, loadAllowUnpriced, loadPricingOverrides, parseBudgetUsd, formatCycleCost } from './budget-meter.ts';
import { resolveModel } from '../model-config.ts';
import { closeContradiction, parseMultirange, utcToday, dateKey, type Stint } from '../link-validity.ts';
import { declaredSingleValueTypes, planSingleValueClosures } from '../link-single-value.ts';
import { readPrivateCodexConfig, assertPrivateRoute, privateModelForRole } from '../ai/private-policy.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { OperationError } from '../ops/contract.ts';

export interface EdgeContradictionsResult {
  name: 'edge_contradictions';
  status: 'complete' | 'partial' | 'failed' | 'skipped';
  detail: string;
  totals?: Record<string, number>;
  duration_ms: number;
}

export interface JudgeRelationship {
  index: number;
  link_type: string;
  target: string;
  target_title: string;
  since: string | null;
  contexts: string[];
}

export interface JudgePair { a: number; b: number; conflict: boolean; confidence: number }

export type EdgeJudgeFn = (input: {
  subject: { slug: string; title: string };
  relationships: JudgeRelationship[];
  modelHint?: string;
  maxOutputTokens?: number;
}) => Promise<JudgePair[] | null>;

export type EdgeContradictionsMode = 'propose' | 'apply' | 'off';

export interface EdgeContradictionsConfig {
  mode: EdgeContradictionsMode;
  modeExplicit: boolean;
  maxSubjects: number;
  budgetUsd: number;
  allowUnpriced: boolean;
}

export interface EdgeContradictionsOpts {
  dryRun?: boolean;
  judge?: EdgeJudgeFn;
  /** Apply a proposal (tests inject; default appends the timeline line via the coordinated op path). */
  applier?: (engine: BrainEngine, proposalId: number) => Promise<ApplyOutcome>;
  /** Treat the chat model as available (tests). */
  assumeChatAvailable?: boolean;
  auditPath?: string;
}

/**
 * Models whose sealed held-out run met the certification bar (wrong closures
 * ≤ 1% on every run and as-of +10 points over the deterministic arm): E2 on
 * set C, 3 runs each, 0 wrong closures (docs/eval/decisions/p1-e2-2026-10-05).
 * With no explicit mode, a certified model defaults to `apply`; every other
 * configured model defaults to `propose`. Matched without the provider prefix
 * and dated snapshot suffix ("anthropic:claude-haiku-4-5-20251001").
 */
export const CERTIFIED_APPLY_MODELS: readonly string[] = [
  'claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'gpt-6.1-sol',
];

export function isCertifiedApplyModel(model: string): boolean {
  const id = model.trim().toLowerCase().replace(/^[a-z0-9_-]+:/, '').replace(/-\d{8}$/, '');
  return CERTIFIED_APPLY_MODELS.includes(id);
}

const DEFAULT_MAX_SUBJECTS = 200;
const DEFAULT_BUDGET_USD = 1.0;
const MAX_RELATIONSHIPS_PER_SUBJECT = 8;
const JUDGE_MAX_OUTPUT_TOKENS = 600;
export const DREAM_TIMELINE_SOURCE = 'gbrain-dream (inferred)';

export async function loadEdgeContradictionsConfig(engine: BrainEngine, model: string): Promise<EdgeContradictionsConfig> {
  const raw = (await engine.getConfig('dream.edge_contradictions.mode'))?.trim().toLowerCase();
  const explicit = raw === 'propose' || raw === 'apply' || raw === 'off';
  const mode: EdgeContradictionsMode = explicit ? raw as EdgeContradictionsMode
    : model.startsWith('codex-cli:') ? 'propose' : isCertifiedApplyModel(model) ? 'apply' : 'propose';
  const subjects = Number.parseInt((await engine.getConfig('dream.edge_contradictions.max_subjects')) ?? '', 10);
  return {
    mode,
    modeExplicit: explicit,
    maxSubjects: Number.isFinite(subjects) && subjects > 0 ? subjects : DEFAULT_MAX_SUBJECTS,
    budgetUsd: parseBudgetUsd(await engine.getConfig('dream.edge_contradictions.max_usd'), DEFAULT_BUDGET_USD),
    allowUnpriced: await loadAllowUnpriced(engine),
  };
}

export const EDGE_JUDGE_PROMPT = `You check a person's or organization's current relationships in a personal knowledge base.
Each numbered relationship below is currently recorded as true. Decide, for each pair of relationships
of the SAME type, whether they can both be true at the same time right now.

Examples: two full-time works_at relationships at different companies usually cannot both hold
(someone moved jobs) unless the evidence says the person holds both roles; advising two companies,
working at a company while advising another, and board seats can all hold at once.

Do not guess dates. Judge only whether both can be true now, from the evidence shown.

Output ONLY one JSON object:
{"pairs": [{"a": <index>, "b": <index>, "conflict": true|false, "confidence": <0..1>}]}
List every same-type pair once.

SUBJECT: {SUBJECT}

RELATIONSHIPS:
{RELATIONSHIPS}
`;

export function buildEdgeJudgePrompt(subject: { slug: string; title: string }, relationships: JudgeRelationship[]): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '').slice(0, 240);
  const lines = relationships.map(r => `${r.index}. ${r.link_type} → ${clean(r.target_title || r.target)} (${r.target})` +
    `${r.since ? `, recorded since ${r.since}` : ', start date unknown'}` +
    `${r.contexts.length ? `\n   evidence: ${r.contexts.map(c => `"${clean(c)}"`).join(' | ')}` : ''}`);
  return EDGE_JUDGE_PROMPT.replace('{SUBJECT}', `${clean(subject.title)} (${subject.slug})`).replace('{RELATIONSHIPS}', lines.join('\n'));
}

/** Parse the judge's JSON; null on anything malformed (refusals, prose, unknown shapes). */
export function parseEdgeJudgeOutput(text: string, maxIndex: number): JudgePair[] | null {
  const match = /\{[\s\S]*\}/.exec(text ?? '');
  if (!match) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  const pairs = (parsed as { pairs?: unknown })?.pairs;
  if (!Array.isArray(pairs)) return null;
  const out: JudgePair[] = [];
  for (const p of pairs) {
    const a = Number((p as JudgePair).a), b = Number((p as JudgePair).b);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b || a < 1 || b < 1 || a > maxIndex || b > maxIndex) return null;
    if (typeof (p as JudgePair).conflict !== 'boolean') return null;
    const confidence = Number((p as JudgePair).confidence);
    out.push({ a, b, conflict: (p as JudgePair).conflict, confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5 });
  }
  return out;
}

export const CODEX_EDGE_JUDGE_VERSION = 'codex-edge-contradictions-v1';

/** A complete, unique verdict for every pair is required before a Codex turn is accepted. */
export function privateEdgeJudgeSchema(relationshipCount: number) {
  if (!Number.isInteger(relationshipCount) || relationshipCount < 2 || relationshipCount > MAX_RELATIONSHIPS_PER_SUBJECT)
    throw new CodexProposalError('invalid_input');
  const pairCount = relationshipCount * (relationshipCount - 1) / 2;
  return {
    name: CODEX_EDGE_JUDGE_VERSION,
    schema: { type: 'object', additionalProperties: false, required: ['pairs'], properties: {
      pairs: { type: 'array', minItems: pairCount, maxItems: pairCount, items: {
        type: 'object', additionalProperties: false, required: ['a', 'b', 'conflict', 'confidence'], properties: {
          a: { type: 'integer', minimum: 1, maximum: relationshipCount },
          b: { type: 'integer', minimum: 1, maximum: relationshipCount },
          conflict: { type: 'boolean' }, confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      } },
    } },
    validateCodexProposal: (text: string) => {
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new CodexProposalError('invalid_output'); }
      const pairs = (value as { pairs?: unknown } | null)?.pairs;
      if (!completeEdgeJudgeVerdict(pairs as JudgePair[] | null, relationshipCount)) throw new CodexProposalError('invalid_output');
    },
  };
}

/** A missing or repeated pair is an unknown judgment, never evidence of compatibility. */
function completeEdgeJudgeVerdict(verdict: JudgePair[] | null, relationshipCount: number): verdict is JudgePair[] {
  const expected = relationshipCount * (relationshipCount - 1) / 2;
  if (!Array.isArray(verdict) || verdict.length !== expected) return false;
  const seen = new Set<string>();
  for (const pair of verdict) {
    if (!pair || typeof pair !== 'object' || !Number.isInteger(pair.a) || !Number.isInteger(pair.b) || pair.a === pair.b ||
        pair.a < 1 || pair.b < 1 || pair.a > relationshipCount || pair.b > relationshipCount ||
        typeof pair.conflict !== 'boolean' || !Number.isFinite(pair.confidence) || pair.confidence < 0 || pair.confidence > 1) return false;
    const key = `${Math.min(pair.a, pair.b)}:${Math.max(pair.a, pair.b)}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export async function defaultEdgeJudge(input: Parameters<EdgeJudgeFn>[0]): Promise<JudgePair[] | null> {
  const { chat } = await import('../ai/gateway.ts');
  const policy = readPrivateCodexConfig();
  if (policy) assertPrivateRoute(input.modelHint ?? privateModelForRole(policy, 'edge-contradictions'), 'edge_contradictions:judge', policy, 'edge-contradictions');
  const result = await chat({
    privateRole: 'edge-contradictions',
    messages: [{ role: 'user', content: buildEdgeJudgePrompt(input.subject, input.relationships) }],
    ...(policy ? { model: input.modelHint ?? privateModelForRole(policy, 'edge-contradictions') } : input.modelHint ? { model: input.modelHint } : {}),
    maxTokens: input.maxOutputTokens ?? JUDGE_MAX_OUTPUT_TOKENS,
    allowFallback: false,
    ...(policy ? { responseSchema: privateEdgeJudgeSchema(input.relationships.length) } : {}),
  });
  return parseEdgeJudgeOutput(result.text, input.relationships.length);
}

interface CandidateRow {
  source_id: string; from_page_id: number; to_page_id: number; link_type: string;
  valid_ranges: string; last_start: unknown; recorded_at: unknown; evidence_hash: string;
  subject_slug: string; subject_title: string | null; target_slug: string; target_title: string | null;
  judgeContexts?: string[];
}

interface SubjectGroup { sourceId: string; fromId: number; slug: string; title: string; linkType: string; rels: CandidateRow[] }

async function findCandidateGroups(engine: BrainEngine, maxSubjects: number): Promise<SubjectGroup[]> {
  const today = utcToday();
  // After a line-grammar change, a subject whose links have not been re-derived yet is skipped: no closure is
  // decided on a half-reconciled graph. Before any change (generation unset) every subject is eligible, as before.
  const generation = await engine.getConfig(LINK_EXTRACTION_GENERATION_KEY);
  const pendingCutoff = generation ? linkExtractorWatermarkFor(generation) : null;
  // #6953: works_at members are admitted before grouping and LIMIT, so mistyped newer groups cannot starve valid
  // ones: the subject must be person-like by its source's pack (resolvePersonTypes; a pack that does not load admits
  // no works_at subject), and the target neither person-like nor a non-employer type (untyped: by slug directory).
  const personTypes = await resolvePersonTypes(engine, null);
  const isPerson = (alias: 'f' | 't') => entityTypePredicateSql(alias, personTypes.filter);
  const sql = renderFragment(sqlFragment`WITH live AS (
       SELECT lr.* FROM link_relationships lr
         JOIN pages f ON f.id = lr.from_page_id AND f.deleted_at IS NULL
         JOIN pages t ON t.id = lr.to_page_id AND t.deleted_at IS NULL
        WHERE lr.scope = 'all' AND lr.semantics = 'state' AND lr.valid_ranges @> ${today}::date
          AND (lr.link_type <> 'works_at' OR (${isPerson('f')} AND NOT ${isPerson('t')} AND
            CASE WHEN NULLIF(t.type, '') IS NOT NULL THEN NOT (t.type = ANY(${[...NON_EMPLOYER_TYPES]}::text[]))
              ELSE NOT EXISTS (SELECT 1 FROM unnest(${[...NON_EMPLOYER_PREFIXES]}::text[]) AS prefix(value)
                WHERE starts_with(t.slug, prefix.value)) END))
     ), multi AS (
       SELECT source_id, from_page_id, link_type FROM live
        GROUP BY 1, 2, 3 HAVING count(DISTINCT to_page_id) >= 2
        ORDER BY max(refreshed_at) DESC LIMIT ${maxSubjects}
     )
     SELECT l.source_id, l.from_page_id, l.to_page_id, l.link_type, l.valid_ranges::text AS valid_ranges,
            l.last_start, l.recorded_at, l.evidence_hash,
            f.slug AS subject_slug, f.title AS subject_title, t.slug AS target_slug, t.title AS target_title
       FROM live l JOIN multi m USING (source_id, from_page_id, link_type)
       JOIN pages f ON f.id = l.from_page_id AND f.deleted_at IS NULL
         AND (${pendingCutoff}::timestamptz IS NULL OR f.links_extracted_at >= ${pendingCutoff}::timestamptz)
       JOIN pages t ON t.id = l.to_page_id AND t.deleted_at IS NULL
      ORDER BY l.from_page_id, l.link_type, l.last_start NULLS FIRST, t.slug`);
  const rows = await engine.executeRaw<CandidateRow>(sql.text, sql.params);
  const groups = new Map<string, SubjectGroup>();
  for (const r of rows) {
    const key = `${r.from_page_id}\0${r.link_type}`;
    let g = groups.get(key);
    if (!g) { g = { sourceId: r.source_id, fromId: Number(r.from_page_id), slug: r.subject_slug, title: r.subject_title ?? r.subject_slug, linkType: r.link_type, rels: [] }; groups.set(key, g); }
    if (g.rels.length < MAX_RELATIONSHIPS_PER_SUBJECT) g.rels.push(r);
  }
  return [...groups.values()];
}

const pairHash = (a: CandidateRow, b: CandidateRow) =>
  createHash('sha256').update([a.evidence_hash, b.evidence_hash].sort().join(':')).digest('hex').slice(0, 32);
const ordered = (a: CandidateRow, b: CandidateRow): [CandidateRow, CandidateRow] => (Number(a.to_page_id) < Number(b.to_page_id) ? [a, b] : [b, a]);

/** The timeline line an applied proposal writes. */
export function dreamClosureLine(linkType: string, endingSlug: string, otherSlug: string): string {
  return `Ended ${linkType} [[${endingSlug}]] (superseded by ${linkType} ${otherSlug})`;
}

export async function runPhaseEdgeContradictions(engine: BrainEngine, opts: EdgeContradictionsOpts = {}): Promise<EdgeContradictionsResult> {
  const start = Date.now();
  const done = (status: EdgeContradictionsResult['status'], detail: string, totals?: Record<string, number>): EdgeContradictionsResult =>
    ({ name: 'edge_contradictions', status, detail, totals, duration_ms: Date.now() - start });

  const model = await resolveModel(engine, { privateRole: 'edge-contradictions', configKey: 'models.dream.edge_contradictions', tier: 'utility', fallback: 'haiku' });
  const config = await loadEdgeContradictionsConfig(engine, model);
  const declaredMode = await loadSingleValueMode(engine);
  if (config.mode === 'off' && declaredMode === 'off') return done('skipped', 'mode off (dream.edge_contradictions.mode, dream.single_value.mode)');

  const reverted = await markRevertedProposals(engine);
  const allGroups = await findCandidateGroups(engine, config.maxSubjects);
  if (allGroups.length === 0) return done('complete', `no subjects with competing live relationships${reverted ? `; ${reverted} reverted by user` : ''}`, { subjects: 0, reverted });
  if (opts.dryRun) return done('skipped', `dry-run: ${allGroups.length} subject(s) would be judged`, { subjects: allGroups.length });

  return withPrivateRoleScope(['edge-contradictions'], async () => {
  const declared = await runDeclaredSingleValue(engine, allGroups, declaredMode, opts);
  const groups = allGroups.filter(g => !declared.handled.has(g));
  const declaredDetail = declared.handled.size
    ? `; declared single-value: ${declared.totals.proposed} closure(s), ${declared.totals.applied} applied, ${declared.totals.undated_unresolved} undated, ${declared.totals.ambiguous_same_date} same-date`
    : '';
  const withDeclared = (t: Record<string, number>) => ({ ...t, ...Object.fromEntries(Object.entries(declared.totals).map(([k, v]) => [`declared_${k}`, v])) });
  if (groups.length === 0) return done('complete', `no subjects left for the judge${declaredDetail}`, withDeclared({ subjects: allGroups.length, reverted }));
  if (config.mode === 'off') return done(declared.handled.size ? 'complete' : 'skipped', `mode off (dream.edge_contradictions.mode)${declaredDetail}`, withDeclared({ subjects: allGroups.length, reverted }));
  if (!opts.judge && !opts.assumeChatAvailable) {
    const privatePolicy = readPrivateCodexConfig();
    if (privatePolicy) assertPrivateRoute(model, 'edge_contradictions:model', privatePolicy);
    const { isAvailable } = await import('../ai/gateway.ts');
    if (privatePolicy && !codexSubscriptionContext()) {
      return done(declared.handled.size ? 'complete' : 'skipped',
        `private Codex subscription allowance missing for ${model}${declaredDetail}`,
        withDeclared({ subjects: allGroups.length, reverted }));
    }
    if (!privatePolicy && !isAvailable('chat', model)) {
      return done(declared.handled.size ? 'complete' : 'skipped', `no chat model available (${model}); configure one (gbrain models) to have relationship contradictions proposed${declaredDetail}`, withDeclared({ subjects: allGroups.length, reverted }));
    }
  }

  const meter = new BudgetMeter({
    budgetUsd: config.budgetUsd, allowUnpriced: config.allowUnpriced,
    pricingOverrides: await loadPricingOverrides(engine), phase: 'edge_contradictions', auditPath: opts.auditPath,
  });
  const judge = readPrivateCodexConfig() ? defaultEdgeJudge : opts.judge ?? defaultEdgeJudge;
  const totals = { subjects: groups.length, judged: 0, proposed: 0, applied: 0, born_closed: 0, undated_unresolved: 0, ambiguous_same_date: 0, compatible: 0, errors: 0, skipped_known: 0, skipped_unpublished: 0, reverted };
  let budgetExhausted = false;

  for (const g of groups) {
    // Skip subjects whose every pair already has a proposal for this evidence.
    const pairs: Array<[CandidateRow, CandidateRow]> = [];
    for (let i = 0; i < g.rels.length; i++) for (let j = i + 1; j < g.rels.length; j++) pairs.push(ordered(g.rels[i], g.rels[j]));
    // #6311: an error row is known while it is in its 24 h backoff or held after JUDGE_MAX_ATTEMPTS.
    const known = new Set<string>();
    const priorAttempts = new Map<string, number>();
    for (const r of await engine.executeRaw<{ a: number; b: number; status: string; detail: string | null; recent: boolean }>(
      `SELECT a_to_page_id AS a, b_to_page_id AS b, status, detail, updated_at > now() - interval '24 hours' AS recent FROM link_edge_proposals
        WHERE from_page_id = $1 AND link_type = $2 AND evidence_hash = ANY($3::text[])`,
      [g.fromId, g.linkType, pairs.map(([a, b]) => pairHash(a, b))])) {
      const key = `${r.a}:${r.b}`;
      if (r.status === 'stale') continue; // Re-judge after a refused acceptance, even when the evidence hash is unchanged.
      const attempts = r.status === 'error' ? judgeAttempts(r.detail) : 0;
      if (r.status !== 'error' || r.recent || attempts >= JUDGE_MAX_ATTEMPTS) known.add(key);
      else priorAttempts.set(key, attempts);
    }
    const fresh = pairs.filter(([a, b]) => !known.has(`${a.to_page_id}:${b.to_page_id}`));
    if (fresh.length === 0) { totals.skipped_known++; continue; }

    const relationships: JudgeRelationship[] = await Promise.all(g.rels.map(async (r, i) => {
      r.judgeContexts = (await engine.executeRaw<{ context: string }>(
        `SELECT DISTINCT context FROM links WHERE from_page_id = $1 AND to_page_id = $2
          AND link_type = $3 AND context <> '' ORDER BY context LIMIT 3`,
        [r.from_page_id, r.to_page_id, r.link_type])).map(c => c.context);
      return { index: i + 1, link_type: r.link_type, target: r.target_slug,
        target_title: r.target_title ?? r.target_slug, since: dateKey(r.last_start), contexts: r.judgeContexts };
    }));
    const prompt = buildEdgeJudgePrompt(g, relationships);
    const check = meter.check({ modelId: model, estimatedInputTokens: Math.ceil(prompt.length / 4), maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS, label: `edge_contradictions:${g.slug}` });
    if (!check.allowed) { budgetExhausted = true; break; }

    let verdict: JudgePair[] | null = null;
    let failure = 'malformed: judge output missing or malformed';
    try { verdict = await judge({ subject: g, relationships, modelHint: model, maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS }); }
    catch (e) {
      failure = judgeFailureDetail(e);
      process.stderr.write(`[edge_contradictions] judge failed for ${g.slug}: ${failure}\n`);
    }
    if (verdict && !completeEdgeJudgeVerdict(verdict, relationships.length)) {
      verdict = null;
      failure = 'malformed: judge did not provide exactly one valid verdict for every relationship pair';
    }
    totals.judged++;
    for (const [a, b] of fresh) {
      const hash = pairHash(a, b);
      const ia = g.rels.indexOf(a) + 1, ib = g.rels.indexOf(b) + 1;
      if (!verdict) {
        const attempt = (priorAttempts.get(`${a.to_page_id}:${b.to_page_id}`) ?? 0) + 1;
        const detail = attempt >= JUDGE_MAX_ATTEMPTS
          ? `held after ${attempt} attempts; ${failure}; reset: gbrain edge-proposals retry --all-held`
          : `attempt ${attempt}/${JUDGE_MAX_ATTEMPTS}; ${failure}`;
        const id = await recordProposal(engine, g, a, b, hash, { status: 'error', model, detail });
        totals[id === null ? 'skipped_unpublished' : 'errors']++;
        continue;
      }
      const v = verdict.find(p => (p.a === ia && p.b === ib) || (p.a === ib && p.b === ia));
      if (!v) {
        const id = await recordProposal(engine, g, a, b, hash, { status: 'error', model, detail: 'malformed: missing relationship pair after validation' });
        totals[id === null ? 'skipped_unpublished' : 'errors']++;
        continue;
      }
      if (!v.conflict) {
        const id = await recordProposal(engine, g, a, b, hash, { status: 'compatible', model, confidence: v.confidence });
        totals[id === null ? 'skipped_unpublished' : 'compatible']++;
        continue;
      }
      const side = (r: CandidateRow) => ({ lastStart: dateKey(r.last_start), stints: parseMultirange(r.valid_ranges) as Stint[], recordedAt: r.recorded_at instanceof Date ? r.recorded_at : String(r.recorded_at) });
      const outcome = closeContradiction(side(a), side(b));
      if (outcome.action === 'none') {
        const status = outcome.reason === 'already_disjoint' ? 'compatible' : outcome.reason;
        const id = await recordProposal(engine, g, a, b, hash, { status, model, confidence: v.confidence });
        totals[id === null ? 'skipped_unpublished' : status === 'compatible' ? 'compatible' : status]++;
        continue;
      }
      const ending = outcome.side === 'a' ? a : b;
      const other = outcome.side === 'a' ? b : a;
      const id = await recordProposal(engine, g, a, b, hash, {
        status: 'proposed', model, confidence: v.confidence, endingTo: Number(ending.to_page_id), closeDate: outcome.closeDate,
        bornClosed: outcome.bornClosed, line: dreamClosureLine(g.linkType, ending.target_slug, other.target_slug),
      });
      if (id === null) { totals.skipped_unpublished++; continue; }
      totals.proposed++;
      if (outcome.bornClosed) totals.born_closed++;
      if (config.mode === 'apply' && id !== null) {
        const applied = await (opts.applier ?? applyEdgeProposal)(engine, id);
        if (applied.status === 'applied') totals.applied++;
      }
    }
  }

  const detail = `judged ${totals.judged}/${groups.length} subject(s): ${totals.proposed} proposal(s)` +
    (config.mode === 'apply' ? `, ${totals.applied} applied` : ' (mode propose: review with gbrain edge-proposals list)') +
    `, ${totals.compatible} compatible, ${totals.undated_unresolved} undated, ${totals.ambiguous_same_date} same-date` +
    (totals.errors ? `, ${totals.errors} judge error(s)` : '') +
    (totals.skipped_unpublished ? `, ${totals.skipped_unpublished} pair(s) skipped after judgment` : '') + (budgetExhausted ? ' (budget exhausted)' : '') +
    `. Cost: ${formatCycleCost(meter.totalSpent)} / $${config.budgetUsd.toFixed(2)} with ${model}${declaredDetail}`;
  const status = budgetExhausted || totals.errors ? (totals.judged ? 'partial' : 'failed') : 'complete';
  return done(status, detail, withDeclared(totals));
  }, false);
}

export type SingleValueMode = 'apply' | 'propose' | 'off';
export const SINGLE_VALUE_MODEL = 'schema-pack:cardinality';

async function loadSingleValueMode(engine: BrainEngine): Promise<SingleValueMode> {
  const raw = (await engine.getConfig('dream.single_value.mode'))?.trim().toLowerCase();
  return raw === 'apply' || raw === 'off' ? raw : 'propose';
}

/**
 * Groups whose relation the source's pack declares `cardinality: one_per_from`
 * are closed by the chain rule (link-single-value.ts) without a model: each
 * live relationship ends at the next one's dated start. Undated and same-date
 * members are recorded as open conflicts. Handled groups never reach the judge.
 */
async function runDeclaredSingleValue(
  engine: BrainEngine, groups: SubjectGroup[], mode: SingleValueMode, opts: EdgeContradictionsOpts,
): Promise<{ handled: Set<SubjectGroup>; totals: Record<string, number> }> {
  const totals = { groups: 0, proposed: 0, applied: 0, undated_unresolved: 0, ambiguous_same_date: 0 };
  const handled = new Set<SubjectGroup>();
  if (mode === 'off') return { handled, totals };
  const declaredBySource = new Map<string, Set<string>>();
  for (const g of groups) {
    if (!declaredBySource.has(g.sourceId)) declaredBySource.set(g.sourceId, await declaredSingleValueTypes(engine, g.sourceId));
    if (!declaredBySource.get(g.sourceId)!.has(g.linkType)) continue;
    handled.add(g);
    totals.groups++;
    const byTo = new Map(g.rels.map(r => [Number(r.to_page_id), r]));
    const plan = planSingleValueClosures(g.rels.map(r => ({
      to_page_id: Number(r.to_page_id), lastStart: dateKey(r.last_start), stints: parseMultirange(r.valid_ranges) as Stint[],
      recordedAt: r.recorded_at instanceof Date ? r.recorded_at : r.recorded_at == null ? null : String(r.recorded_at),
    })));
    const record = async (a: CandidateRow, b: CandidateRow, p: Parameters<typeof recordProposal>[5]) => {
      const [x, y] = ordered(a, b);
      return recordProposal(engine, g, x, y, pairHash(x, y), p);
    };
    for (const c of plan.closures) {
      const ending = byTo.get(c.ending)!, successor = byTo.get(c.successor)!;
      const id = await record(ending, successor, {
        status: 'proposed', model: SINGLE_VALUE_MODEL, confidence: 1, endingTo: c.ending, closeDate: c.closeDate,
        bornClosed: c.bornClosed, line: dreamClosureLine(g.linkType, ending.target_slug, successor.target_slug),
      });
      if (id === null) continue;
      totals.proposed++;
      if (mode === 'apply' && (await (opts.applier ?? applyEdgeProposal)(engine, id)).status === 'applied') totals.applied++;
    }
    const dated = g.rels.filter(r => dateKey(r.last_start));
    for (const to of plan.undated) {
      const a = byTo.get(to)!;
      const b = dated[dated.length - 1] ?? g.rels.find(r => r !== a)!;
      if (await record(a, b, { status: 'undated_unresolved', model: SINGLE_VALUE_MODEL, detail: 'declared single-value relation without a dated start' }) !== null) totals.undated_unresolved++;
    }
    for (const [x, y] of plan.sameDate) {
      if (await record(byTo.get(x)!, byTo.get(y)!, { status: 'ambiguous_same_date', model: SINGLE_VALUE_MODEL, detail: 'declared single-value relation with two starts on the same date' }) !== null) totals.ambiguous_same_date++;
    }
  }
  return { handled, totals };
}

/** #6311: judge attempts per evidence key; the 24 h backoff spaces them, then the pair is held until `edge-proposals retry`. */
export const JUDGE_MAX_ATTEMPTS = 3;

/** Attempts an error row records (`attempt N/3; …` or `held after N attempts; …`); a legacy row counts as one. */
function judgeAttempts(detail: string | null): number {
  const m = /^(?:attempt (\d+)\/\d+|held after (\d+) attempts);/.exec(detail ?? '');
  return m ? Number(m[1] ?? m[2]) : 1;
}

/** The stored failure: error class plus a redacted message of at most 200 characters. */
function judgeFailureDetail(e: unknown): string {
  const name = e instanceof Error ? e.name || 'Error' : 'Error';
  const raw = redactConnectionInfo(redactProviderKeys(e instanceof Error ? e.message : String(e), process.env));
  const message = applyRedaction(planRedaction(raw, { labeledCredentials: true })).replace(/\s+/g, ' ').trim();
  return `${name}: ${message.length > 200 ? `${message.slice(0, 199)}…` : message}`;
}

interface EdgeSnapshotMember {
  to_page_id: number; evidence_hash: string; valid_ranges: string; last_start: unknown; recorded_at: unknown;
  subject_title: string | null; target_title: string | null; target_slug: string; contexts: string[];
}

/** Re-read exactly the two live relationships and the context snippets used by the judge. */
async function readEdgeSnapshot(
  tx: BrainEngine, sourceId: string, fromId: number, linkType: string, targets: [number, number], subjectSlug: string,
): Promise<EdgeSnapshotMember[] | null> {
  const rows = await tx.executeRaw<Omit<EdgeSnapshotMember, 'contexts'>>(
    `SELECT lr.to_page_id, lr.evidence_hash, lr.valid_ranges::text AS valid_ranges,
            lr.last_start, lr.recorded_at, f.title AS subject_title, t.title AS target_title, t.slug AS target_slug
       FROM link_relationships lr
       JOIN sources s ON s.id=lr.source_id AND s.archived=false AND s.archived_at IS NULL
       JOIN pages f ON f.id=lr.from_page_id AND f.deleted_at IS NULL
       JOIN pages t ON t.id=lr.to_page_id AND t.deleted_at IS NULL
      WHERE lr.source_id=$1 AND lr.from_page_id=$2 AND lr.link_type=$3
        AND lr.to_page_id=ANY($4::bigint[]) AND lr.scope='all' AND lr.semantics='state'
        AND lr.valid_ranges @> $5::date AND f.slug=$6
      FOR SHARE OF lr, s, f, t`,
    [sourceId, fromId, linkType, targets, utcToday(), subjectSlug]);
  if (rows.length !== 2 || new Set(rows.map(row => Number(row.to_page_id))).size !== 2) return null;
  const members: EdgeSnapshotMember[] = [];
  for (const row of rows) {
    const contextRows = await tx.executeRaw<{ context: string }>(
      `SELECT context FROM links l WHERE from_page_id=$1 AND to_page_id=$2
        AND link_type=$3 AND context<>'' ORDER BY context FOR SHARE OF l`,
      [fromId, row.to_page_id, linkType]);
    members.push({ ...row, contexts: [...new Set(contextRows.map(item => item.context))].slice(0, 3) });
  }
  return members.sort((a, b) => Number(a.to_page_id) - Number(b.to_page_id));
}

function edgeSnapshotHash(sourceId: string, fromId: number, linkType: string, subjectSlug: string, members: EdgeSnapshotMember[]): string {
  const normalized = members.map(row => ({ to: Number(row.to_page_id), evidence: row.evidence_hash,
    ranges: row.valid_ranges, start: dateKey(row.last_start), recorded: new Date(row.recorded_at as string).toISOString(),
    subject: row.subject_title ?? subjectSlug, target: row.target_slug, title: row.target_title ?? row.target_slug,
    contexts: row.contexts }));
  return createHash('sha256').update(JSON.stringify({ sourceId, fromId, linkType, subjectSlug, members: normalized })).digest('hex');
}

async function recordProposal(
  engine: BrainEngine, g: SubjectGroup, a: CandidateRow, b: CandidateRow, hash: string,
  p: { status: string; model: string; confidence?: number | null; endingTo?: number; closeDate?: string; bornClosed?: boolean; line?: string; detail?: string },
): Promise<number | null> {
  const native = p.model.startsWith('codex-cli:') && !!readPrivateCodexConfig();
  const transaction = native ? (run: (tx: BrainEngine) => Promise<number | null>) => subscriptionTargetTransaction(engine, run) : engine.transaction.bind(engine);
  return transaction(async tx => {
    // The judge saw a snapshot. Lock both live relationships and their pages
    // before publishing anything inferred from it. Re-derivation, deletion,
    // title changes, and changed temporal tie-breakers make the verdict stale.
    const current = await readEdgeSnapshot(tx, g.sourceId, g.fromId, g.linkType,
      [Number(a.to_page_id), Number(b.to_page_id)], g.slug);
    if (!current) return null;
    const byTarget = new Map(current.map(row => [Number(row.to_page_id), row]));
    const instant = (value: unknown) => value == null ? null : new Date(value as string).getTime();
    const matches = (old: CandidateRow) => {
      const row = byTarget.get(Number(old.to_page_id));
      return row && row.evidence_hash === old.evidence_hash && row.valid_ranges === old.valid_ranges &&
        dateKey(row.last_start) === dateKey(old.last_start) && instant(row.recorded_at) === instant(old.recorded_at) &&
        (row.subject_title ?? g.slug) === g.title && row.target_slug === old.target_slug &&
        (row.target_title ?? old.target_slug) === (old.target_title ?? old.target_slug);
    };
    if (!matches(a) || !matches(b) || [a, b].some(old => old.judgeContexts &&
      JSON.stringify(byTarget.get(Number(old.to_page_id))!.contexts) !== JSON.stringify(old.judgeContexts))) return null;
    const snapshotHash = edgeSnapshotHash(g.sourceId, g.fromId, g.linkType, g.slug, current);
    const rows = await tx.executeRaw<{ id: number }>(
    `INSERT INTO link_edge_proposals (source_id, from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash, judge_snapshot_hash, status,
       ending_to_page_id, close_date, born_closed, model, confidence, generated_line, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, $13, $14, $15)
     ON CONFLICT (from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash) DO UPDATE SET
       status = EXCLUDED.status, judge_snapshot_hash = EXCLUDED.judge_snapshot_hash,
       ending_to_page_id = EXCLUDED.ending_to_page_id, close_date = EXCLUDED.close_date,
       born_closed = EXCLUDED.born_closed, model = EXCLUDED.model, confidence = EXCLUDED.confidence,
       generated_line = EXCLUDED.generated_line, detail = EXCLUDED.detail, updated_at = now()
     WHERE link_edge_proposals.status IN ('error','stale')
     RETURNING id`,
    [g.sourceId, g.fromId, Number(a.to_page_id), Number(b.to_page_id), g.linkType, hash, snapshotHash, p.status,
      p.endingTo ?? null, p.closeDate ?? null, p.bornClosed ?? false, p.model, p.confidence ?? null, p.line ?? null, p.detail ?? null]);
    if (native) await codexSubscriptionContext()?.checkAuthorityInTransaction?.(tx);
    return rows[0] ? Number(rows[0].id) : null;
  });
}

// ─── Apply / undo / revert detection ─────────────────────────────────────

/** Cycle adapter: maps the phase outcome onto the cycle's PhaseResult (duration filled by the caller). */
export async function edgeContradictionsCyclePhase(engine: BrainEngine | null, dryRun: boolean): Promise<PhaseResult> {
  if (!engine) return { phase: 'edge_contradictions', status: 'skipped', duration_ms: 0, summary: 'no database connected', details: { reason: 'no_database' } };
  const r = await runPhaseEdgeContradictions(engine, { dryRun });
  const status: PhaseResult['status'] = r.status === 'complete' ? 'ok' : r.status === 'partial' ? 'warn' : r.status === 'failed' ? 'fail' : 'skipped';
  return { phase: 'edge_contradictions', status, duration_ms: 0, summary: r.detail, details: { ...(r.totals ?? {}) } };
}

export type ApplyOutcome = { status: 'applied' | 'stale' | 'not_found' | 'refused' | 'undone' | 'rejected'; reason?: string };

export interface EdgeProposalGuard { id: number; snapshotHash: string }

interface ProposalRow {
  id: number; source_id: string; status: string; from_page_id: number; ending_to_page_id: number | null;
  a_to_page_id: number; b_to_page_id: number; judge_snapshot_hash: string | null;
  link_type: string; close_date: unknown; generated_line: string | null; subject_slug: string; ending_slug: string | null;
}

async function loadProposal(engine: BrainEngine, id: number, lock = false): Promise<ProposalRow | null> {
  const [row] = await engine.executeRaw<ProposalRow>(
    `SELECT p.id, p.source_id, p.status, p.from_page_id, p.a_to_page_id, p.b_to_page_id, p.judge_snapshot_hash,
            p.ending_to_page_id, p.link_type, p.close_date::text AS close_date,
            p.generated_line, f.slug AS subject_slug, t.slug AS ending_slug
       FROM link_edge_proposals p JOIN pages f ON f.id = p.from_page_id LEFT JOIN pages t ON t.id = p.ending_to_page_id
      WHERE p.id = $1${lock ? ' FOR SHARE OF p' : ''}`, [id]);
  return row ?? null;
}

/** Recheck the judged evidence while the coordinated timeline publication holds its transaction. */
export async function validateEdgeProposalPublication(tx: BrainEngine, guard: EdgeProposalGuard,
  target: { sourceId: string; slug: string; date: string; summary: string; pageId: number | null }): Promise<void> {
  const stale = () => new OperationError('revision_conflict',
    'The edge proposal evidence changed before publication.', 'Run the next dream cycle to re-judge the relationship.');
  if (!Number.isSafeInteger(guard.id) || guard.id < 1 || !/^[a-f0-9]{64}$/.test(guard.snapshotHash)) throw stale();
  // Row locks alone do not prevent a new context or relationship row from appearing.
  await tx.executeRaw('LOCK TABLE links, link_relationships IN SHARE MODE');
  const p = await loadProposal(tx, guard.id, true);
  if (!p || p.status !== 'proposed' || p.judge_snapshot_hash !== guard.snapshotHash ||
      p.source_id !== target.sourceId || p.subject_slug !== target.slug || p.from_page_id !== target.pageId ||
      dateKey(p.close_date) !== target.date || p.generated_line !== target.summary) throw stale();
  const members = await readEdgeSnapshot(tx, p.source_id, Number(p.from_page_id), p.link_type,
    [Number(p.a_to_page_id), Number(p.b_to_page_id)], p.subject_slug);
  if (!members || edgeSnapshotHash(p.source_id, Number(p.from_page_id), p.link_type, p.subject_slug, members) !== guard.snapshotHash) throw stale();
}

/** Does the subject page carry this proposal's closure (a dream transition on the ending relationship at the close date)? */
async function closureLanded(engine: BrainEngine, p: ProposalRow): Promise<boolean> {
  const rows = await engine.executeRaw(
    `SELECT 1 FROM link_transitions WHERE origin_page_id = $1 AND from_page_id = $1 AND to_page_id = $2 AND link_type = $3
        AND kind = 'end' AND producer = 'dream' AND occurred_on = $4::date LIMIT 1`,
    [p.from_page_id, p.ending_to_page_id, p.link_type, dateKey(p.close_date)]);
  return rows.length > 0;
}

/**
 * Apply one proposal: append the closure line to the subject page through the
 * coordinated add_timeline_entry mutation, re-derive that page's links (so the
 * closure lands as a 'dream' transition), then mark the proposal applied.
 * Refuses when the relationships changed since the judgment (stale).
 * Idempotent: replaying an applied proposal changes nothing.
 */
export async function applyEdgeProposal(engine: BrainEngine, id: number): Promise<ApplyOutcome> {
  const p = await loadProposal(engine, id);
  if (!p) return { status: 'not_found' };
  if (p.status === 'applied') return { status: 'applied', reason: 'already applied' };
  if (p.status !== 'proposed') return { status: 'refused', reason: `proposal is ${p.status}` };
  if (!p.ending_slug || !p.generated_line || !dateKey(p.close_date)) return { status: 'refused', reason: 'proposal has no closure to apply' };
  const expectedRevision = await engine.transaction(async tx => {
    const members = await readEdgeSnapshot(tx, p.source_id, Number(p.from_page_id), p.link_type,
      [Number(p.a_to_page_id), Number(p.b_to_page_id)], p.subject_slug);
    if (!members || !p.judge_snapshot_hash ||
        edgeSnapshotHash(p.source_id, Number(p.from_page_id), p.link_type, p.subject_slug, members) !== p.judge_snapshot_hash) {
      await tx.executeRaw(`UPDATE link_edge_proposals SET status='stale', updated_at=now() WHERE id=$1 AND status='proposed'`, [id]);
      return null;
    }
    return (await tx.readPageSnapshot(p.subject_slug, { sourceId: p.source_id }))?.revision ?? null;
  });
  if (!expectedRevision) return { status: 'stale', reason: 'the proposal evidence or source changed; the next dream cycle re-judges it' };
  try {
    // The PostgreSQL BIGINT row id may be a JS bigint; the publication guard requires a safe integer.
    await appendTimelineLine(engine, p.source_id, p.subject_slug, String(dateKey(p.close_date)), p.generated_line, expectedRevision,
      { id, snapshotHash: p.judge_snapshot_hash! });
  } catch (error) {
    if (!['revision_conflict', 'source_changed'].includes((error as { code?: string })?.code ?? '')) throw error;
    await engine.executeRaw(`UPDATE link_edge_proposals SET status='stale', updated_at=now() WHERE id=$1 AND status='proposed'`, [id]);
    return { status: 'stale', reason: 'the proposal evidence or subject page changed during acceptance; the next dream cycle re-judges it' };
  }
  await rederivePage(engine, p.source_id, p.subject_slug);
  const landed = await closureLanded(engine, p);
  await engine.executeRaw(`UPDATE link_edge_proposals SET status = $2, updated_at = now() WHERE id = $1`, [id, landed ? 'applied' : 'proposed']);
  return landed ? { status: 'applied' } : { status: 'refused', reason: 'the closure line was written but did not re-derive; run gbrain extract --stale and re-check' };
}

/** Reject a proposal (it will not be applied; a later evidence change re-judges the pair). */
export async function rejectEdgeProposal(engine: BrainEngine, id: number): Promise<ApplyOutcome> {
  const rows = await engine.executeRaw(`UPDATE link_edge_proposals SET status = 'rejected', updated_at = now() WHERE id = $1 AND status IN ('proposed','undated_unresolved','ambiguous_same_date') RETURNING 1`, [id]);
  return rows.length ? { status: 'rejected' } : { status: 'refused', reason: 'only open proposals can be rejected' };
}

/** Undo an applied proposal: remove its exact closure line, re-derive, mark undone. */
export async function undoEdgeProposal(engine: BrainEngine, id: number): Promise<ApplyOutcome> {
  const p = await loadProposal(engine, id);
  if (!p) return { status: 'not_found' };
  if (p.status !== 'applied' || !p.generated_line) return { status: 'refused', reason: `proposal is ${p.status}` };
  const removed = await removeTimelineLine(engine, p.source_id, p.subject_slug, String(dateKey(p.close_date)), p.generated_line);
  await rederivePage(engine, p.source_id, p.subject_slug);
  await engine.executeRaw(`UPDATE link_edge_proposals SET status = 'undone', updated_at = now() WHERE id = $1`, [id]);
  return { status: 'undone', ...(removed ? {} : { reason: 'the closure line was already gone' }) };
}

/** Applied proposals whose closure line the user deleted become reverted_by_user (never re-proposed for that evidence). */
async function markRevertedProposals(engine: BrainEngine): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `UPDATE link_edge_proposals p SET status = 'reverted_by_user', updated_at = now()
      WHERE p.status = 'applied' AND p.updated_at < now() AND NOT EXISTS (
        SELECT 1 FROM link_transitions t WHERE t.origin_page_id = p.from_page_id AND t.from_page_id = p.from_page_id
          AND t.to_page_id = p.ending_to_page_id AND t.link_type = p.link_type AND t.kind = 'end' AND t.producer = 'dream'
          AND t.occurred_on = p.close_date)
      RETURNING p.id`);
  return rows.length;
}

async function trustedCtx(engine: BrainEngine, sourceId: string) {
  return {
    engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as import('../operations.ts').OperationContext;
}

async function appendTimelineLine(engine: BrainEngine, sourceId: string, slug: string, date: string, summary: string, expectedRevision?: string,
  edgeProposalGuard?: EdgeProposalGuard): Promise<void> {
  const { operations } = await import('../operations.ts');
  const op = operations.find(o => o.name === 'add_timeline_entry')!;
  await op.handler(await trustedCtx(engine, sourceId), { slug, date, summary, source: DREAM_TIMELINE_SOURCE,
    ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
    ...(edgeProposalGuard ? { edge_proposal_guard: edgeProposalGuard } : {}) });
}

async function removeTimelineLine(engine: BrainEngine, sourceId: string, slug: string, date: string, summary: string): Promise<boolean> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot) return false;
  const needle = `- **${date}** | ${DREAM_TIMELINE_SOURCE} — ${summary}`;
  const strip = (text: string) => text.split('\n').filter(l => l.trim() !== needle).join('\n');
  const page = snapshot.page;
  const compiled = strip(page.compiled_truth ?? ''), timeline = strip(page.timeline ?? '');
  if (compiled === (page.compiled_truth ?? '') && timeline === (page.timeline ?? '')) return false;
  const { serializeMarkdown } = await import('../markdown.ts');
  const { operations } = await import('../operations.ts');
  const put = operations.find(o => o.name === 'put_page')!;
  const content = serializeMarkdown((page.frontmatter ?? {}) as Record<string, unknown>, compiled, timeline,
    { type: page.type, title: page.title, tags: snapshot.tags });
  await put.handler(await trustedCtx(engine, sourceId), { slug, content, expected_revision: snapshot.revision });
  return true;
}

/** Re-derive one page's links + temporal evidence from its current content (zero LLM). */
async function rederivePage(engine: BrainEngine, sourceId: string, slug: string): Promise<void> {
  const { autoLinkWrittenPage } = await import('../ops/pages.ts');
  await autoLinkWrittenPage(engine, slug, { sourceId });
}
