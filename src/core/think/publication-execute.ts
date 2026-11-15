import type { BrainEngine } from '../engine.ts';
import type { ThinkResult } from './index.ts';
import { OperationError } from '../ops/contract.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { digest } from '../persistence/digest.ts';
import { admitWriteInTransaction, assertReplayIntent, intentDigest } from '../persistence/journal.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { submissionAuthority, authorizeStoredRequest } from '../persistence/authority.ts';
import { waitForWrite, writeResponse } from '../persistence/service.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { thinkPublicationContext } from './publication.ts';
import { readThinkPlan, thinkConflict, validateThinkLease } from './publication-guard.ts';
import type { ThinkPublicationPlan } from './publication-model.ts';
const uncertain = (): never => { throw new OperationError('write_pending', 'Think publication needs receipt reconciliation.', 'Inspect the retained plan and write requests; do not regenerate or blindly replay uncertain effects.'); };
async function receipts(engine: BrainEngine, plan: ThinkPublicationPlan, index: number): Promise<WriteRequest[]> {
    return engine.executeRaw('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [plan.payload.actions[index]!.admission.requestId]);
}
async function publish(engine: BrainEngine, result: ThinkResult, kind: 'page' | 'take', sourceId?: string, anchor?: string) {
    if (!result.codex_publication)
        throw new OperationError('invalid_params', 'The private think result has no retained publication plan.', 'Run private think with the intended save/take flags and reuse its retained result.');
    const plan = await readThinkPlan(engine, result.codex_publication.plan_id);
    const { codex_publication: _reference, warnings: _warnings, ...plain } = result;
    const { warnings: _originalWarnings, ...original } = plan.payload.result;
    if (plan.payload_hash !== result.codex_publication.payload_hash || digest(plain) !== digest(original) || (sourceId ?? 'default') !== plan.source_id)
        thinkConflict();
    const ctx = thinkPublicationContext(engine, { question: result.question, remote: false, sourceId: plan.source_id });
    const index = plan.payload.actions.findIndex(a => a.kind === kind);
    if (index < 0)
        thinkConflict();
    if (kind === 'take' && plan.payload.actions[index]!.admission.slug !== anchor)
        thinkConflict();
    let response: Record<string, unknown> = {};
    // Save precedes take when both were requested, so the take cannot invalidate its own pending page evidence.
    for (let ordinal = 0; ordinal <= index; ordinal++) {
        const action = plan.payload.actions[ordinal]!, a = action.admission;
        await submissionAuthority(ctx, a.operation, a.sourceId, a.sourceIncarnation, a.slug);
        let found = await receipts(engine, plan, ordinal);
        if (found.length > 1)
            uncertain();
        if (!found.length) {
            await engine.transaction(async (tx) => {
                await declareDurablePersistence(tx);
                if (a.worktreeId)
                    await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [a.worktreeId]);
                await validateThinkLease(tx, plan, true);
                await codexSubscriptionContext()?.checkAuthorityInTransaction?.(tx);
                codexSubscriptionContext()?.signal?.throwIfAborted();
                const current = await readThinkPlan(tx, plan.plan_id, true);
                if (current.admitted.includes(ordinal)) {
                    if (!(await receipts(tx, plan, ordinal)).length)
                        uncertain();
                    return;
                }
                await tx.executeRaw('UPDATE codex_think_publications SET admitted=array_append(admitted,$2::integer) WHERE plan_id=$1::uuid', [plan.plan_id, ordinal]);
                await admitWriteInTransaction(tx, a);
            });
            found = await receipts(engine, plan, ordinal);
        }
        if (found.length !== 1)
            uncertain();
        assertReplayIntent(found[0]!, intentDigest(a));
        await authorizeStoredRequest(engine, found[0]!);
        const settled = await waitForWrite(engine, found[0]!, ctx.config);
        response = writeResponse(settled);
        if (settled.state !== 'committed')
            uncertain();
    }
    await engine.transaction(async (tx) => {
        await declareDurablePersistence(tx);
        const current = await readThinkPlan(tx, plan.plan_id, true);
        for (let ordinal = 0; ordinal < current.payload.actions.length; ordinal++) {
            const found = await receipts(tx, current, ordinal);
            if (found.length !== 1 || found[0]!.state !== 'committed')
                return;
            assertReplayIntent(found[0]!, intentDigest(current.payload.actions[ordinal]!.admission));
        }
        await tx.executeRaw("UPDATE codex_think_publications SET state='complete',completed_at=COALESCE(completed_at,now()) WHERE plan_id=$1::uuid", [plan.plan_id]);
    });
    return { response, slug: plan.payload.actions[index]!.admission.slug };
}
export async function publishThinkPage(engine: BrainEngine, result: ThinkResult, scope: {
    sourceId?: string;
    allowedSources?: string[];
}) {
    if (result.synthesisOk === false)
        return { slug: '', evidenceInserted: 0, warnings: ['SYNTHESIS_EMPTY_NOT_PERSISTED'] };
    const saved = await publish(engine, result, 'page', scope.sourceId);
    return { slug: saved.slug, evidenceInserted: Number(saved.response.evidence_inserted ?? 0), warnings: [] as string[] };
}
export async function publishThinkTake(engine: BrainEngine, result: ThinkResult, opts: {
    anchor: string;
    sourceId?: string;
}) {
    if (result.synthesisOk === false)
        return { take_row: null, warnings: ['TAKE_SKIPPED_SYNTHESIS_FAILED'] };
    const saved = await publish(engine, result, 'take', opts.sourceId, opts.anchor);
    const row = Number(saved.response.row_num);
    if (!Number.isSafeInteger(row) || row < 1)
        uncertain();
    return { take_row: row, warnings: [] as string[] };
}
