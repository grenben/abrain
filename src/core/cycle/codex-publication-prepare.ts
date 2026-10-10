import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { WriteRequest } from '../persistence/model.ts';
import type { ClaimPhaseClock } from '../persistence/claim-phase.ts';
import { prepareMaintenanceMutation } from '../persistence/prepared-maintenance.ts';
import { validatePublicationEvidence, type PublicationEvidence } from './codex-publication-plan.ts';

/** Evidence and page publication are checked in the coordinator's same commit transaction. */
export async function prepareCodexPublication(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, clock?: ClaimPhaseClock) {
  const evidence = row.intent?.evidence as PublicationEvidence[];
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 100) throw new Error('codex_publication_invalid_evidence');
  const prepared = await prepareMaintenanceMutation(engine, { ...row, intent: { ...row.intent,
    kind: 'managed_maintenance_page' } }, config, clock);
  return { ...prepared, additionalPageKeys: [...prepared.additionalPageKeys ?? [],
    ...evidence.map(page => ({ sourceId: row.source_id, slug: page.slug }))],
    apply: async (tx: BrainEngine) => {
      const outcome = await prepared.apply(tx);
      await tx.addLinksBatch(evidence.map(page => ({ from_slug: row.slug, to_slug: page.slug,
        from_source_id: row.source_id, to_source_id: row.source_id, link_type: 'derived_from', link_source: 'codex-publication' })),
      { auditSite: 'addLinksBatch' }); // gbrain-allow-direct-insert: derived provenance inside coordinated publication transaction
      return outcome;
    },
    validate: async (tx: BrainEngine) => {
      await prepared.validate?.(tx);
      await validatePublicationEvidence(tx, row.source_id, evidence);
    },
  };
}
