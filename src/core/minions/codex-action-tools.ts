import type { BrainEngine } from '../engine.ts';
import { buildBrainTools } from './tools/brain-allowlist.ts';
import { matchesSlugAllowList } from '../ops/context.ts';
import { isQuarantined } from '../quarantine.ts';
import { actionError, CODEX_DISCOVERY_REGISTRY, CODEX_ACTION_LIMITS, type CodexReadJob } from './codex-action-contract.ts';

/** Fixed local registry. Reads execute here; write definitions require the durable write handler. */
export function buildCodexReadTools(engine: BrainEngine, jobId: number, data: CodexReadJob) {
  return buildBrainTools({ engine, subagentId: jobId, config: { engine: engine.kind },
    allowedNames: new Set(data.allowed_tools), sourceId: data.source_id,
    allowedSlugPrefixes: data.allowed_slug_prefixes,
    nativeDiscovery: { allowedSlugPrefixes: data.allowed_slug_prefixes } }).map(tool => ({ ...tool, ...(tool.name === 'brain_search' ? { description: 'Keyword-only search within the authorized source and page prefixes. No embeddings or inference.', usage_hint: 'Find exact words in permitted indexed pages; then read a page for full context.' } : {}), async execute(input: unknown, ctx: Parameters<typeof tool.execute>[1]) {
    if (data.read_registry === CODEX_DISCOVERY_REGISTRY && ['brain_search', 'brain_list_pages'].includes(tool.name))
      return discoveryResult(tool, input, ctx, data);
    if (tool.name !== 'brain_get_page') actionError('write_requires_durable_binding');
    const slug = (input as { slug: string }).slug;
    if (!matchesSlugAllowList(slug, data.allowed_slug_prefixes)) actionError('unauthorized_action');
    // Source authority is host supplied, absent from the model schema. The operation still validates its original parameters.
    const result = await tool.execute({ slug, source_id: data.source_id }, ctx) as Record<string, unknown>;
    const frontmatter = result.frontmatter as Record<string, unknown> | undefined;
    if (result.source_id !== data.source_id || typeof result.slug !== 'string' || !matchesSlugAllowList(result.slug, data.allowed_slug_prefixes) ||
        (frontmatter?.visibility ?? 'world') !== 'world' || isQuarantined(frontmatter)) actionError('page_unavailable');
    // The existing operation strips privacy fences. Do not retain arbitrary frontmatter or raw diagnostics.
    const projected = Object.fromEntries(['slug', 'source_id', 'title', 'compiled_truth', 'timeline', 'revision'].map(k => [k, result[k]]));
    if (Buffer.byteLength(JSON.stringify(projected)) > CODEX_ACTION_LIMITS.result) actionError('result_limit');
    return projected;
  } }));
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
