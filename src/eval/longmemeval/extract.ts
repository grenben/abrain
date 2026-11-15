/**
 * LongMemEval inline claim extractor. Strict private mode uses codex-extract.ts,
 * revalidates retained raw proposals and propagates failures. Complete private
 * fact batches require semantic validation and fenced atomic insertion.
 * The legacy free-form parsing/cache behavior below remains non-private only.
 *
 * Populates the benchmark brain's `facts` table so trajectory routing
 * (Commit 4) has data to retrieve. The benchmark contract change is
 * disclosed in the CHANGELOG + the JSON envelope's `methodology_note`
 * field (Codex D1 decision): this is full-haystack preprocessing, NOT a
 * gbrain-retrieval-only result.
 *
 * Per-session flow:
 *   1. Hash the session body (sha256). Cache hit → reuse parsed claims.
 *   2. Cache miss → one Haiku call. Output is a JSON array of claim/event
 *      records.
 *   3. parseModelJSON repairs the output (4-strategy fallback). Throws
 *      on adversarial input — caller fail-opens with 0 facts for that
 *      session.
 *   4. Canonicalize each `entity` via the per-question alias map +
 *      `resolveEntitySlug` (real-page-aware). First-mention-wins
 *      lowercase canonicalization keeps "Marco" / "Marco Smith" /
 *      "marco" collapsed to one slug.
 *   5. Bulk insert via `engine.insertFacts` (embedding null — benchmark
 *      doesn't need drift_score).
 *
 * Concurrency + timeout handled by the harness (Commit 4's adapter
 * loop) — this module's only async I/O is the Haiku call + the insert.
 *
 * Module-scope cache is per-process — appropriate for the benchmark's
 * ephemeral brain. Hit-rate is reported via `getCacheStats()` for
 * stderr telemetry per Codex Problem 14 (empirical verification of
 * the optimistic claim).
 */

import { assertSubscriptionTarget, subscriptionTargetTransaction } from '../../core/ai/subscription-target.ts';

import { createHash } from 'crypto';
import type { ThinkLLMClient } from '../../core/think/index.ts';
import {
  resolveEntitySlugWithSource,
  resolveStrictEntityReference,
  slugify,
  type ResolutionSource,
} from '../../core/entities/resolve.ts';
import type { BrainEngine, NewFact } from '../../core/engine.ts';
import { readPrivateCodexConfig } from '../../core/ai/private-policy.ts';
import { codexExtract } from './codex-extract.ts';
import { CODEX_EXTRACTOR_PROTOCOL } from './codex-protocols.ts';
import { codexSubscriptionContext } from '../../core/ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../../core/ai/subscription-admission.ts';
import { CodexProposalError } from '../../core/ai/providers/codex-contract.ts';

/**
 * Parse a JSON array from LLM output. The cross-modal `parseModelJSON`
 * expects a scored-object shape, so we use a smaller, array-aware
 * fallback chain here:
 *   1. Strip markdown fences if present, then JSON.parse.
 *   2. Find the first `[...]` substring and JSON.parse that.
 * Throws when neither path produces a valid array — caller treats
 * throw as "fail open, 0 facts for this session."
 */
function parseExtractedJsonArray(raw: string): unknown[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  // Strip ```json ... ``` fences if present.
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  const cleaned = (fenceMatch ? fenceMatch[1] : raw).trim();
  // Direct parse.
  try {
    const direct = JSON.parse(cleaned);
    if (Array.isArray(direct)) return direct;
  } catch {
    // fall through
  }
  // Fallback: extract first `[...]` substring.
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const second = JSON.parse(arrMatch[0]);
      if (Array.isArray(second)) return second;
    } catch {
      // fall through
    }
  }
  return [];
}

/** v0.40.2.0 wire shape for the extractor's per-session Haiku output. */
export interface ExtractedClaim {
  entity: string;
  metric: string | null;
  value: number | null;
  unit: string | null;
  period: string | null;
  event_type: string | null;
  valid_from: string;  // YYYY-MM-DD or ISO
  text: string;
}

/**
 * Per-question alias map. Persists across sessions within ONE question;
 * cleared via `clearAliasMap` (called by the harness before each new
 * question after `resetTables`). Codex Problem 4 — semantics pinned:
 * "Marco" in session 1 + "Marco Smith" in session 3 in the SAME question
 * collapse to one slug; aliases never leak across questions.
 */
export type AliasMap = Map<string, string>;

export function makeAliasMap(): AliasMap {
  return new Map();
}

interface CacheEntry {
  claims: ExtractedClaim[];
  hits: number;
}

const cache: Map<string, CacheEntry> = new Map();
let cacheHits = 0;
let cacheMisses = 0;

/**
 * Resets the cache + hit counters. Called once per benchmark run by the
 * harness so consecutive runs in the same process start clean. Tests
 * also call this in beforeEach.
 */
export function resetExtractorState(): void {
  cache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

export function getCacheStats(): CacheStats {
  return { hits: cacheHits, misses: cacheMisses, size: cache.size };
}

/**
 * The `methodology_note` disclosure stamped on routed rows and printed at
 * run end ("gbrain + <extractor>-preprocess", not "gbrain alone"). It names
 * the extractor that ran: a Haiku model keeps the published
 * `extractor=haiku-preprocess-full-haystack-v1` byte for byte, any other
 * model is named by its resolved id.
 */
export function trajectoryMethodologyNote(extractorModel: string): string {
  if (extractorModel.startsWith('codex-cli:')) return `extractor=${extractorModel}-preprocess-full-haystack; protocol=${CODEX_EXTRACTOR_PROTOCOL}; verbatim claims with date and entity evidence`;
  const modelId = extractorModel.slice(extractorModel.indexOf(':') + 1);
  const name = /haiku/i.test(modelId) ? 'haiku' : extractorModel;
  return `extractor=${name}-preprocess-full-haystack-v1`;
}

/** Output cap the extractor call sends. */
export const EXTRACTOR_MAX_TOKENS = 2000;

export const EXTRACTOR_SYSTEM_PROMPT = `You extract typed claims and events from a single chat-session transcript.

Output a JSON array of records. Each record has these fields:
  - entity:     The thing the claim is ABOUT (person name, company, place, object).
                Use the most specific name mentioned. Lowercase.
  - metric:     Canonical metric label (lowercase snake_case) like "mrr", "arr",
                "team_size", "role". Null when the row is an event rather than
                a typed numeric claim.
  - value:      The numeric value of the claim. Use a number, not a string.
                Null for non-numeric or event rows.
  - unit:       Currency or unit like "USD", "%", "count". Null when not present.
  - period:     Periodicity like "monthly", "annual", "once". Null when not present.
  - event_type: Event label like "meeting", "purchase", "trip", "job_change",
                "location_change". Null when the row is a numeric claim.
  - valid_from: The date the claim or event was true (YYYY-MM-DD). Use the
                session date if the transcript doesn't anchor a specific date.
  - text:       Short paraphrase of the underlying claim or event (one sentence,
                max 200 chars).

A row should have EITHER metric+value (numeric claim) OR event_type (event).
Not both. Skip filler conversation, opinions without dates, and questions —
extract only assertions of typed-claim or event shape.

If nothing in the transcript looks extractable, return [].

Output ONLY the JSON array. No prose, no markdown fences.`;

/**
 * Hash session body for cache lookup. SHA-256 of the raw markdown body —
 * the cache hit decision depends ONLY on what we'd actually send to the
 * Haiku call. Frontmatter changes (different session_id) DO change the
 * body since the renderer embeds them, so cache misses correctly when
 * session content shifts.
 */
function hashSessionBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Canonicalize an entity string via the per-question alias map +
 * `resolveEntitySlugWithSource`. First-mention-wins: the first canonical
 * slug we resolve for a normalized key sticks.
 *
 * Normalization strategy: lowercase + trim. Two-token names collapse to
 * a one-token alias under the first token ("Marco Smith" → first-mention
 * "marco" aliases to the same slug as later "Marco" mentions).
 */
export async function canonicalizeEvalEntity(
  engine: BrainEngine,
  sourceId: string,
  rawEntity: string,
  aliasMap: AliasMap,
  strict = false,
): Promise<{ slug: string; source: ResolutionSource } | null> {
  const normalized = rawEntity.trim().toLowerCase();
  if (!normalized) return null;
  if (strict) {
    try {
      const resolved = await resolveStrictEntityReference(engine, sourceId, rawEntity, { sameName: true, strictErrors: true });
      if (resolved.slug !== null) return { slug: resolved.slug, source: 'exact_page' };
      // The private extractor separately proves that the entity's name occurs
      // in the quoted transcript. If the source has no page for that grounded
      // name, retain LongMemEval's deterministic fallback identity; never use
      // it to resolve ambiguity, an unverified prefix, or a non-entity page.
      if (resolved.miss === 'no_page') {
        const slug = slugify(rawEntity.trim());
        if (slug) return { slug, source: 'fallback_slugify' };
      }
      throw new Error(`strict entity miss: ${resolved.miss}`);
    } catch { throw new Error('private_eval_entity_resolution_failed'); }
  }

  // Direct alias hit (full normalized form).
  if (aliasMap.has(normalized)) {
    return { slug: aliasMap.get(normalized)!, source: 'fuzzy_match' };
  }

  // Multi-word: check the first-token alias too. "Marco Smith" matches
  // a prior "marco" mention.
  const firstToken = normalized.split(/\s+/)[0];
  if (firstToken !== normalized && aliasMap.has(firstToken)) {
    aliasMap.set(normalized, aliasMap.get(firstToken)!);
    return { slug: aliasMap.get(firstToken)!, source: 'fuzzy_match' };
  }

  // No alias hit — resolve via engine. Real-page hits take priority over
  // slugify fallback.
  const resolved = await resolveEntitySlugWithSource(engine, sourceId, rawEntity);
  if (!resolved) return null;

  // Cache the canonical slug under BOTH the full normalized form and the
  // first token so future short-form mentions hit.
  aliasMap.set(normalized, resolved.slug);
  if (firstToken !== normalized) {
    if (!aliasMap.has(firstToken)) {
      aliasMap.set(firstToken, resolved.slug);
    }
  }
  return resolved;
}

/**
 * Validates that a single record from the Haiku output has the shape we
 * expect. Defensive: malformed records are dropped (returned null) so a
 * bad row doesn't poison the batch.
 */
function validateClaim(raw: unknown): ExtractedClaim | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.entity !== 'string' || r.entity.trim() === '') return null;
  if (typeof r.text !== 'string') return null;
  if (typeof r.valid_from !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(r.valid_from)) return null;
  // Exactly one of metric or event_type should be set (xor). Defensive:
  // accept null for both (treats as no-op but doesn't crash).
  const metric = typeof r.metric === 'string' ? r.metric : null;
  const eventType = typeof r.event_type === 'string' ? r.event_type : null;
  const value = typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null;
  const unit = typeof r.unit === 'string' ? r.unit : null;
  const period = typeof r.period === 'string' ? r.period : null;
  return {
    entity: r.entity,
    metric,
    value,
    unit,
    period,
    event_type: eventType,
    valid_from: r.valid_from,
    text: r.text.slice(0, 500),
  };
}

/**
 * Call the Haiku extractor on a session body. Returns parsed claims OR
 * null on any error (caller treats null as "extract nothing for this
 * session" — fail-open posture preserves benchmark progress).
 */
async function callExtractor(
  client: ThinkLLMClient,
  body: string,
  model: string,
): Promise<ExtractedClaim[] | null> {
  let response;
  try {
    response = await client.create({
      model,
      max_tokens: EXTRACTOR_MAX_TOKENS,
      system: EXTRACTOR_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: body }],
    });
  } catch {
    return null;
  }
  const block = response.content.find(b => b.type === 'text');
  const text = block && 'text' in block ? block.text : '';
  if (!text) return [];

  const parsed = parseExtractedJsonArray(text);
  if (parsed.length === 0) return [];
  const claims: ExtractedClaim[] = [];
  for (const item of parsed) {
    const v = validateClaim(item);
    if (v) claims.push(v);
  }
  return claims;
}

/**
 * Public entry: extract claims from one session body, canonicalize
 * entities via the per-question alias map + engine resolver, and bulk
 * insert into the facts table.
 *
 * Returns counts for telemetry. The legacy lane degrades internal failures;
 * private inference, identity, storage and publication failures propagate.
 */
export interface ExtractResult {
  /** Number of facts inserted into the database. */
  inserted: number;
  /** Number of claims parsed from the LLM response (pre-canonicalization). */
  parsed: number;
  /** Whether this session's claims came from cache (hit) or LLM (miss). */
  cacheHit: boolean;
}

export async function extractAndInsertClaims(opts: {
  engine: BrainEngine;
  client: ThinkLLMClient;
  model: string;
  sessionSlug: string;
  sessionId: string;
  sessionBody: string;
  sessionDate?: string;
  sourceId: string;
  aliasMap: AliasMap;
}): Promise<ExtractResult> {
  const privateMode = !!readPrivateCodexConfig(), context = codexSubscriptionContext();
  let sourceIncarnation: string | undefined;
  const fence = async (tx: BrainEngine) => {
    if (context!.signal?.aborted) throw new CodexProposalError('aborted');
    const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [opts.sourceId]);
    if (!source || source.archived || source.incarnation !== sourceIncarnation) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    if (context!.signal?.aborted) throw new CodexProposalError('aborted');
  };
  if (privateMode) {
    if (!context) throw new SubscriptionAdmissionError('subscription_required');
    await assertSubscriptionTarget(opts.engine);
    const expectedSessionId = opts.sessionSlug.slice(opts.sessionSlug.lastIndexOf('/') + 1);
    const expectedBody = opts.sessionBody.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    const snapshot = await opts.engine.readPageSnapshot(opts.sessionSlug, { sourceId: opts.sourceId, requireLiveSource: true });
    if (!snapshot || snapshot.page.slug !== opts.sessionSlug || opts.sessionId !== expectedSessionId ||
        snapshot.page.frontmatter.session_id !== undefined && snapshot.page.frontmatter.session_id !== opts.sessionId ||
        snapshot.page.compiled_truth.trim() !== expectedBody) {
      throw new SubscriptionAdmissionError('subscription_identity_conflict');
    }
    const [source] = await opts.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived', [opts.sourceId]);
    if (!source) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    sourceIncarnation = source.incarnation;
  }
  const hash = hashSessionBody(opts.sessionBody);
  let claims: ExtractedClaim[] | null;
  let cacheHit = false;
  const cached = cache.get(hash);
  if (privateMode) {
    ({ claims, cacheHit } = await codexExtract({ client: opts.client, model: opts.model, body: opts.sessionBody, sessionDate: opts.sessionDate }));
    if (cacheHit) cacheHits++; else cacheMisses++;
  } else if (cached) {
    cacheHit = true;
    cacheHits++;
    cached.hits++;
    claims = cached.claims;
  } else {
    cacheMisses++;
    claims = await callExtractor(opts.client, opts.sessionBody, opts.model);
    if (claims !== null) {
      cache.set(hash, { claims, hits: 0 });
    }
  }

  if (!claims || claims.length === 0) {
    if (privateMode) { await context!.checkAuthority?.(); await subscriptionTargetTransaction(opts.engine, fence); }
    return { inserted: 0, parsed: 0, cacheHit };
  }

  // Canonicalize entities + build NewFact rows. Drop rows whose entity
  // resolves to null (empty after trim).
  const rows: Array<NewFact & { row_num: number; source_markdown_slug: string }> = [];
  let rowNum = 1;
  for (const c of claims) {
    const canonical = await canonicalizeEvalEntity(opts.engine, opts.sourceId, c.entity, opts.aliasMap, privateMode);
    if (!canonical) { if (privateMode) throw new CodexProposalError('invalid_output'); continue; }
    rows.push({
      fact: c.text,
      kind: c.event_type ? 'event' : 'fact',
      entity_slug: canonical.slug,
      visibility: 'private',
      valid_from: new Date(c.valid_from),
      source: 'longmemeval:extractor',
      source_session: opts.sessionId,
      notability: 'medium',
      embedding: null,
      claim_metric: c.metric,
      claim_value: c.value,
      claim_unit: c.unit,
      claim_period: c.period,
      event_type: c.event_type,
      row_num: rowNum++,
      source_markdown_slug: opts.sessionSlug,
    });
  }

  if (rows.length === 0) return { inserted: 0, parsed: claims.length, cacheHit };
  if (privateMode) {
    await context!.checkAuthority?.();
    return subscriptionTargetTransaction(opts.engine, async tx => {
      await fence(tx);
      const ins = await tx.insertFacts(rows, { source_id: opts.sourceId }); // gbrain-allow-direct-insert: benchmark native extraction; bounded validated rows, source/worker fence, atomic batch.
      if (context!.signal?.aborted) throw new CodexProposalError('aborted');
      if (ins.inserted !== rows.length) throw new CodexProposalError('invalid_output');
      return { inserted: ins.inserted, parsed: claims.length, cacheHit };
    });
  }
  try {
    const ins = await opts.engine.insertFacts(rows, { source_id: opts.sourceId }); // gbrain-allow-direct-insert: benchmark harness only — populates ephemeral in-memory PGLite per LongMemEval run; no markdown source-of-truth contract applies (chat sessions are the corpus, NOT a brain repo).
    return { inserted: ins.inserted, parsed: claims.length, cacheHit };
  } catch {
    // Insert collision (row_num unique-index conflict on cache hit
    // where prior session already populated). Treat as 0-inserted but
    // count parsed for the telemetry.
    return { inserted: 0, parsed: claims.length, cacheHit };
  }
}
