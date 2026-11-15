import type { BrainEngine } from '../engine.ts';
import type { CodexSubscriptionContext } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { digest, jsonBytes } from '../persistence/digest.ts';
import { OperationError } from '../ops/contract.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../minions/subscription-jobs.ts';
import { ensureLocalOptimizerGrant } from './codex-local-grant.ts';
import { readOptimizerBatch } from './codex-batch-store.ts';
import type { CodexCycleConfig } from './codex-cycle-config.ts';
export interface OptimizerCycle {
  run_id: string; protocol: number; source_id: string; source_incarnation: string;
  binding: { config: CodexCycleConfig; models: unknown }; input_hash: string;
  selection: string[]; selection_hash: string; state: 'pending' | 'complete' | 'failed'; result_hash: string | null;
}
const conflict = (): never => { throw new SubscriptionAdmissionError('subscription_identity_conflict'); };
export async function readOptimizerCycle(tx: BrainEngine, runId: string): Promise<OptimizerCycle | undefined> {
  const [row] = await tx.executeRaw<OptimizerCycle>('SELECT * FROM codex_skillopt_cycles WHERE run_id=$1', [runId]);
  if (row && (row.protocol !== 1 || digest(row.binding) !== row.input_hash || digest(row.selection) !== row.selection_hash)) conflict();
  return row;
}
/** Lock order matches batch and optimizer publication: brain, host, root, source. */
export async function fenceOptimizerCycle(tx: BrainEngine, host: CodexSubscriptionContext, row: OptimizerCycle, requireExisting = true): Promise<void> {
  await declareDurablePersistence(tx); host.signal?.throwIfAborted(); await host.checkAuthorityInTransaction?.(tx);
  await tx.executeRaw('SELECT gbrain_codex_subscription_lock_path($1)', [host.runId]);
  const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived FOR UPDATE', [row.source_id]);
  if (source?.incarnation !== row.source_incarnation) conflict();
  const current = await readOptimizerCycle(tx, host.runId);
  if (requireExisting && !current || current?.state === 'failed') conflict();
  if (current && (current.input_hash !== row.input_hash || current.selection_hash !== row.selection_hash || current.source_incarnation !== row.source_incarnation)) conflict();
}
export async function acceptOptimizerCycle(host: CodexSubscriptionContext, candidate: OptimizerCycle, names: string[]): Promise<OptimizerCycle> {
  if (jsonBytes(candidate.binding) > 65536) conflict();
  await host.checkAuthority?.(); host.signal?.throwIfAborted();
  return host.engine.transaction(async tx => {
    // Before selection exists, compare the stable binding rather than its as-yet unknown selection.
    const prior = await readOptimizerCycle(tx, host.runId);
    if (prior && (prior.input_hash !== candidate.input_hash || prior.source_incarnation !== candidate.source_incarnation)) conflict();
    await fenceOptimizerCycle(tx, host, prior ?? candidate, false);
    await ensureLocalOptimizerGrant(tx, host.runId, 'batch');
    const [grant] = await tx.executeRaw<{ parent_run_id: string | null; account_lane: string }>('SELECT parent_run_id,account_lane FROM codex_subscription_runs WHERE run_id=$1', [host.runId]);
    if (!grant || grant.parent_run_id || grant.account_lane !== CODEX_JOB_ACCOUNT_LANE) throw new SubscriptionAdmissionError('subscription_required');
    const current = await readOptimizerCycle(tx, host.runId);
    if (current) {
      if (current.input_hash !== candidate.input_hash || current.source_incarnation !== candidate.source_incarnation) conflict();
      if (current.state === 'failed') throw new OperationError('write_pending', 'This optimizer cycle failed before creating a batch.', 'After the error cooldown, authorize a new cycle request.');
      return current;
    }
    const incompatible = await tx.executeRaw('SELECT run_id FROM codex_skillopt_batches WHERE run_id=$1 UNION SELECT run_id FROM codex_skillopt_runs WHERE run_id=$1 UNION SELECT run_id FROM codex_skillopt_bootstraps WHERE run_id=$1 UNION SELECT run_id FROM codex_shared_skill_optimizations WHERE run_id=$1', [host.runId]);
    if (incompatible.length) conflict();
    const pending = await tx.executeRaw("SELECT run_id FROM codex_skillopt_cycles WHERE source_id=$1 AND source_incarnation=$2::uuid AND state='pending'", [candidate.source_id, candidate.source_incarnation]);
    if (pending.length) throw new OperationError('write_pending', 'Scheduled skill optimization has an unsettled batch.', 'Reconcile the retained cycle using its original subscription request before admitting another cycle.');
    const recent = await tx.executeRaw<{ selection: string[] }>(`SELECT selection FROM codex_skillopt_cycles
      WHERE source_id=$1 AND source_incarnation=$2::uuid AND ((state='complete' AND settled_at>now()-($3::double precision*interval '1 day'))
        OR (state='failed' AND settled_at>now()-interval '24 hours'))`, [candidate.source_id, candidate.source_incarnation, candidate.binding.config.staleDays]);
    const cooling = new Set(recent.flatMap(r => r.selection));
    const selection = names.filter(n => !cooling.has(n)).slice(0, candidate.binding.config.maxSkillsPerCycle);
    const row = { ...candidate, selection, selection_hash: digest(selection) };
    await tx.executeRaw(`INSERT INTO codex_skillopt_cycles(run_id,protocol,source_id,source_incarnation,binding,input_hash,selection,selection_hash,state)
      VALUES($1,1,$2,$3::uuid,$4::text::jsonb,$5,$6::text::jsonb,$7,'pending')`,
      [host.runId, row.source_id, row.source_incarnation, JSON.stringify(row.binding), row.input_hash, JSON.stringify(selection), row.selection_hash]);
    return row;
  });
}
/** Only a complete batch with the exact frozen membership can earn a cooldown. */
export async function finishOptimizerCycle(host: CodexSubscriptionContext, row: OptimizerCycle): Promise<void> {
  await host.engine.transaction(async tx => {
    await fenceOptimizerCycle(tx, host, row);
    const batch = await readOptimizerBatch(tx, host.runId) ?? conflict();
    if (!batch?.result || batch.state !== 'complete' || digest(batch.input.entries.map(e => e.skill)) !== row.selection_hash ||
        batch.input.scope.sourceId !== row.source_id || batch.input.entries.some(e => e.input.sourceIncarnation !== row.source_incarnation)) conflict();
    const updated = await tx.executeRaw("UPDATE codex_skillopt_cycles SET state='complete',result_hash=$2,settled_at=COALESCE(settled_at,now()) WHERE run_id=$1 AND state<>'failed' RETURNING run_id", [host.runId, batch.result_hash]);
    if (updated.length !== 1) conflict();
  });
}
/** No batch means no optimizer effects. After a batch exists, retain pending for reconciliation. */
export async function failUnstartedOptimizerCycle(host: CodexSubscriptionContext, row: OptimizerCycle): Promise<void> {
  await host.engine.transaction(async tx => {
    await fenceOptimizerCycle(tx, host, row);
    await tx.executeRaw(`UPDATE codex_skillopt_cycles SET state='failed',settled_at=now() WHERE run_id=$1 AND state='pending'
      AND NOT EXISTS(SELECT 1 FROM codex_skillopt_batches WHERE run_id=$1)`, [host.runId]);
  });
}
