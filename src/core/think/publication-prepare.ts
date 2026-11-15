import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { WriteRequest } from '../persistence/model.ts';
import type { ClaimPhaseClock } from '../persistence/claim-phase.ts';
import { preparePageMutation } from '../persistence/page-prepare.ts';
import { prepareTakesMutation } from '../persistence/takes-prepare.ts';
import { authorizeStoredRequest } from '../persistence/authority.ts';
import { OperationError } from '../ops/contract.ts';
import { readThinkPlan, thinkConflict } from './publication-guard.ts';
import { validateThinkEvidence } from './publication-evidence.ts';
/** Page/take effects, provenance and citation rows share the coordinator's commit and receipt. */
export async function prepareThinkPublication(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, signal?: AbortSignal, clock?: ClaimPhaseClock) {
    await authorizeStoredRequest(engine, row);
    const plan = await readThinkPlan(engine, String(row.intent?.codex_think_plan));
    const action = plan.payload.actions.find(a => a.admission.requestId === row.request_id);
    if (!action)
        thinkConflict();
    const check = async (tx: BrainEngine) => {
        const snapshot = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
        if ((snapshot?.revision ?? null) !== action!.expectedRevision)
            throw new OperationError('revision_conflict', 'The think publication target changed.', 'Inspect the retained plan and receipt before authorizing a new result.');
        await validateThinkEvidence(tx, plan.payload.evidence);
    };
    await check(engine);
    const prepared = action!.kind === 'page' ? await preparePageMutation(engine, row, config, undefined, signal, { coordinated: true, clock }) : await prepareTakesMutation(engine, row, config);
    return { ...prepared, sourceExclusive: true, exclusiveSources: [...new Set(plan.payload.evidence.map(e => e.sourceId))],
        additionalPageKeys: [...prepared.additionalPageKeys ?? [], ...plan.payload.evidence.map(e => ({ sourceId: e.sourceId, slug: e.slug }))],
        validate: async (tx: BrainEngine) => { await check(tx); await prepared.validate?.(tx); },
        apply: async (tx: BrainEngine) => {
            const outcome = await prepared.apply(tx);
            if (action!.kind !== 'page')
                return outcome;
            const page = await tx.getPage(row.slug, { sourceId: row.source_id });
            if (!page)
                thinkConflict();
            const citations = plan.payload.result.citations.map(c => {
                const matches = plan.payload.evidence.filter(e => e.slug === c.page_slug && (c.row_num === null || e.takes.some(t => t.row === c.row_num)));
                if (matches.length !== 1)
                    thinkConflict();
                return { citation: c, evidence: matches[0]! };
            });
            const inserted = await tx.addSynthesisEvidence(citations.filter(c => c.citation.row_num !== null).map(c => ({ synthesis_page_id: page!.id,
                take_page_id: c.evidence.id, take_row_num: c.citation.row_num!, citation_index: c.citation.citation_index })));
            await tx.addLinksBatch(citations.map(c => ({ from_slug: row.slug, from_source_id: row.source_id, to_slug: c.evidence.slug,
                to_source_id: c.evidence.sourceId, link_type: 'derived_from', link_source: 'codex-think' })), { auditSite: 'addLinksBatch' }); // gbrain-allow-direct-insert: provenance inside coordinated think publication
            return { ...outcome, evidence_inserted: inserted };
        } };
}
