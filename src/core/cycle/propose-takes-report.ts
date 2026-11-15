import type { BrainEngine } from '../engine.ts';
import type { ProposeTakesResult } from './propose-takes.ts';
import type { TakeProposalBinding } from './propose-takes-persistence.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { upsertExtractRollup, classifyRunStop } from '../extract/rollup-writer.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { OperationError } from '../ops/contract.ts';

/** Per-source reporting retains authority; a receipt failure cannot undo committed proposals. */
export class PrivateTakeReporting {
  private readonly sources = new Map<string, { binding: TakeProposalBinding; inserted: number; failed: number; calls: number }>();
  observe(binding: TakeProposalBinding, inserted = 0, failed = false, called = false): void {
    const item = this.sources.get(binding.sourceId) ?? { binding, inserted: 0, failed: 0, calls: 0 };
    item.inserted += inserted; item.failed += Number(failed); item.calls += Number(called);
    this.sources.set(binding.sourceId, item);
  }
  async finish(engine: BrainEngine, result: ProposeTakesResult, runId: string, model: string): Promise<void> {
    const managed = await managedPersistenceEnabled(engine);
    for (const [sourceId, item] of this.sources) {
      if (item.inserted > 0 && !managed) {
        try {
          await writeReceipt(engine, { kind: 'takes.proposed', source_id: sourceId, run_id: runId, round: 'single',
            extracted_at: new Date().toISOString(), total_rows: item.inserted, cost_usd: null, billing: 'subscription', model_id: model,
            summary: `Proposed ${item.inserted} takes for review.` }, async (tx, slug) => {
            const context = codexSubscriptionContext();
            if (!context) throw new OperationError('permission_denied', 'Subscription authority is missing.', 'Review the subscription run.');
            context.signal?.throwIfAborted(); await context.checkAuthorityInTransaction?.(tx);
            const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived FOR SHARE', [sourceId]);
            if (!source || source.incarnation !== item.binding.incarnation) throw new OperationError('source_changed', 'The receipt source changed.', 'Review the committed proposals.');
            await authorizeWrite(tx, item.binding.writer, 'submit_job', slug, true);
          });
        } catch { result.warnings.push('receipt_failed: committed proposals remain available for review'); }
      }
      const rollup = await upsertExtractRollup(engine, { kind: 'takes.proposed', source_id: sourceId, subscription: item.calls > 0,
        ...classifyRunStop({ budget_exhausted: result.budget_exhausted, deadline_hit: result.deadline_hit === true, error: item.failed > 0 }) });
      if (!rollup.ok) result.warnings.push('rollup_failed: proposal outcomes remain in durable storage');
    }
  }
}
