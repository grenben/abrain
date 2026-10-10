import { opError } from './contract.ts';
import type { OperationContext } from './contract.ts';
import { assertExplicitSourceLive, federatedSearchScope } from './context.ts';

/** Explicit deterministic operation mode; no expansion, embeddings, reranker or metadata inference. */
export async function nativeDiscovery(ctx: OperationContext, p: Record<string, unknown>, kind: 'search' | 'list_pages') {
  if (!ctx.nativeDiscovery || ctx.viaSubagent !== true || ctx.remote !== true || !ctx.sourceId || p.source_id !== ctx.sourceId)
    throw opError('permission_denied', 'Native discovery requires a host read scope.', 'Use the authorized job registry and original source binding.');
  const scope = federatedSearchScope(ctx, ctx.sourceId);
  await assertExplicitSourceLive(ctx, ctx.sourceId);
  const limit = Number(p.limit), offset = Number(p.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 21 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000)
    throw opError('invalid_params', 'Native discovery input exceeds its bounds.', 'Use the limits from the job tool schema.');
  const opts = { ...scope, nativeDiscovery: ctx.nativeDiscovery, excludePrivate: true, limit, offset };
  if (kind === 'list_pages') return ctx.engine.listPages({ ...opts, sort: 'slug', listColumnsOnly: true });
  if (typeof p.query !== 'string' || !p.query.trim() || Buffer.byteLength(p.query) > 2000) throw opError('invalid_params', 'Native discovery input exceeds its bounds.', 'Use the limits from the job tool schema.');
  return ctx.engine.searchKeyword(p.query, { ...opts, requireSafeChunks: true });
}
