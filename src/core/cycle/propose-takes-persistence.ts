import type { BrainEngine } from '../engine.ts';
import type { ProposedTake } from './propose-takes.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { currentVerifiedLocalWriter, registerLocalWriter } from '../persistence/identity.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { submissionAuthority, authorizeWrite } from '../persistence/authority.ts';
import type { WriteAuthority } from '../persistence/model.ts';

export interface TakeProposalBinding { sourceId: string; incarnation: string; slug: string; revision: string; body: string; writer: WriteAuthority }
export async function bindTakeProposalPage(engine: BrainEngine, sourceId: string, slug: string, body: string, ctx: OperationContext): Promise<TakeProposalBinding> {
  const authority = currentSubmissionAuthority();
  if (authority && authority.kind !== 'application' || currentVerifiedLocalWriter()?.remote) throw new OperationError('permission_denied', 'Private take proposals require local authority.', 'Use a trusted local cycle.');
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
  if (!source) throw new OperationError('source_changed', 'The proposal source is not active.', 'Review the source before retrying.');
  if (!currentVerifiedLocalWriter() && !ctx.auth?.principal) await registerLocalWriter(engine, 'cli');
  const writer = await submissionAuthority(ctx, 'submit_job', sourceId, source.incarnation, slug);
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!source || !snapshot || snapshot.sourceIncarnation !== source.incarnation || snapshot.page.deleted_at || snapshot.page.compiled_truth !== body) throw new OperationError('source_changed', 'The proposal source changed.', 'Retry from a fresh source snapshot.');
  return { sourceId, incarnation: source.incarnation, slug, revision: snapshot.revision, body, writer };
}
interface ProposalBatch {
  sourceId: string; slug: string; hash: string; version: string; runId: string; model: string;
  existing: unknown[]; proposals: ProposedTake[]; emptyText: string; binding?: TakeProposalBinding;
}
/** Private batch + valid-empty cache entry commit atomically under source/page/job fences. */
export async function persistTakeProposalBatch(engine: BrainEngine, batch: ProposalBatch): Promise<{ inserted: number; tombstones: number }> {
  const write = async (tx: BrainEngine) => {
    if (batch.binding) {
      const context = codexSubscriptionContext();
      if (!context) throw new OperationError('permission_denied', 'Subscription authority is missing.', 'Use an authorized subscription run.');
      context.signal?.throwIfAborted(); await context.checkAuthorityInTransaction?.(tx);
      const binding = batch.binding;
      const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived FOR SHARE', [binding.sourceId]);
      await authorizeWrite(tx, binding.writer, 'submit_job', binding.slug, true);
      const [page] = await tx.executeRaw<{ revision: string; compiled_truth: string }>('SELECT knowledge_revision::text AS revision,compiled_truth FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL FOR SHARE', [binding.sourceId, binding.slug]);
      if (!source || source.incarnation !== binding.incarnation || !page || page.revision !== binding.revision || page.compiled_truth !== binding.body) throw new OperationError('revision_conflict', 'The proposal input changed before persistence.', 'Retry using the current page.');
    }
    let inserted = 0;
    const empty = batch.proposals.length === 0;
    const proposals: ProposedTake[] = empty ? [{ claim_text: batch.emptyText, kind: 'fact', holder: 'brain', weight: 0 }] : batch.proposals;
    for (const proposal of proposals) {
      const evidence = batch.binding ? { version: 1, source_incarnation: batch.binding.incarnation,
        page_revision: batch.binding.revision, source_quote: proposal.source_quote ?? null, principal: batch.binding.writer.principal,
        subscription_run_id: codexSubscriptionContext()!.runId } : null;
      const rows = await tx.executeRaw<{ id: number }>(`INSERT INTO take_proposals
        (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_text,kind,holder,weight,domain,dedup_against_fence_rows,model_id,status,codex_evidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,$12,$13,$14::text::jsonb)
        ON CONFLICT (source_id,page_slug,content_hash,prompt_version,md5(claim_text)) DO NOTHING RETURNING id`,
      [batch.sourceId,batch.slug,batch.hash,batch.version,batch.runId,proposal.claim_text,proposal.kind,proposal.holder,proposal.weight,
        proposal.domain ?? null,JSON.stringify(batch.existing),proposal.served_model ?? batch.model,empty ? 'rejected' : 'pending',evidence === null ? null : JSON.stringify(evidence)]);
      inserted += rows.length;
    }
    return { inserted: empty ? 0 : inserted, tombstones: empty ? inserted : 0 };
  };
  if (!batch.binding) return write(engine);
  try { return await maintenanceTransaction(engine, write); }
  catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError('storage_error', 'Private proposal persistence did not complete.', 'Retry after checking the source and subscription run.');
  }
}
