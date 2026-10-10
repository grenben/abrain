import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { CodexSubscriptionContext } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { digest, jsonBytes } from '../persistence/digest.ts';
import type { BrainstormResult } from './orchestrator.ts';
import type { BrainstormSelection } from './codex-selection.ts';
import { ensureLocalBrainstormGrant, reportBrainstormAllowance } from './codex-local-grant.ts';
export interface BrainstormClaim {
    runId: string;
    requestHash: string;
    token: string;
}
export interface BrainstormRun {
    run_id: string;
    protocol: number;
    request_hash: string;
    selection: BrainstormSelection | null;
    selection_hash: string | null;
    result: BrainstormResult | null;
    result_hash: string | null;
    created_at: string | Date;
}
export const brainstormConflict = (): never => { throw new SubscriptionAdmissionError('subscription_identity_conflict'); };
const lost = () => new SubscriptionAdmissionError('subscription_owner_lost');
export async function readBrainstormRun(engine: BrainEngine, runId: string): Promise<BrainstormRun> {
    const [row] = await engine.executeRaw<BrainstormRun>('SELECT * FROM codex_brainstorm_runs WHERE run_id=$1', [runId]);
    if (!row || row.protocol !== 1 || row.selection && digest(row.selection) !== row.selection_hash || row.result && digest(row.result) !== row.result_hash)
        brainstormConflict();
    return row!;
}
export async function claimBrainstormRun(host: CodexSubscriptionContext, requestHash: string): Promise<BrainstormClaim> {
    if (!/^[a-f0-9]{64}$/.test(requestHash))
        brainstormConflict();
    await host.checkAuthority?.();
    host.signal?.throwIfAborted();
    const claim = { runId: host.runId, requestHash, token: randomUUID() };
    await host.engine.transaction(async (tx) => {
        await ensureLocalBrainstormGrant(tx, host.runId);
        await declareDurablePersistence(tx);
        await host.checkAuthorityInTransaction?.(tx);
        if (!(await tx.executeRaw('SELECT run_id FROM codex_subscription_runs WHERE run_id=$1 FOR UPDATE', [host.runId])).length)
            throw new SubscriptionAdmissionError('subscription_required');
        await tx.executeRaw("INSERT INTO codex_brainstorm_runs(run_id,protocol,request_hash,state) VALUES($1,1,$2,'idle') ON CONFLICT DO NOTHING", [host.runId, requestHash]);
        const [row] = await tx.executeRaw<{
            request_hash: string;
            busy: boolean;
        }>("SELECT request_hash,owner_token IS NOT NULL AND lease_until>now() AS busy FROM codex_brainstorm_runs WHERE run_id=$1 FOR UPDATE", [host.runId]);
        if (row?.request_hash !== requestHash)
            brainstormConflict();
        if (row!.busy)
            throw lost();
        if ((await tx.executeRaw("SELECT attempt_id FROM codex_subscription_attempts WHERE run_id=$1 AND state IN ('active','unresolved')", [host.runId])).length)
            throw new SubscriptionAdmissionError('subscription_lane_busy');
        await tx.executeRaw("UPDATE codex_brainstorm_runs SET owner_token=$2::uuid,lease_until=now()+interval '15 minutes',state='running' WHERE run_id=$1", [host.runId, claim.token]);
        await readBrainstormRun(tx, host.runId);
    });
    reportBrainstormAllowance();
    return claim;
}
export async function fenceBrainstormRun(tx: BrainEngine, host: CodexSubscriptionContext, claim: BrainstormClaim): Promise<void> {
    await declareDurablePersistence(tx);
    await host.checkAuthorityInTransaction?.(tx);
    host.signal?.throwIfAborted();
    const rows = await tx.executeRaw("UPDATE codex_brainstorm_runs SET lease_until=now()+interval '15 minutes' WHERE run_id=$1 AND request_hash=$2 AND owner_token=$3::uuid AND lease_until>now() AND state='running' RETURNING run_id", [claim.runId, claim.requestHash, claim.token]);
    if (rows.length !== 1)
        throw lost();
}
export async function retainBrainstormStage(tx: BrainEngine, host: CodexSubscriptionContext, claim: BrainstormClaim, kind: 'selection' | 'result', value: BrainstormSelection | BrainstormResult): Promise<void> {
    await fenceBrainstormRun(tx, host, claim);
    if (jsonBytes(value) > 2097152)
        brainstormConflict();
    const row = await readBrainstormRun(tx, claim.runId), previous = kind === 'selection' ? row.selection : row.result;
    if (previous) {
        if (digest(previous) !== digest(value))
            brainstormConflict();
        return;
    }
    if (kind === 'selection')
        await tx.executeRaw('UPDATE codex_brainstorm_runs SET selection=$2::text::jsonb,selection_hash=$3 WHERE run_id=$1', [claim.runId, JSON.stringify(value), digest(value)]);
    else
        await tx.executeRaw('UPDATE codex_brainstorm_runs SET result=$2::text::jsonb,result_hash=$3 WHERE run_id=$1', [claim.runId, JSON.stringify(value), digest(value)]);
}
export async function releaseBrainstormRun(host: CodexSubscriptionContext, claim: BrainstormClaim, success: boolean): Promise<void> {
    await host.engine.transaction(async (tx) => {
        await declareDurablePersistence(tx);
        if (success)
            await fenceBrainstormRun(tx, host, claim);
        const [row] = await tx.executeRaw<{
            current: boolean;
            result_hash: string | null;
        }>('SELECT owner_token=$2::uuid AS current,result_hash FROM codex_brainstorm_runs WHERE run_id=$1 FOR UPDATE', [claim.runId, claim.token]);
        if (!row?.current)
            throw lost();
        const pending = (await tx.executeRaw("SELECT attempt_id FROM codex_subscription_attempts WHERE run_id=$1 AND state IN ('active','unresolved')", [claim.runId])).length;
        if (success && (!row.result_hash || pending))
            brainstormConflict();
        await tx.executeRaw('UPDATE codex_brainstorm_runs SET owner_token=NULL,lease_until=NULL,state=$2 WHERE run_id=$1', [claim.runId, pending ? 'needs_reconciliation' : success ? 'complete' : 'idle']);
    });
}
