import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import type { SqlEngine, WriteRequest } from '../persistence/model.ts';
import { admitWrite, admitWriteInTransaction, type WriteAdmission } from '../persistence/journal.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { OperationError } from '../ops/contract.ts';
import { digest } from '../persistence/digest.ts';
import { readPrivateCodexConfig } from '../ai/private-policy.ts';
import { readSharedOptimizer, sharedOptimizerConflict, type SharedOptimizerClaim } from './codex-optimizer-store.ts';
const publication = new AsyncLocalStorage<{ engine: BrainEngine; claim: SharedOptimizerClaim; fence(tx: BrainEngine): Promise<void> }>();
export function withSharedOptimizerPublication<T>(scope: NonNullable<ReturnType<typeof publication.getStore>>, run: () => Promise<T>): Promise<T> {
  return publication.run(scope, run);
}
/** Retain the complete canonical admission in the same transaction that journals it. */
export async function admitSharedOptimizerWrite(engine: BrainEngine, input: WriteAdmission): Promise<WriteRequest> {
  const scope = publication.getStore(); if (!scope) return admitWrite(engine, input);
  if (scope.engine !== engine || input.operation !== 'put_skill' || input.targetKind !== 'skill_bundle' || input.authority.remote) sharedOptimizerConflict();
  const admission: WriteAdmission = { ...input, protocolVersion: 6, intent: { ...input.intent, codex_shared_optimizer: scope.claim.runId } };
  return engine.transaction(async tx => {
    await declareDurablePersistence(tx);
    if (input.worktreeId) await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [input.worktreeId]);
    await scope.fence(tx);
    const row = await readSharedOptimizer(tx, scope.claim.runId);
    if (!row?.result || row.result.outcome !== 'accepted' || !row.input.mutate || row.input.target.request_id !== input.requestId ||
        row.input.target.source_id !== input.sourceId || row.input.target.source_incarnation !== input.sourceIncarnation ||
        input.slug !== `skills/${row.input.controls.skillName}/SKILL.md` || row.admission && digest(row.admission) !== digest(admission)) sharedOptimizerConflict();
    await tx.executeRaw('UPDATE codex_shared_skill_optimizations SET admission=$2::text::jsonb,admission_hash=$3 WHERE run_id=$1',
      [scope.claim.runId, JSON.stringify(admission), digest(admission)]);
    return admitWriteInTransaction(tx, admission);
  });
}
const lost = (): never => { throw new OperationError('write_claim_lost', 'Native skill publication requires its current optimizer owner.', 'Reconcile the retained optimizer plan and canonical write receipt.'); };
export async function authorizeSharedOptimizerWrite(engine: SqlEngine, input: WriteAdmission, lock: boolean): Promise<void> {
  if (input.protocolVersion !== 6 || input.targetKind !== 'skill_bundle' || input.operation !== 'put_skill' || input.authority.remote || typeof input.intent.codex_shared_optimizer !== 'string') sharedOptimizerConflict();
  const row = await readSharedOptimizer(engine, input.intent.codex_shared_optimizer as string);
  if (!row?.admission || digest(row.admission) !== digest(input)) sharedOptimizerConflict();
  const fence = row!.publication_fence;
  if (fence) {
    const [job] = await engine.executeRaw<{ data: unknown; submission_authority: unknown }>(
      `SELECT data,submission_authority FROM minion_jobs WHERE id=$1 AND lock_token=$2 AND status='active' AND lock_until>now()${lock ? ' FOR SHARE' : ''}`, [fence.jobId, fence.lockToken]);
    if (!job || digest({ data: job.data, authority: job.submission_authority }) !== fence.jobDigest) lost();
  }
  const [live] = await engine.executeRaw(`SELECT p.run_id FROM codex_shared_skill_optimizations p JOIN codex_subscription_runs r USING(run_id)
    WHERE p.run_id=$1 AND p.owner_token IS NOT NULL AND p.lease_until>now() AND r.deadline>now()${lock ? ' FOR SHARE OF p,r' : ''}`, [row!.run_id]);
  const policy = readPrivateCodexConfig();
  if (!live || !policy || policy.model !== row!.input.model || policy.bin !== row!.input.bin) lost();
}
export async function authorizeSharedOptimizerRequest(engine: SqlEngine, row: WriteRequest, lock: boolean): Promise<void> {
  if (typeof row.intent?.codex_shared_optimizer !== 'string') {
    if (!row.compacted || !['committed', 'failed', 'conflict', 'cancelled'].includes(row.state)) sharedOptimizerConflict();
    return;
  }
  const plan = await readSharedOptimizer(engine, row.intent.codex_shared_optimizer as string), a = plan?.admission;
  if (!a || a.requestId !== row.request_id || a.sourceId !== row.source_id || a.sourceIncarnation !== row.source_incarnation ||
      a.operation !== row.operation || a.slug !== row.slug || a.principal.id !== row.principal_id || a.principal.kind !== row.principal_kind ||
      digest(a.intent) !== digest(row.intent) || digest(a.authority) !== digest(row.authority)) sharedOptimizerConflict();
  if (!['committed', 'failed', 'conflict', 'cancelled'].includes(row.state)) await authorizeSharedOptimizerWrite(engine, a!, lock);
}
