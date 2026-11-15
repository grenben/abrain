import type { BrainEngine } from '../engine.ts';
import { buildBrainTools } from './tools/brain-allowlist.ts';
import { matchesSlugAllowList } from '../ops/context.ts';
import { isQuarantined } from '../quarantine.ts';
import { actionError, CODEX_DISCOVERY_REGISTRY, CODEX_ACTION_LIMITS, type CodexReadJob } from './codex-action-contract.ts';
import { isTrustTier } from '../trust/tier.ts';

/** Fixed local registry. Reads execute here; write definitions require the durable write handler. */
export function buildCodexReadTools(engine: BrainEngine, jobId: number, data: CodexReadJob) {
  return buildBrainTools({ engine, subagentId: jobId, config: { engine: engine.kind },
    allowedNames: new Set(data.allowed_tools), sourceId: data.source_id,
    allowedSlugPrefixes: data.allowed_slug_prefixes,
    ...(data.read_registry === CODEX_DISCOVERY_REGISTRY ? {
      nativeDiscovery: { allowedSlugPrefixes: data.allowed_slug_prefixes },
      nativeDiscoveryRequired: true,
    } : {}) }).map(tool => ({ ...tool, ...(tool.name === 'brain_search' ? { description: 'Keyword-only search within the authorized source and page prefixes. No embeddings or inference.', usage_hint: 'Find exact words in permitted indexed pages; then read a page for full context.' } : {}), async execute(input: unknown, ctx: Parameters<typeof tool.execute>[1]) {
    if (data.read_registry === CODEX_DISCOVERY_REGISTRY && ['brain_search', 'brain_list_pages'].includes(tool.name))
      return discoveryResult(tool, input, ctx, data);
    if (tool.name !== 'brain_get_page') actionError('write_requires_durable_binding');
    const slug = (input as { slug: string }).slug;
    if (!matchesSlugAllowList(slug, data.allowed_slug_prefixes)) actionError('unauthorized_action');
    // Source authority is host supplied, absent from the model schema. The operation still validates its original parameters.
    const result = await tool.execute({ slug, source_id: data.source_id, body: 'full' }, ctx);
    const projected = await authorizedPageProjection(engine, result, data);
    if (Buffer.byteLength(JSON.stringify(projected)) > CODEX_ACTION_LIMITS.result) actionError('result_limit');
    return projected;
  } }));
}

interface CodexPageProjection {
  slug: string;
  source_id: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  revision: string;
}

/**
 * Bind canonical authorization metadata to the presentation returned by get_page.
 * get_page deliberately quotes untrusted frontmatter for agent-facing readers, so
 * its visibility field is presentation and must never be used as an authorization
 * oracle. The operation first enforces its caller/source/trust policy and returns
 * quoted body + revision; a source-scoped snapshot then supplies canonical
 * visibility/quarantine metadata, accepted only at that exact revision.
 */
async function authorizedPageProjection(engine: BrainEngine, raw: unknown, data: CodexReadJob): Promise<CodexPageProjection> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) actionError('incomplete_read');
  const result = raw as Record<string, unknown>;
  const { slug, source_id, title, compiled_truth, timeline, revision } = result;
  if (source_id !== data.source_id || typeof slug !== 'string' || !matchesSlugAllowList(slug, data.allowed_slug_prefixes) ||
      typeof revision !== 'string' || !revision || typeof title !== 'string' ||
      typeof compiled_truth !== 'string' || typeof timeline !== 'string' ||
      !isTrustTier(result.trust_tier) || typeof result.origin !== 'string' ||
      !Object.hasOwn(result, 'frontmatter')) actionError('incomplete_read');
  if (result.chars !== (compiled_truth as string).length + (timeline as string).length) actionError('incomplete_read');

  // Use the canonical source-bound page state, not quoted frontmatter. A
  // revision mismatch means visibility/quarantine metadata and delivered body
  // did not come from the same page version; fail closed rather than retrying.
  const snapshot = await engine.readPageSnapshot(slug as string, { sourceId: data.source_id });
  if (!snapshot) return actionError('read_revision_mismatch');
  if (snapshot.page.source_id !== data.source_id || snapshot.page.slug !== slug ||
      snapshot.revision !== revision) actionError('read_revision_mismatch');
  const frontmatter = snapshot.page.frontmatter as Record<string, unknown> | null;
  const visibility = frontmatter?.visibility;
  if ((visibility !== undefined && visibility !== 'world') || isQuarantined(frontmatter) ||
      (result.quarantined !== undefined && result.quarantined !== null)) actionError('page_unavailable');

  // Keep the canonical get_page presentation intact: quoted metadata and body
  // remain untrusted data, and only the explicit safe body/revision fields leave.
  return {
    slug: slug as string,
    source_id: source_id as string,
    title: title as string,
    compiled_truth: compiled_truth as string,
    timeline: timeline as string,
    revision: revision as string,
  };
}

async function discoveryResult(tool: ReturnType<typeof buildBrainTools>[number], input: unknown, ctx: Parameters<typeof tool.execute>[1], data: CodexReadJob) {
  const args = input as { query?: string; limit: number; offset: number };
  const rows = await tool.execute({ ...args, limit: args.limit + 1, source_id: data.source_id }, ctx) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows) || rows.some(r => r.source_id !== data.source_id || typeof r.slug !== 'string' || !matchesSlugAllowList(r.slug, data.allowed_slug_prefixes))) actionError('unauthorized_result');
  const keys = tool.name === 'brain_search' ? ['slug', 'source_id', 'title', 'chunk_text', 'score', 'chunk_id'] : ['slug', 'source_id', 'title', 'type'];
  const result = { coverage: tool.name === 'brain_search' ? 'bounded_indexed_keyword_candidates' : 'authorized_visible_pages', mode: tool.name === 'brain_search' ? 'keyword' : 'listing', items: rows.slice(0, args.limit).map(r => Object.fromEntries(keys.map(k => [k, k === 'chunk_text' && typeof r[k] === 'string' ? (r[k] as string).slice(0, 600) : r[k]]))),
    has_more: rows.length > args.limit, next_offset: rows.length > args.limit && args.offset + args.limit <= 1000 ? args.offset + args.limit : null,
    offset_limit_reached: rows.length > args.limit && args.offset + args.limit > 1000 };
  if (Buffer.byteLength(JSON.stringify(result)) > CODEX_ACTION_LIMITS.result) actionError('result_limit');
  return result;
}
