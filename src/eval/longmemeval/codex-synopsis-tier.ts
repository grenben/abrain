import type { BrainEngine } from '../../core/engine.ts';
import type { SynopsisTier, SynopsisTierOptions, SynopsisTierResult } from './synopsis-tier.ts';
import { codexSubscriptionContext } from '../../core/ai/subscription-context.ts';
import { assertSubscriptionTarget } from '../../core/ai/subscription-target.ts';
import { withCodexProposalCache } from '../../core/ai/codex-proposal-cache.ts';
import { CodexProposalError } from '../../core/ai/providers/codex-contract.ts';
import { reembedPageWithContextualRetrieval } from '../../core/contextual-retrieval-service.ts';
import { CODEX_SYNOPSIS_VERSION } from '../../core/ai/codex-versions.ts';
import { digest } from '../../core/persistence/digest.ts';

/** Legacy JSONL content and USD caps cannot stand in for native admission. */
export function validatePrivateSynopsisOptions(opts: SynopsisTierOptions): void {
  if (opts.cachePath || opts.maxUsdExplicit || opts.concurrencyExplicit && opts.concurrency !== 1)
    throw new Error('private synopsis requires the host proposal cache and subscription allowance; omit --synopsis-cache and --synopsis-max-usd, and use concurrency 1');
}

export async function applyPrivateSynopsisTier(engine: BrainEngine, pages: ReadonlyArray<{ slug: string }>, tier: SynopsisTier): Promise<SynopsisTierResult> {
  if (!tier.spend.subscription || tier.concurrency !== 1 || tier.chunkConcurrency !== 1 || pages.length > 256 ||
      new Set(pages.map(page => page.slug)).size !== pages.length) throw new CodexProposalError('invalid_input');
  await assertSubscriptionTarget(engine);
  const context = codexSubscriptionContext()!, sp = tier.spend;
  const before = { calls: sp.calls, hits: sp.cacheHits, input: sp.inputTokens, output: sp.outputTokens, unknown: sp.unknownUsageCalls };
  const out: SynopsisTierResult = { pages: pages.length, pages_synopsis: 0, pages_fallback: 0, pages_empty: 0, chunks: 0,
    calls: 0, cache_hits: 0, usd: null, billing: 'subscription' };
  // The request must already bind the authorized corpus. The complete prompt,
  // chunk evidence, native schema and model also enter each cache request hash.
  return withCodexProposalCache({ namespace: 'longmemeval-synopsis', bindingHash: digest({ runId: context.runId, protocol: CODEX_SYNOPSIS_VERSION }) }, async () => {
    for (const page of pages) {
      const result = await reembedPageWithContextualRetrieval({ privateRole: 'longmemeval-synopsis', engine, pageSlug: page.slug, sourceId: 'default',
        globalMode: 'per_chunk_synopsis', synopsisModel: tier.model, synopsisMaxTokens: tier.maxTokens, chunkConcurrency: 1,
        abortSignal: context.signal, onSynopsisResult: event => sp.recordNative(event.usage, event.cacheHit) });
      // No title fallback, automatic transient retry or false completion from a
      // missing or superseded page. A fenced empty projection is explicit.
      // Native proposal errors propagate; returned service failures fail the question.
      if (result.kind === 'skipped' && result.reason === 'no_chunks') { out.pages_empty!++; continue; }
      if (result.kind !== 'success' || result.mode_applied !== 'per_chunk_synopsis')
        throw new Error('private_eval_synopsis_publication_failed');
      out.pages_synopsis++;
      out.chunks += result.chunks_embedded;
    }
    Object.assign(out, { calls: sp.calls - before.calls, cache_hits: sp.cacheHits - before.hits,
      input_tokens: sp.inputTokens - before.input, output_tokens: sp.outputTokens - before.output,
      usage_complete: sp.unknownUsageCalls === before.unknown });
    return out;
  });
}
