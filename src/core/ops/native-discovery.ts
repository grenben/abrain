import { opError } from './contract.ts';
import type { OperationContext } from './contract.ts';
import { assertExplicitSourceLive, federatedSearchScope } from './context.ts';
import { resolveReadEligibility } from '../eligibility/policy.ts';

/** Explicit deterministic operation mode; no expansion, embeddings, reranker or metadata inference. */
export async function nativeDiscovery(ctx: OperationContext, p: Record<string, unknown>, kind: 'search' | 'list_pages') {
  const scope = ctx.nativeDiscovery;
  if (ctx.nativeDiscoveryRequired !== true || ctx.remote !== true || ctx.viaSubagent !== true || !scope || !Array.isArray(scope.allowedSlugPrefixes) ||
      scope.allowedSlugPrefixes.length > 16 ||
      scope.allowedSlugPrefixes.some(prefix => typeof prefix !== 'string' || prefix.length === 0 || prefix.length > 257 ||
        (prefix.includes('*') && (!prefix.endsWith('/*') || prefix.slice(0, -2).includes('*')))))
    throw opError('permission_denied', 'Native discovery requires a valid host read scope.', 'Use the authorized job registry and original source binding.');
  if (!ctx.sourceId || p.source_id !== ctx.sourceId)
    throw opError('permission_denied', 'Native discovery requires a host read scope.', 'Use the authorized job registry and original source binding.');
  const sourceScope = federatedSearchScope(ctx, ctx.sourceId);
  await assertExplicitSourceLive(ctx, ctx.sourceId);
  const limit = Number(p.limit), offset = Number(p.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 21 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000)
    throw opError('invalid_params', 'Native discovery input exceeds its bounds.', 'Use the limits from the job tool schema.');
  const { floor, suppressFlagged } = await resolveReadEligibility(ctx, { minTrust: p.min_trust, proactive: true });
  const discoveryScope = { ...scope, requireSafeChunks: true,
    ...(floor ? { minTrust: floor } : {}), ...(suppressFlagged ? { suppressFlagged: true } : {}) };
  const opts = { ...sourceScope, nativeDiscovery: discoveryScope, excludePrivate: true, requireSafeChunks: true,
    ...(floor ? { minTrust: floor } : {}), ...(suppressFlagged ? { suppressFlagged: true } : {}), limit, offset };
  if (kind === 'list_pages') return ctx.engine.listPages({ ...opts, sort: 'slug', listColumnsOnly: true });
  if (typeof p.query !== 'string' || !p.query.trim() || Buffer.byteLength(p.query) > 2000) throw opError('invalid_params', 'Native discovery input exceeds its bounds.', 'Use the limits from the job tool schema.');
  // Native discovery paginates by distinct page after ranking. searchKeyword's
  // chunk-grain candidate cap can underfetch when pages have many matching
  // chunks, making a valid offset return an empty window; this page-grain
  // statement applies the same scoped visibility predicates before OFFSET.
  return ctx.engine.searchKeywordPages(p.query, opts, { limit, offset });
}
