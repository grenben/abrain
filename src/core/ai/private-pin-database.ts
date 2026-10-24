import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { digest } from '../persistence/digest.ts';
import { DB_GENERATIVE_PINS, makePinPlan, pinError, validatePinPlan, type PinPlan, type PinTarget } from './private-pin-plan.ts';

interface Receipt { id: string; plan: PinPlan; state: 'applied' | 'rolled_back'; receipt: { changed: number } }
async function rows(engine: BrainEngine) {
  const values = await engine.executeRaw<{ key: string; value: string }>('SELECT key,value FROM config WHERE key=ANY($1::text[]) ORDER BY key', [DB_GENERATIVE_PINS]);
  return Object.fromEntries(values.map(r => [r.key, r.value]));
}
async function identity(engine: BrainEngine): Promise<string> {
  const [row] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id::text FROM persistence_brain WHERE singleton=1');
  if (!row?.brain_id) return pinError('brain_identity_unavailable');
  return row.brain_id;
}
export async function previewDatabasePins(engine: BrainEngine, target: PinTarget): Promise<PinPlan> {
  const [generation] = await engine.executeRaw<{ value: string }>("SELECT COALESCE(max(sequence),0)::text AS value FROM codex_upgrade_receipts WHERE kind='pins'");
  return makePinPlan('database', await identity(engine), generation!.value, target, await rows(engine));
}
async function assertApplied(engine: BrainEngine, record: Receipt) {
  validatePinPlan(record.plan);
  if (record.plan.plane !== 'database' || record.plan.identity !== await identity(engine)) pinError('brain_changed');
  const current = await rows(engine);
  for (const change of record.plan.changes) {
    const expected = record.state === 'applied' ? change.after : change.before;
    if (expected === null ? current[change.key] !== undefined : current[change.key] === undefined || digest(current[change.key]) !== digest(expected)) pinError('configuration_changed');
  }
}
/** Configuration and rollback receipt commit together. No providers, workers or production migrations. */
export async function applyDatabasePins(engine: BrainEngine, target: PinTarget, expected: string): Promise<Receipt> {
  if (!/^[a-f0-9]{64}$/.test(expected)) return pinError('preview_required');
  return engine.transaction(async tx => {
    await tx.executeRaw('LOCK TABLE config IN SHARE ROW EXCLUSIVE MODE');
    const [prior] = await tx.executeRaw<Receipt>("SELECT id,plan,state,receipt FROM codex_upgrade_receipts WHERE kind='pins' AND plan_hash=$1 ORDER BY sequence DESC LIMIT 1 FOR UPDATE", [expected]);
    if (prior) { if (digest(prior.plan.target) !== digest(target)) pinError('target_changed'); await assertApplied(tx, prior); return prior; }
    const plan = await previewDatabasePins(tx, target);
    if (plan.plan_hash !== expected) pinError('preview_changed');
    if (!plan.changes.length) pinError('no_changes');
    for (const c of plan.changes) { if (c.after === null) await tx.executeRaw('DELETE FROM config WHERE key=$1', [c.key]); else await tx.setConfig(c.key, c.after as string); }
    const record: Receipt = { id: randomUUID(), plan, state: 'applied', receipt: { changed: plan.changes.length } };
    await tx.executeRaw("INSERT INTO codex_upgrade_receipts(id,kind,plan_hash,plan,state,receipt) VALUES($1::uuid,'pins',$2,$3::text::jsonb,'applied',$4::text::jsonb)",
      [record.id, plan.plan_hash, JSON.stringify(plan), JSON.stringify(record.receipt)]);
    return record;
  });
}
export async function rollbackDatabasePins(engine: BrainEngine, id: string, expected: string): Promise<Receipt> {
  if (!/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(expected)) return pinError('receipt_required');
  return engine.transaction(async tx => {
    await tx.executeRaw('LOCK TABLE config IN SHARE ROW EXCLUSIVE MODE');
    const [record] = await tx.executeRaw<Receipt>("SELECT id,plan,state,receipt FROM codex_upgrade_receipts WHERE id=$1::uuid AND kind='pins' FOR UPDATE", [id]);
    if (!record || record.plan.plan_hash !== expected) return pinError('receipt_changed');
    await assertApplied(tx, record);
    if (record.state === 'rolled_back') return record;
    for (const c of record.plan.changes) await tx.setConfig(c.key, c.before as string);
    await tx.executeRaw("UPDATE codex_upgrade_receipts SET state='rolled_back',updated_at=now() WHERE id=$1::uuid", [id]);
    return { ...record, state: 'rolled_back' };
  });
}
