import { effectiveVisibility } from '../search/private-visibility.ts';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { submissionAuthority, authorizeWrite } from '../persistence/authority.ts';
import { digest } from '../persistence/digest.ts';
import type { ThinkGatherResult } from './gather.ts';
import type { RunThinkOpts } from './index.ts';
import type { ThinkEvidence } from './publication-model.ts';
const changed = (): never => { throw new OperationError('revision_conflict', 'Think evidence changed before publication.', 'Reconcile any existing receipts; generate a new proposal from current evidence only after settling the retained plan.'); };
async function takeState(engine: BrainEngine, id: number, lock = false) {
    const [take] = await engine.executeRaw<{
        value: Record<string, unknown>;
    }>(`SELECT to_jsonb(t)-'embedding'-'embedded_at'-'updated_at' AS value FROM takes t WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [id]);
    return take?.value;
}
export async function captureThinkEvidence(ctx: OperationContext, opts: RunThinkOpts, gather: ThinkGatherResult): Promise<ThinkEvidence[]> {
    const ids = [...new Set([...gather.pages.map(p => p.page_id), ...gather.takes.map(t => t.page_id)])];
    const scope = opts.allowedSources ?? (opts.sourceId ? [opts.sourceId] : undefined);
    const rows = await ctx.engine.executeRaw<{
        id: number;
        slug: string;
        source_id: string;
        incarnation: string;
    }>(`SELECT p.id,p.slug,p.source_id,s.incarnation FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE (p.id=ANY($1::integer[]) OR p.slug=ANY($2::text[])) AND p.deleted_at IS NULL AND NOT s.archived${scope ? ' AND p.source_id=ANY($3::text[])' : ''}`, [ids, gather.graphSlugs, ...scope ? [scope] : []]);
    if (rows.length > 100 || ids.some(id => !rows.some(row => Number(row.id) === id)))
        changed();
    const evidence: ThinkEvidence[] = [];
    for (const row of rows) {
        const snapshot = await ctx.engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
        if (!snapshot || snapshot.page.id !== Number(row.id))
            changed();
        for (const page of gather.pages.filter(p => p.page_id === Number(row.id))) {
            if (page.content_hash && page.content_hash !== snapshot!.page.content_hash)
                changed();
            if (!page.content_hash && page.chunk_text && !snapshot!.page.compiled_truth.includes(page.chunk_text))
                changed();
        }
        const authority = await submissionAuthority({ ...ctx, sourceId: row.source_id }, 'think', row.source_id, row.incarnation, row.slug);
        const takes: ThinkEvidence['takes'] = [];
        for (const hit of gather.takes.filter(t => t.page_id === Number(row.id))) {
            const value = await takeState(ctx.engine, hit.take_id);
            if (!value || value.claim !== hit.claim || value.kind !== hit.kind || value.holder !== hit.holder || Number(value.weight) !== hit.weight || Number(value.row_num) !== hit.row_num)
                changed();
            takes.push({ id: hit.take_id, row: hit.row_num, hash: digest(value) });
        }
        evidence.push({ sourceId: row.source_id, incarnation: row.incarnation, slug: row.slug, id: Number(row.id), revision: snapshot!.revision, private: effectiveVisibility({ kind: 'page', page: snapshot!.page }) !== 'world' || gather.takes.some(t => t.page_id === Number(row.id) && t.holder !== 'world'), authority, takes });
    }
    return evidence;
}
export async function validateThinkEvidence(engine: BrainEngine, evidence: ThinkEvidence[]): Promise<void> {
    for (const item of evidence) {
        const [source] = await engine.executeRaw<{
            incarnation: string;
        }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived', [item.sourceId]);
        if (source?.incarnation !== item.incarnation)
            changed();
        await authorizeWrite(engine, item.authority, 'think', item.slug, true);
        const page = await engine.readPageSnapshot(item.slug, { sourceId: item.sourceId });
        if (!page || page.page.id !== item.id || page.revision !== item.revision)
            changed();
        for (const take of item.takes)
            if (digest(await takeState(engine, take.id, true)) !== take.hash)
                changed();
    }
}
