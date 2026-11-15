import type { BrainEngine } from '../engine.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { validateMaintenance, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { countRecentSynthSubmissions } from './synthesize.ts';

const MAX_TRACKED_SUBMISSIONS = 10000;
const key = (authority: MaintenanceAuthority) => `dream.codex.synthesis.submissions.${authority.writer.sourceIncarnation}`;
async function window(engine: BrainEngine, authority: MaintenanceAuthority, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TRACKED_SUBMISSIONS) throw new Error('codex_synthesis_daily_limit_invalid');
  const [clock] = await engine.executeRaw<{ms:string}>('SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms');
  const now = Number(clock!.ms), raw = await engine.getConfig(key(authority));
  const all: unknown = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(all) || all.length > MAX_TRACKED_SUBMISSIONS || all.some(t => !Number.isSafeInteger(t))) throw new Error('codex_synthesis_counter_invalid');
  const stamps = (all as number[]).filter(t => t > now - 86400000);
  return { now, stamps, used: stamps.length + await countRecentSynthSubmissions(engine, authority.writer.sourceId) };
}
/** Read-only preflight. The durable reservation below is authoritative under concurrent workers. */
export async function remainingSynthesisSubmissions(engine: BrainEngine, authority: MaintenanceAuthority, limit: number): Promise<number> {
  return limit === 0 ? Infinity : Math.max(0, limit - (await window(engine, authority, limit)).used);
}
/** Charge each chunk, including uncapped calls, so enabling a cap cannot erase prior usage. */
export async function reserveSynthesisSubmission(engine: BrainEngine, authority: MaintenanceAuthority, limit: number): Promise<void> {
  await engine.transaction(async tx => {
    codexSubscriptionContext()?.signal?.throwIfAborted();
    await codexSubscriptionContext()?.checkAuthorityInTransaction?.(tx);
    await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [authority.writer.sourceId]);
    await validateMaintenance(tx, authority, 'reflections');
    const state = await window(tx, authority, limit || MAX_TRACKED_SUBMISSIONS);
    if (limit > 0 && state.used >= limit) throw new Error('codex_synthesis_daily_limit');
    await tx.setConfig(key(authority), JSON.stringify([...state.stamps, state.now].sort((a, b) => a - b).slice(-MAX_TRACKED_SUBMISSIONS)));
  });
}
