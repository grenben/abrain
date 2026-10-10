import { brainstormRunIdentity } from './codex-fixture.ts';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { preparePageAdmission } from '../persistence/page-mutations.ts';
import { preflightThinkAction } from '../think/publication-preflight.ts';
import { serializeMarkdown } from '../markdown.ts';
import { digest } from '../persistence/digest.ts';
import { admitWriteInTransaction, assertReplayIntent, intentDigest } from '../persistence/journal.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { submissionAuthority, authorizeStoredRequest } from '../persistence/authority.ts';
import { waitForWrite } from '../persistence/service.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { loadConfig } from '../config.ts';
import { claimBrainstormRun, fenceBrainstormRun, releaseBrainstormRun } from './codex-store.ts';
import { readBrainstormPublication, publicationConflict, type BrainstormPublication } from './codex-publication-guard.ts';
import { validateBrainstormSelection, type BrainstormSelection } from './codex-selection.ts';
import { formatBrainstormMarkdown, buildBrainstormFrontmatterObject, type BrainstormResult } from './orchestrator.ts';
import type { WriteRequest } from '../persistence/model.ts';
export async function prepareBrainstormPublication(ctx: OperationContext, result: BrainstormResult, selection: BrainstormSelection): Promise<BrainstormPublication | null> {
    if (!result.idea_slug || !result.ideas.length)
        return null;
    const host = codexSubscriptionContext()!;
    if(brainstormRunIdentity(host.runId)!==host.runId)publicationConflict();
    const hex = digest(['codex-brainstorm-write-v1', host.runId]), requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    const content = serializeMarkdown({ ...buildBrainstormFrontmatterObject(result), visibility: [...selection.close, ...selection.far].some(p => p.private) ? 'private' : 'world',
        provenance: 'codex-brainstorm', subscription_run: host.runId }, formatBrainstormMarkdown(result, { onlyPassed: false, includeMeta: true }), '', { type: 'note', title: `${result.profile_label}: ${result.question.slice(0, 100)}`, tags: [] });
    const prepared = await preparePageAdmission(ctx, { operation: 'put_page', params: { slug: result.idea_slug, source_id: ctx.sourceId ?? 'default', content, request_id: requestId } });
    if (prepared.prior || !prepared.admission || prepared.admission.pageId !== null)
        publicationConflict();
    const admission = { ...prepared.admission!, protocolVersion: 5 as const, intent: { ...prepared.admission!.intent, codex_brainstorm_run: host.runId } };
    await preflightThinkAction(ctx, admission);
    return { admission, expectedRevision: null, ...host.publicationFence ? { fence: host.publicationFence } : {} };
}
const uncertain = (): never => { throw new OperationError('write_pending', 'Brainstorm publication requires reconciliation.', 'Inspect the retained write receipt; do not regenerate or blindly replay effects.'); };
/** Resume the original prepared request. Never reconstruct a write from model output. */
export async function publishBrainstormResult(engine: BrainEngine, result: BrainstormResult): Promise<{
    slug: string;
    request_id: string;
}> {
    const host = codexSubscriptionContext(), reference = result.codex_run;
    if (!host || !reference || host.runId !== reference.run_id || engine !== host.engine)
        publicationConflict();
    const plan = await readBrainstormPublication(engine, reference!.run_id);
    if (plan.request_hash !== reference!.request_hash || digest(result) !== plan.result_hash)
        publicationConflict();
    const a = plan.publication.admission, ctx: OperationContext = { engine, config: loadConfig() ?? { engine: engine.kind }, remote: false, sourceId: a.sourceId, dryRun: false, logger: { info() { }, warn() { }, error() { } } };
    await submissionAuthority(ctx, a.operation, a.sourceId, a.sourceIncarnation, a.slug);
    const claim = await claimBrainstormRun(host!, reference!.request_hash);
    const receipts = () => engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [a.requestId]);
    try {
        let found = await receipts();
        if (found.length > 1)
            uncertain();
        if (!found.length) {
            await engine.transaction(tx => validateBrainstormSelection(tx, plan.selection));
            await engine.transaction(async (tx) => {
                await declareDurablePersistence(tx);
                if (a.worktreeId)
                    await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [a.worktreeId]);
                await fenceBrainstormRun(tx, host!, claim);
                const current = await readBrainstormPublication(tx, host!.runId, true);
                if (current.publication_admitted)
                    uncertain();
                await tx.executeRaw('UPDATE codex_brainstorm_runs SET publication_admitted=true WHERE run_id=$1', [host!.runId]);
                await admitWriteInTransaction(tx, a);
            });
        }
        found = await receipts();
        if (found.length !== 1)
            uncertain();
        assertReplayIntent(found[0]!, intentDigest(a));
        await authorizeStoredRequest(engine, found[0]!);
        const settled = await waitForWrite(engine, found[0]!, ctx.config);
        if (settled.state !== 'committed')
            uncertain();
        await engine.transaction(async (tx) => { await fenceBrainstormRun(tx, host!, claim); await tx.executeRaw('UPDATE codex_brainstorm_runs SET publication_complete=true WHERE run_id=$1', [host!.runId]); });
        await releaseBrainstormRun(host!, claim, true);
        return { slug: a.slug, request_id: a.requestId! };
    }
    catch (error) {
        await releaseBrainstormRun(host!, claim, false);
        throw error;
    }
}
