import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { WriteRequest } from '../persistence/model.ts';
import type { ClaimPhaseClock } from '../persistence/claim-phase.ts';
import { preparePageMutation } from '../persistence/page-prepare.ts';
import { authorizeStoredRequest } from '../persistence/authority.ts';
import { OperationError } from '../ops/contract.ts';
import { readBrainstormPublication } from './codex-publication-guard.ts';
import { validateBrainstormSelection } from './codex-selection.ts';
/** Canonical file/database effects, provenance and the receipt share the prepared-write coordinator. */
export async function prepareBrainstormWrite(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, signal?: AbortSignal, clock?: ClaimPhaseClock) {
    await authorizeStoredRequest(engine, row);
    const plan = await readBrainstormPublication(engine, String(row.intent?.codex_brainstorm_run));
    const pages = [...plan.selection.close, ...plan.selection.far];
    const check = async (tx: BrainEngine) => {
        const target = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
        if ((target?.revision ?? null) !== plan.publication.expectedRevision)
            throw new OperationError('revision_conflict', 'Brainstorm destination changed.', 'Reconcile the retained request rather than generating another result.');
        await validateBrainstormSelection(tx, plan.selection);
    };
    const prepared = await preparePageMutation(engine, row, config, undefined, signal, { coordinated: true, clock });
    return { ...prepared, sourceExclusive: true, exclusiveSources: [...new Set(pages.map(p => p.sourceId))],
        additionalPageKeys: [...prepared.additionalPageKeys ?? [], ...pages.map(p => ({ sourceId: p.sourceId, slug: p.slug }))],
        validate: async (tx: BrainEngine) => { await check(tx); await prepared.validate?.(tx); },
        apply: async (tx: BrainEngine) => {
            const result = await prepared.apply(tx);
            await tx.addLinksBatch(pages.map(p => ({ from_slug: row.slug, from_source_id: row.source_id, to_slug: p.slug, to_source_id: p.sourceId,
                link_type: 'derived_from', link_source: 'codex-brainstorm' })), { auditSite: 'addLinksBatch' }); // gbrain-allow-direct-insert: provenance within coordinated brainstorm publication
            return result;
        } };
}
