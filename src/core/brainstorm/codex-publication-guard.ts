import type { SqlEngine, WriteRequest } from '../persistence/model.ts';
import type { WriteAdmission } from '../persistence/journal.ts';
import type { CodexSubscriptionContext } from '../ai/subscription-context.ts';
import { digest } from '../persistence/digest.ts';
import { OperationError } from '../ops/contract.ts';
import type { BrainstormSelection } from './codex-selection.ts';
export interface BrainstormPublication {
    admission: WriteAdmission;
    expectedRevision: string | null;
    fence?: CodexSubscriptionContext['publicationFence'];
}
export interface BrainstormPublicationRow {
    run_id: string;
    request_hash: string;
    selection: BrainstormSelection;
    selection_hash: string;
    result: unknown;
    result_hash: string;
    publication: BrainstormPublication;
    publication_hash: string;
    publication_admitted: boolean;
    publication_complete: boolean;
}
export const publicationConflict = (): never => { throw new OperationError('idempotency_conflict', 'Brainstorm publication differs from its retained request.', 'Inspect the retained result and write receipt before changing inputs.'); };
export async function readBrainstormPublication(engine: SqlEngine, runId: string, lock = false): Promise<BrainstormPublicationRow> {
    const [row] = await engine.executeRaw<BrainstormPublicationRow>(`SELECT * FROM codex_brainstorm_runs WHERE run_id=$1${lock ? ' FOR UPDATE' : ''}`, [runId]);
    if (!row?.publication || digest(row.publication) !== row.publication_hash || digest(row.selection) !== row.selection_hash || digest(row.result) !== row.result_hash)
        publicationConflict();
    return row!;
}
async function live(engine: SqlEngine, plan: BrainstormPublicationRow, lock: boolean) {
    const fence = plan.publication.fence;
    if (fence) {
        const [job] = await engine.executeRaw<{
            data: unknown;
            submission_authority: unknown;
        }>(`SELECT data,submission_authority FROM minion_jobs WHERE id=$1 AND lock_token=$2 AND status='active' AND lock_until>now()${lock ? ' FOR SHARE' : ''}`, [fence.jobId, fence.lockToken]);
        if (!job || digest({ data: job.data, authority: job.submission_authority }) !== fence.jobDigest)
            throw new OperationError('write_claim_lost', 'Brainstorm worker ownership was lost.', 'Reconcile the retained write receipt.');
    }
    if (!(await engine.executeRaw('SELECT run_id FROM codex_subscription_runs WHERE run_id=$1 AND deadline>now()', [plan.run_id])).length)
        throw new OperationError('write_pending', 'The brainstorm allowance expired before publication.', 'Reconcile retained requests before authorizing more work.');
}
export async function authorizeBrainstormWrite(engine: SqlEngine, input: WriteAdmission, lock: boolean): Promise<void> {
    if (typeof input.intent.codex_brainstorm_run !== 'string' || input.authority.remote || input.operation !== 'put_page')
        publicationConflict();
    const plan = await readBrainstormPublication(engine, input.intent.codex_brainstorm_run as string);
    if (!plan.publication_admitted || digest(plan.publication.admission) !== digest(input))
        publicationConflict();
    await live(engine, plan, lock);
}
export async function authorizeBrainstormRequest(engine: SqlEngine, row: WriteRequest, lock: boolean): Promise<void> {
    if (typeof row.intent?.codex_brainstorm_run !== 'string') {
        if (!row.compacted || !['committed', 'failed', 'conflict', 'cancelled'].includes(row.state))
            publicationConflict();
        return;
    }
    const plan = await readBrainstormPublication(engine, row.intent!.codex_brainstorm_run as string), a = plan.publication.admission;
    const { takeHoldersUsed: _holders, ...authority } = row.authority;
    if (a.requestId !== row.request_id || a.sourceId !== row.source_id || a.sourceIncarnation !== row.source_incarnation || a.operation !== row.operation || a.slug !== row.slug ||
        a.principal.id !== row.principal_id || a.principal.kind !== row.principal_kind || digest(a.intent) !== digest(row.intent) || digest(a.authority) !== digest(authority))
        publicationConflict();
    if (!['committed', 'failed', 'conflict', 'cancelled'].includes(row.state))
        await authorizeBrainstormWrite(engine, a, lock);
}
