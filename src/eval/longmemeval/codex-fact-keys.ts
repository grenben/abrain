import type { BrainEngine } from '../../core/engine.ts';
import type { ChunkInput } from '../../core/types.ts';
import type { FactKeyArm, FactKeyArmResult, FactKeySpend } from './retrieval-arms.ts';
import { CODEX_FACT_KEYS_PROTOCOL, codexFactKeyItems, privateFactKeyModel } from './codex-fact-keys-extract.ts';
import { withCodexProposalCache } from '../../core/ai/codex-proposal-cache.ts';
import { codexSubscriptionContext } from '../../core/ai/subscription-context.ts';
import { assertSubscriptionTarget, subscriptionTargetTransaction } from '../../core/ai/subscription-target.ts';
import { assertEphemeralBrain } from '../../core/ephemeral-brain.ts';
import { hasAIInvocationGuard, withAIInvocationPreflight } from '../../core/ai/invocation-guard.ts';
import { SubscriptionAdmissionError } from '../../core/ai/subscription-admission.ts';
import { CodexProposalError } from '../../core/ai/providers/codex-contract.ts';
import { readProjectionSnapshot, installPageEmbeddings, type ProjectionSnapshot } from '../../core/page-state/projections.ts';
import { assignFactKeys, factKeyedEmbeddingInput } from '../../core/fact-keys.ts';
import { embedBatch } from '../../core/embedding.ts';
import { digest, sha256 } from '../../core/persistence/digest.ts';
import { isGatewayThinkClient } from './gateway-client.ts';
import { pageBodyBytes } from '../../core/page-body/page-shape.ts';

/** All proposals and vectors are prepared before one fenced scratch publication. */
export async function applyPrivateFactKeys(engine: BrainEngine, pages: ReadonlyArray<{ slug: string }>, arm: FactKeyArm, spend: FactKeySpend): Promise<FactKeyArmResult> {
  if (!spend.subscription || !isGatewayThinkClient(arm.client) || arm.cachePath || pages.length > 256 ||
      !['paper', 'production'].includes(arm.extractor) || !['chunk', 'page'].includes(arm.assignment) ||
      new Set(pages.map(page => page.slug)).size !== pages.length) throw new CodexProposalError('invalid_input');
  await assertEphemeralBrain(engine);
  await assertSubscriptionTarget(engine);
  const context = codexSubscriptionContext()!;
  if (!hasAIInvocationGuard()) throw new SubscriptionAdmissionError('subscription_auxiliary_budget_required');
  await privateFactKeyModel(context.engine, arm.extractor, arm.model);
  await privateFactKeyModel(engine, arm.extractor, arm.model);
  const prepared: Array<{ projection: ProjectionSnapshot; body: string; items: string[]; inputs: Map<number, string>; chunks: ChunkInput[] }> = [];
  let totalChunks = 0;
  for (const page of pages) {
    const projection = await readProjectionSnapshot(engine, page.slug, 'default', { requireLiveSource: true });
    if (!projection || projection.snapshot.page.deleted_at || projection.pageKind !== 'markdown') throw new Error('private_fact_keys_projection_incomplete');
    const body = projection.chunks.map(chunk => chunk.chunk_text).join('\n\n');
    if (pageBodyBytes(projection.snapshot.page) > 0 && !projection.chunks.length) throw new Error('private_fact_keys_projection_incomplete');
    totalChunks += projection.chunks.length;
    if (totalChunks > 256 || Buffer.byteLength(body) > 160000) throw new CodexProposalError('invalid_input');
    prepared.push({ projection, body, items: [] as string[], inputs: new Map<number, string>(), chunks: [] as ChunkInput[] });
  }
  const before = { calls: spend.calls, hits: spend.cacheHits, input: spend.inputTokens, output: spend.outputTokens, unknown: spend.unknownUsageCalls };
  const out: FactKeyArmResult = { pages_keyed: 0, chunks_keyed: 0, items: 0, pages_empty: 0,
    protocol: CODEX_FACT_KEYS_PROTOCOL, billing: 'subscription', usd: null, calls: 0, cache_hits: 0 };
  return withAIInvocationPreflight(async () => { context.signal?.throwIfAborted(); await context.checkAuthority?.(); }, () =>
    withCodexProposalCache({ namespace: 'longmemeval-fact-keys', bindingHash: digest({ runId: context.runId, protocol: CODEX_FACT_KEYS_PROTOCOL, extractor: arm.extractor }) }, async () => {
      for (const plan of prepared) plan.items = await codexFactKeyItems(plan.body, arm, spend);
      for (const plan of prepared) {
        const { projection } = plan;
        const keys = assignFactKeys(plan.items, projection.chunks, arm.assignment);
        const targets = projection.chunks.flatMap((chunk, i) => keys[i] ? [{ chunk, input: factKeyedEmbeddingInput(chunk.chunk_text, projection.snapshot.page.title, keys[i]) }] : []);
        if (!targets.length) { out.pages_empty!++; continue; }
        const vectors = await embedBatch(targets.map(target => target.input), { abortSignal: context.signal });
        for (let i = 0; i < targets.length; i++) {
          const { chunk, input } = targets[i]!;
          plan.inputs.set(chunk.chunk_index, input);
          plan.chunks.push({ chunk_index: chunk.chunk_index, chunk_text: chunk.chunk_text,
            chunk_source: chunk.chunk_source, embedding: vectors[i]!, model: projection.embeddingModel ?? undefined });
        }
        out.pages_keyed++; out.chunks_keyed += targets.length; out.items += plan.items.length;
      }
      await context.checkAuthority?.();
      await subscriptionTargetTransaction(engine, async tx => {
        for (const plan of prepared) {
          const { projection } = plan, sourceId = projection.snapshot.page.source_id;
          const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [sourceId]);
          if (!source || source.archived || source.incarnation !== projection.snapshot.sourceIncarnation ||
              !(await installPageEmbeddings(tx, projection, plan.chunks)).complete) throw new Error('private_fact_keys_projection_conflict');
          // Exact fact-key input proof replaces the generic tier proof in the SAME
          // transaction. Ordinary projection rebuilds cannot preserve this vector
          // by mistaking it for an embedding of plain text or a title wrapper.
          for (const chunk of plan.chunks) await tx.executeRaw(`UPDATE content_chunks SET embedding_input_hash=$1
            WHERE page_id=$2 AND chunk_index=$3`, [digest({ protocol: CODEX_FACT_KEYS_PROTOCOL,
            column: projection.embeddingColumn, model: projection.embeddingModel, input: sha256(plan.inputs.get(chunk.chunk_index)!) }),
            projection.snapshot.page.id, chunk.chunk_index]);
        }
        context.signal?.throwIfAborted();
      });
      Object.assign(out, { calls: spend.calls - before.calls, cache_hits: spend.cacheHits - before.hits,
        input_tokens: spend.inputTokens - before.input, output_tokens: spend.outputTokens - before.output, usage_complete: spend.unknownUsageCalls === before.unknown });
      return out;
    }));
}
