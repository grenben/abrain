import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import type { WriteAuthority } from '../persistence/model.ts';
import { submissionAuthority, authorizeWrite } from '../persistence/authority.ts';
import { effectiveVisibility } from '../search/private-visibility.ts';
import { isQuarantined } from '../quarantine.ts';
import { hybridSearch } from '../search/hybrid.ts';
import { INTERNAL_BREADTH_SEARCH_OPTS } from '../search/internal-breadth.ts';
import { embedQuery, isAvailable } from '../ai/gateway.ts';
import { fetchFar, enumeratePrefixes } from './domain-bank.ts';
import type { BrainstormProfile } from './orchestrator.ts';
import { ensureWellFormed } from '../text-safe.ts';
export interface BrainstormPage {
    sourceId: string;
    incarnation: string;
    slug: string;
    id: number;
    revision: string;
    private: boolean;
    authority: WriteAuthority;
    title: string | null;
    content: string;
}
export interface BrainstormSelection {
    close: BrainstormPage[];
    far: Array<BrainstormPage & {
        distance: number;
        sampling: 'prefix-stratified' | 'corpus-sample';
    }>;
    biases: string[] | null;
    short: boolean;
}
const changed = (): never => { throw new OperationError('revision_conflict', 'Brainstorm evidence changed or is unavailable.', 'Reconcile retained requests before starting a new run from current evidence.'); };
export async function validateBrainstormSelection(engine: BrainEngine, selection: BrainstormSelection): Promise<void> {
    const pages = [...selection.close, ...selection.far];
    if (pages.length > 64)
        changed();
    await engine.lockPageKeys(pages.map(p => ({ sourceId: p.sourceId, slug: p.slug })));
    for (const item of pages) {
        const [source] = await engine.executeRaw<{
            incarnation: string;
        }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived', [item.sourceId]);
        if (source?.incarnation !== item.incarnation)
            changed();
        await authorizeWrite(engine, item.authority, 'get_page', item.slug, true);
        const page = await engine.readPageSnapshot(item.slug, { sourceId: item.sourceId });
        if (!page || page.page.id !== item.id || page.revision !== item.revision || isQuarantined(page.page.frontmatter))
            changed();
    }
}
export async function selectBrainstormPages(ctx: OperationContext, input: {
    question: string;
    profile: BrainstormProfile;
    sourceIds: string[];
    holder: string;
    maxFarSet: number;
}): Promise<BrainstormSelection> {
    const engine = ctx.engine, embedding = isAvailable('embedding') ? await embedQuery(input.question) : null;
    let degraded = false;
    const found = input.profile.k_close ? await hybridSearch(engine, input.question, { ...INTERNAL_BREADTH_SEARCH_OPTS, limit: input.profile.k_close, sourceIds: input.sourceIds,
        onMeta: m => { degraded = !!m.degraded?.some(d => !(d.stage === 'embed_unavailable' && d.reason === 'embedding_disabled')); } }) : [];
    if (degraded)
        throw new OperationError('retrieval_failed', 'Brainstorm retrieval did not complete.', 'Resolve retrieval or auxiliary budget failures before retrying.');
    const seen = new Set<string>();
    const closeRows = found.filter(row => { const key = JSON.stringify([row.source_id, row.slug]); if (seen.has(key))
        return false; seen.add(key); return true; });
    const prefixes = await enumeratePrefixes(engine, { sourceIds: input.sourceIds });
    if (prefixes.length > 10000)
        throw new OperationError('invalid_params', 'Brainstorm domain enumeration exceeded its bound.', 'Use a narrower source scope.');
    const far = await fetchFar(engine, { m: input.profile.m_far, closeSet: closeRows.map(r => ({ slug: r.slug, prefix: r.slug.match(/^[^/]+\/[^/]+/)?.[0] ?? null })),
        questionEmbedding: embedding, staleBias: input.profile.stale_bias, sourceIds: input.sourceIds, maxFarSet: input.maxFarSet, prefixListOverride: prefixes });
    const capture = async (slug: string, sourceId: string | undefined, id: number): Promise<BrainstormPage> => {
        const sid = sourceId ?? (input.sourceIds.length === 1 ? input.sourceIds[0] : undefined);
        if (!sid || !input.sourceIds.includes(sid))
            changed();
        const [source] = await engine.executeRaw<{
            incarnation: string;
        }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived', [sid]);
        const page = await engine.readPageSnapshot(slug, { sourceId: sid });
        if (!source || !page || page.page.id !== id || isQuarantined(page.page.frontmatter))
            changed();
        const authority = await submissionAuthority({ ...ctx, sourceId: sid! }, 'get_page', sid!, source!.incarnation, slug);
        return { sourceId: sid!, incarnation: source!.incarnation, slug, id, revision: page!.revision, authority,
            private: effectiveVisibility({ kind: 'page', page: page!.page }) !== 'world', title: page!.page.title,
            content: ensureWellFormed(page!.page.compiled_truth).slice(0, 4000) };
    };
    const close: BrainstormPage[] = [], distant: BrainstormSelection['far'] = [];
    for (const row of closeRows)
        close.push(await capture(row.slug, row.source_id, row.page_id));
    for (const row of far.pages)
        distant.push({ ...await capture(row.slug, row.source_id, row.page_id), distance: row.distance_score, sampling: row.source });
    const [calibration] = await engine.executeRaw<{
        active_bias_tags: unknown;
    }>('SELECT active_bias_tags FROM calibration_profiles WHERE holder=$1 AND source_id=ANY($2::text[]) ORDER BY generated_at DESC,id DESC LIMIT 1', [input.holder, input.sourceIds]);
    const tags = calibration?.active_bias_tags;
    if (tags !== undefined && (!Array.isArray(tags) || tags.length > 32 || tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 160)))
        changed();
    return { close, far: distant, biases: Array.isArray(tags) && tags.length ? tags as string[] : null, short: far.short_of_target };
}
