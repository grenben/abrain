import type { BrainEngine } from '../engine.ts';
import { digest } from '../persistence/digest.ts';
import { OperationError } from '../ops/contract.ts';
import { CODEX_READ_PROTOCOL, CODEX_WRITE_PROTOCOL } from './codex-action-contract.ts';

export const LIVE_UPGRADE_STATUSES = ['waiting','delayed','waiting-children','paused','active'];
export const upgradeError = (code: string): never => { throw new OperationError('invalid_params', `Codex job upgrade refused: ${code}.`, 'Stop producers for cutover, inspect a fresh preview and retain unresolved work for reconciliation.'); };
export function upgradeIds(ids: number[]): number[] {
  if (!Array.isArray(ids) || !ids.length || ids.length > 128 || ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)) upgradeError('invalid_ids');
  return [...new Set(ids)].sort((a,b) => a-b);
}
export function upgradeHash(hash: string): void { if (!/^[a-f0-9]{64}$/.test(hash)) upgradeError('preview_required'); }
export async function lockJobUpgrade(engine: BrainEngine): Promise<void> {
  await engine.executeRaw('LOCK TABLE minion_jobs IN SHARE ROW EXCLUSIVE MODE');
  await engine.executeRaw('LOCK TABLE sources IN SHARE MODE');
}
export async function upgradeIdentity(engine: BrainEngine): Promise<string> {
  const [row] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id::text FROM persistence_brain WHERE singleton=1');
  if (!row?.brain_id) return upgradeError('brain_identity_unavailable'); return row.brain_id;
}
export interface UpgradeRow extends Record<string, unknown> {
  id: number; name: string; status: string; data: Record<string, unknown>; parent_job_id: number | null;
  attempts_made: number; started_at: unknown; submission_authority: unknown;
}
async function boundedRows(engine: BrainEngine, where: string, ids: number[]): Promise<UpgradeRow[]> {
  const rows = await engine.executeRaw<{ snapshot: UpgradeRow | null }>(
    `SELECT CASE WHEN pg_column_size(to_jsonb(j))<=262144 THEN to_jsonb(j) ELSE NULL END AS snapshot FROM minion_jobs j WHERE ${where} ORDER BY id LIMIT 129`, [ids]);
  if (rows.length > 128 || rows.some(r => !r.snapshot)) return upgradeError('snapshot_too_large');
  return rows.map(r => r.snapshot!);
}
/** Bounded explicit selection. Payloads/authority remain internal; output contains hashes only. */
export async function jobUpgradeSnapshot(engine: BrainEngine, requested: number[]) {
  const ids = upgradeIds(requested), rows = await boundedRows(engine, 'id=ANY($1::int[])', ids);
  if (rows.length !== ids.length) upgradeError('job_missing');
  const adjacent = await boundedRows(engine, '(parent_job_id=ANY($1::int[]) OR id IN (SELECT parent_job_id FROM minion_jobs WHERE id=ANY($1::int[]))) AND NOT(id=ANY($1::int[]))', ids);
  const parked = await engine.executeRaw<{ job_id: number; receipt_id: string; replacement_job_id: number | null }>('SELECT job_id,receipt_id,replacement_job_id FROM codex_parked_jobs WHERE job_id=ANY($1::int[]) ORDER BY job_id', [ids]);
  const sources = [...new Set([...rows,...adjacent].flatMap(r => [r.data?.source_id,r.data?.sourceId]).filter((s): s is string => typeof s === 'string'))].sort();
  const sourceRows = await engine.executeRaw('SELECT id,incarnation,created_at,archived FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [sources]);
  const jobs = rows.map(r => ({ id: r.id, status: r.status, name: /^[a-zA-Z0-9_-]{1,96}$/.test(r.name) ? r.name : 'unrecognized',
    snapshot_hash: digest(r), protocol: [CODEX_READ_PROTOCOL,CODEX_WRITE_PROTOCOL].includes(r.data?.action_protocol as string) ? r.data.action_protocol : 'legacy_or_other',
    resubmit_precheck: r.attempts_made !== 0 || r.attempts_started !== 0 || r.started_at !== null ? 'requires_reconciliation' : 'separate_review_required',
    disposition: parked.some(p => p.job_id === r.id) ? 'parked' : r.status === 'active' ? 'drain' : LIVE_UPGRADE_STATUSES.includes(r.status) ? 'park' : 'terminal_review' }));
  const body = { version: 1, kind: 'jobs', operation: 'park', brain_id: await upgradeIdentity(engine), ids, jobs,
    dependencies: adjacent.map(r => ({ id: r.id, status: r.status, snapshot_hash: digest(r) })),
    source_hash: digest(sourceRows), parked, coverage_complete: false, scope: 'selected jobs and immediate dependencies',
    ready: jobs.every(j => j.disposition === 'park') && adjacent.every(r => !LIVE_UPGRADE_STATUSES.includes(r.status)) };
  return { rows, plan: { ...body, plan_hash: digest(body) } };
}
export async function previewJobUpgrade(engine: BrainEngine, ids: number[]) { return (await jobUpgradeSnapshot(engine, ids)).plan; }
