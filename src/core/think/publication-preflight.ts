import type { OperationContext } from '../ops/contract.ts';
import type { WriteAdmission } from '../persistence/journal.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { preparePageMutation } from '../persistence/page-prepare.ts';
import { prepareTakesMutation } from '../persistence/takes-prepare.ts';
import { intentDigest } from '../persistence/journal.ts';
/** Read-only preparation catches content, fence and file refusals across the
 * entire proposal before retaining it. Publication prepares again under the
 * canonical coordinator; this preflight does not promise batch atomicity. */
export async function preflightThinkAction(ctx: OperationContext, admission: WriteAdmission): Promise<void> {
    const stamp = new Date().toISOString();
    const row: WriteRequest = {
        id: admission.requestId!, request_id: admission.requestId!,
        principal_kind: admission.principal.kind, principal_id: admission.principal.id,
        operation: admission.operation, target_kind: 'page', protocol_version: 4,
        source_id: admission.sourceId, source_incarnation: admission.sourceIncarnation,
        page_id: admission.pageId ?? null, slug: admission.slug,
        worktree_id: admission.worktreeId ?? null, topology_generation: admission.topologyGeneration ?? null,
        digest: intentDigest(admission), intent: admission.intent, authority: admission.authority,
        sequence: 0, state: 'queued', execution_token: null, claim_expires_at: null,
        recovery: null, recovery_bytes: 0, intent_bytes: 0, terminal_reservation: 0,
        outcome: null, error_code: null, error_message: null, blocked_reason: null,
        compacted: false, publication_started: false, created_at: stamp, updated_at: stamp, completed_at: null,
    };
    if (row.operation === 'takes_add')
        await prepareTakesMutation(ctx.engine, row, ctx.config);
    else
        await preparePageMutation(ctx.engine, row, ctx.config, undefined, undefined, { coordinated: true });
}
