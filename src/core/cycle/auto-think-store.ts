import type { BrainEngine } from '../engine.ts';
import type { ThinkResult } from '../think/index.ts';
import type { WriteAuthority } from '../persistence/model.ts';
import type { CodexSubscriptionContext } from '../ai/subscription-context.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { OperationError } from '../ops/contract.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { digest, jsonBytes } from '../persistence/digest.ts';
export interface AutoThinkBinding {
    authority: WriteAuthority;
    questions: string[];
    autoCommit: boolean;
    fence?: CodexSubscriptionContext['publicationFence'];
}
export interface AutoThinkEntry {
    state: 'accepted' | 'complete';
    result: ThinkResult;
    slug?: string;
}
export interface AutoThinkRun {
    run_id: string;
    source_id: string;
    source_incarnation: string;
    input_hash: string;
    binding: AutoThinkBinding;
    results: Record<string, AutoThinkEntry>;
    state: 'accepted' | 'complete';
}
export const autoThinkConflict = (): never => { throw new OperationError('idempotency_conflict', 'Automatic think differs from its retained batch.', 'Reconcile the original batch and receipts before changing its inputs.'); };
export async function recheckAutoThink(tx: BrainEngine, run: AutoThinkRun): Promise<void> {
    await declareDurablePersistence(tx);
    const fence = run.binding.fence;
    if (fence) {
        const [job] = await tx.executeRaw<{
            data: unknown;
            submission_authority: unknown;
        }>("SELECT data,submission_authority FROM minion_jobs WHERE id=$1 AND lock_token=$2 AND status='active' AND lock_until>now() FOR SHARE", [fence.jobId, fence.lockToken]);
        if (!job || digest({ data: job.data, authority: job.submission_authority }) !== fence.jobDigest)
            throw new OperationError('write_claim_lost', 'Automatic think no longer owns its job lease.', 'Reconcile the retained batch before authorizing further work.');
    }
    await codexSubscriptionContext()?.checkAuthorityInTransaction?.(tx);
    codexSubscriptionContext()?.signal?.throwIfAborted();
    const [source] = await tx.executeRaw<{
        incarnation: string;
    }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived FOR SHARE', [run.source_id]);
    if (source?.incarnation !== run.source_incarnation)
        autoThinkConflict();
    await authorizeWrite(tx, run.binding.authority, 'submit_job', '', true);
}
/** The accepted answer is retained before publication; failure never becomes a completed question. */
export async function storeAutoThinkEntry(engine: BrainEngine, run: AutoThinkRun, index: number, entry: AutoThinkEntry): Promise<void> {
    if (jsonBytes(entry) > 524288 || index < 0 || index >= run.binding.questions.length || entry.result.synthesisOk !== true)
        autoThinkConflict();
    await engine.transaction(async (tx) => {
        await recheckAutoThink(tx, run);
        const [current] = await tx.executeRaw<AutoThinkRun>('SELECT * FROM codex_auto_think_runs WHERE run_id=$1 AND source_id=$2 FOR UPDATE', [run.run_id, run.source_id]);
        if (!current || current.input_hash !== run.input_hash)
            autoThinkConflict();
        const prior = current!.results[String(index)];
        if (prior && digest(prior.result) !== digest(entry.result))
            autoThinkConflict();
        if (prior?.state === 'complete')
            return;
        if (entry.state === 'complete' && run.binding.autoCommit) {
            const ref = entry.result.codex_publication;
            const [plan] = ref ? await tx.executeRaw<{
                state: string;
                payload_hash: string;
            }>('SELECT state,payload_hash FROM codex_think_publications WHERE plan_id=$1::uuid', [ref.plan_id]) : [];
            if (!plan || plan.state !== 'complete' || plan.payload_hash !== ref!.payload_hash || !entry.slug)
                autoThinkConflict();
        }
        await tx.executeRaw('UPDATE codex_auto_think_runs SET results=jsonb_set(results,ARRAY[$3::text],$4::text::jsonb) WHERE run_id=$1 AND source_id=$2', [run.run_id, run.source_id, String(index), JSON.stringify(entry)]);
    });
}
export async function finishAutoThink(engine: BrainEngine, run: AutoThinkRun): Promise<boolean> {
    return engine.transaction(async (tx) => {
        await recheckAutoThink(tx, run);
        const [current] = await tx.executeRaw<AutoThinkRun>('SELECT * FROM codex_auto_think_runs WHERE run_id=$1 AND source_id=$2 FOR UPDATE', [run.run_id, run.source_id]);
        if (!current || current.input_hash !== run.input_hash)
            autoThinkConflict();
        if (current!.binding.questions.some((_, i) => current!.results[String(i)]?.state !== 'complete'))
            return false;
        await tx.executeRaw("UPDATE codex_auto_think_runs SET state='complete',completed_at=COALESCE(completed_at,now()) WHERE run_id=$1 AND source_id=$2", [run.run_id, run.source_id]);
        // Compatibility timestamp is informational; private cooldown is source scoped in the retained table.
        if (run.source_id === 'default')
            await tx.setConfig('dream.auto_think.last_completion_ts', new Date().toISOString());
        return true;
    });
}
