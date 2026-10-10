import type { BrainEngine } from '../engine.ts';
import { buildBrainTools } from './tools/brain-allowlist.ts';
import { matchesSlugAllowList } from '../ops/context.ts';
import { isQuarantined } from '../quarantine.ts';
import { actionError, CODEX_ACTION_LIMITS, type CodexReadJob } from './codex-action-contract.ts';

/** Fixed local registry. Reads execute here; write definitions require the durable write handler. */
export function buildCodexReadTools(engine: BrainEngine, jobId: number, data: CodexReadJob) {
  return buildBrainTools({ engine, subagentId: jobId, config: { engine: engine.kind },
    allowedNames: new Set(data.allowed_tools), sourceId: data.source_id,
    allowedSlugPrefixes: data.allowed_slug_prefixes }).map(tool => ({ ...tool, async execute(input: unknown, ctx: Parameters<typeof tool.execute>[1]) {
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
