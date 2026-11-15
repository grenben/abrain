import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { digest } from '../persistence/digest.ts';
import { readPrivateCodexConfig } from '../ai/private-policy.ts';
import { jobUpgradeSnapshot, lockJobUpgrade, upgradeError, upgradeHash, upgradeIdentity } from './codex-upgrade-snapshot.ts';

interface ParkReceipt { id: string; state: 'applied' | 'rolled_back'; plan: Awaited<ReturnType<typeof jobUpgradeSnapshot>>['plan']; receipt: { parked_hash: string; restored_hash?: string } }
/** All graph rows must be settled or explicitly selected. Nothing active is cancelled. */
export async function parkUpgradeJobs(engine: BrainEngine, ids: number[], expected: string): Promise<ParkReceipt> {
  upgradeHash(expected);
  return engine.transaction(async tx => {
    await lockJobUpgrade(tx);
    const [prior] = await tx.executeRaw<ParkReceipt>("SELECT id,state,plan,receipt FROM codex_upgrade_receipts WHERE kind='jobs' AND plan_hash=$1 AND plan->>'operation'='park' ORDER BY sequence DESC LIMIT 1", [expected]);
    if (prior) {
      if (digest([...new Set(ids)].sort((a,b)=>a-b)) !== digest(prior.plan.ids)) upgradeError('selection_changed');
      const current = await jobUpgradeSnapshot(tx, prior.plan.ids);
      if (prior.state !== 'applied' || current.plan.brain_id !== prior.plan.brain_id || digest(current.rows) !== prior.receipt.parked_hash ||
          current.plan.parked.length !== prior.plan.ids.length || current.plan.parked.some(p => p.receipt_id !== prior.id)) upgradeError('receipt_changed');
      return prior;
    }
    const { plan } = await jobUpgradeSnapshot(tx, ids);
    if (plan.plan_hash !== expected) upgradeError('preview_changed');
    if (!plan.ready) upgradeError('drain_or_select_dependencies');
    const id = randomUUID();
    await tx.executeRaw("INSERT INTO codex_upgrade_receipts(id,kind,plan_hash,plan,state,receipt) VALUES($1::uuid,'jobs',$2,$3::text::jsonb,'applied','{}'::jsonb)", [id,expected,JSON.stringify(plan)]);
    // Set status before installing the durable fence, within the same transaction.
    await tx.executeRaw("UPDATE minion_jobs SET status='paused',lock_token=NULL,lock_until=NULL,updated_at=now() WHERE id=ANY($1::int[])", [plan.ids]);
    for (const job of plan.jobs) await tx.executeRaw('INSERT INTO codex_parked_jobs(job_id,receipt_id,previous_status) VALUES($1,$2::uuid,$3)', [job.id,id,job.status]);
    const { rows } = await jobUpgradeSnapshot(tx, plan.ids), receipt = { parked_hash: digest(rows) };
    await tx.executeRaw('UPDATE codex_upgrade_receipts SET receipt=$2::text::jsonb WHERE id=$1::uuid', [id,JSON.stringify(receipt)]);
    return { id, state: 'applied', plan, receipt };
  });
}
/** Binary/config rollback is separate. Never release legacy work while strict mode is active. */
export async function restoreParkedJobs(engine: BrainEngine, id: string, expected: string): Promise<ParkReceipt> {
  upgradeHash(expected); if (!/^[a-f0-9-]{36}$/.test(id)) upgradeError('invalid_receipt');
  if (readPrivateCodexConfig()) upgradeError('private_mode_active');
  return engine.transaction(async tx => {
    await lockJobUpgrade(tx);
    const [r] = await tx.executeRaw<ParkReceipt>("SELECT id,state,plan,receipt FROM codex_upgrade_receipts WHERE id=$1::uuid AND kind='jobs' AND plan->>'operation'='park' FOR UPDATE", [id]);
    if (!r || r.plan.plan_hash !== expected || r.plan.brain_id !== await upgradeIdentity(tx)) return upgradeError('receipt_changed');
    const current = await jobUpgradeSnapshot(tx, r.plan.ids);
    if (digest(current.rows) !== (r.state === 'applied' ? r.receipt.parked_hash : r.receipt.restored_hash)) upgradeError('configuration_changed');
    if (r.state === 'rolled_back') return r;
    if (current.plan.parked.length !== r.plan.ids.length || current.plan.parked.some(p => p.receipt_id !== id || p.replacement_job_id !== null)) upgradeError('replacement_or_fence_changed');
    if (current.plan.source_hash !== r.plan.source_hash || digest(current.plan.dependencies) !== digest(r.plan.dependencies)) upgradeError('source_or_dependencies_changed');
    await tx.executeRaw('DELETE FROM codex_parked_jobs WHERE receipt_id=$1::uuid', [id]);
    for (const job of r.plan.jobs) await tx.executeRaw('UPDATE minion_jobs SET status=$2,updated_at=now() WHERE id=$1', [job.id,job.status]);
    const restored = await jobUpgradeSnapshot(tx, r.plan.ids), receipt = { ...r.receipt, restored_hash: digest(restored.rows) };
    await tx.executeRaw("UPDATE codex_upgrade_receipts SET state='rolled_back',receipt=$2::text::jsonb,updated_at=now() WHERE id=$1::uuid", [id,JSON.stringify(receipt)]);
    return { ...r, state: 'rolled_back', receipt };
  });
}
