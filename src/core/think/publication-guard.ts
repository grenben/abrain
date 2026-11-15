import { readPrivateCodexConfig, privatePolicyFingerprint, requirePrivateRole, PrivateRoutingError } from '../ai/private-policy.ts';
import type { SqlEngine, WriteRequest } from '../persistence/model.ts';
import type { WriteAdmission } from '../persistence/journal.ts';
import { isWriteRequestId } from '../persistence/types.ts';
import { digest } from '../persistence/digest.ts';
import { OperationError } from '../ops/contract.ts';
import type { ThinkPublicationPlan } from './publication-model.ts';
export const thinkConflict = (): never => { throw new OperationError('idempotency_conflict', 'Think publication differs from its retained plan.', 'Reconcile the original plan and write receipts before changing inputs.'); };
export async function readThinkPlan(engine: SqlEngine, id: string, lock = false): Promise<ThinkPublicationPlan> {
    if (!isWriteRequestId(id))
        thinkConflict();
    const [plan] = await engine.executeRaw<ThinkPublicationPlan>(`SELECT * FROM codex_think_publications WHERE plan_id=$1::uuid${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!plan || plan.payload.version !== 1 || digest(plan.payload) !== plan.payload_hash)
        thinkConflict();
    return plan;
}
/** The accepted job must still own its lease at journal admission and effect commit. */
export async function validateThinkLease(engine: SqlEngine, plan: ThinkPublicationPlan, lock: boolean): Promise<void> {
    const policy = readPrivateCodexConfig();
    if (!policy || (plan.payload.policyFingerprint
        ? privatePolicyFingerprint(policy) !== plan.payload.policyFingerprint
        : 'models' in policy)) throw new PrivateRoutingError('think_publication:policy_changed');
    if (plan.payload.privateRole) requirePrivateRole(policy, plan.payload.privateRole);
    const fence = plan.payload.fence;
    if (fence) {
        const [job] = await engine.executeRaw<{
            data: unknown;
            submission_authority: unknown;
        }>(`SELECT data,submission_authority FROM minion_jobs
      WHERE id=$1 AND lock_token=$2 AND status='active' AND lock_until>now()${lock ? ' FOR SHARE' : ''}`, [fence.jobId, fence.lockToken]);
        if (!job || digest({ data: job.data, authority: job.submission_authority }) !== fence.jobDigest) {
            throw new OperationError('write_claim_lost', 'The think publication job no longer owns its lease.', 'Reconcile the retained plan and receipts; a stale worker cannot publish.');
        }
    }
    const [run] = await engine.executeRaw('SELECT run_id FROM codex_subscription_runs WHERE run_id=$1 AND deadline>now()', [plan.run_id]);
    if (!run)
        throw new OperationError('write_pending', 'The retained think allowance expired before publication.', 'Inspect and reconcile the retained write requests before authorizing further work.');
}
export async function authorizeThinkWrite(engine: SqlEngine, input: WriteAdmission, lock: boolean): Promise<void> {
    const id = input.intent.codex_think_plan;
    if (typeof id !== 'string' || input.authority.remote || !['put_page', 'takes_add'].includes(input.operation))
        thinkConflict();
    const plan = await readThinkPlan(engine, id as string);
    const index = plan.payload.actions.findIndex(action => action.admission.requestId === input.requestId);
    if (index < 0 || !plan.admitted.includes(index) || digest(plan.payload.actions[index]!.admission) !== digest(input))
        thinkConflict();
    await validateThinkLease(engine, plan, lock);
}
export async function authorizeThinkRequest(engine: SqlEngine, row: WriteRequest, lock: boolean): Promise<void> {
    if (typeof row.intent?.codex_think_plan !== 'string') {
        // Terminal compaction may discard the normalized intent. The plan still binds its request identity.
        if (!row.compacted || !['committed', 'failed', 'conflict', 'cancelled'].includes(row.state))
            thinkConflict();
        return;
    }
    const plan = await readThinkPlan(engine, row.intent!.codex_think_plan as string);
    const admission = plan.payload.actions.find(action => action.admission.requestId === row.request_id)?.admission;
    const { takeHoldersUsed: _holders, ...authority } = row.authority;
    if (!admission || admission.sourceId !== row.source_id || admission.sourceIncarnation !== row.source_incarnation ||
        admission.operation !== row.operation || admission.slug !== row.slug || admission.principal.id !== row.principal_id ||
        admission.principal.kind !== row.principal_kind || digest(admission.intent) !== digest(row.intent) || digest(admission.authority) !== digest(authority))
        thinkConflict();
    if (!['committed', 'failed', 'conflict', 'cancelled'].includes(row.state))
        await authorizeThinkWrite(engine, admission!, lock);
}
