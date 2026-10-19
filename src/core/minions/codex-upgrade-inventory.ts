import type { BrainEngine } from '../engine.ts';
import { digest } from '../persistence/digest.ts';
import { CODEX_GENERATIVE_JOBS, jobMayGenerate } from './subscription-job-kinds.ts';
import { LIVE_UPGRADE_STATUSES, upgradeError, upgradeIdentity } from './codex-upgrade-snapshot.ts';

const PAGE_SIZE = 128;
const MAX_LIVE_JOBS = 10_000;
const MAX_PAYLOAD_BYTES = 262_144;
const MAX_SUPERVISOR_LOCKS = 10_000;
const MAX_LOCK_FIELD_BYTES = 4096;
const SUPERVISOR_LOCK_PREFIX = 'gbrain-supervisor:';
const MODEL_PIN_KEYS = ['model', 'model_id', 'modelId'] as const;

interface InventoryRow {
  id: number;
  name: string;
  queue: string;
  status: string;
  parent_job_id: number | null;
  attempts_made: number;
  attempts_started: number;
  started_at: Date | string | null;
  data: Record<string, unknown> | null;
  payload_bytes: number;
  parked_job_id: number | null;
  submission_kind: string | null;
  has_lock_token: boolean;
  lock_unexpired: boolean;
}

interface SupervisorLockRow {
  id: string | null;
  id_bytes: number;
  host_bytes: number;
  holder_pid: number;
  holder_host: string | null;
  ttl_unexpired: boolean;
  refresh_age_seconds: number | string | null;
}

/** One read-only snapshot of every nonterminal queue row. No payload or pin value leaves this function. */
export async function inventoryQueuedJobs(engine: BrainEngine, maxJobs = MAX_LIVE_JOBS, maxSupervisorLocks = MAX_SUPERVISOR_LOCKS) {
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > MAX_LIVE_JOBS) upgradeError('invalid_inventory_limit');
  if (!Number.isSafeInteger(maxSupervisorLocks) || maxSupervisorLocks < 1 || maxSupervisorLocks > MAX_SUPERVISOR_LOCKS) upgradeError('invalid_lock_inventory_limit');
  return engine.transaction(async tx => {
    // The PGLite brain is single-writer. PostgreSQL needs a stable snapshot while pages are read.
    if (tx.kind === 'postgres') await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const brainId = await upgradeIdentity(tx);
    const jobs: Array<Record<string, unknown>> = [];
    let after = 0;
    while (true) {
      const rows = await tx.executeRaw<InventoryRow>(
        `SELECT j.id,j.name,j.queue,j.status,j.parent_job_id,j.attempts_made,j.attempts_started,j.started_at,
                CASE WHEN pg_column_size(j.data)<=$4 THEN j.data ELSE NULL END AS data,
                pg_column_size(j.data)::int AS payload_bytes,p.job_id AS parked_job_id,
                j.submission_authority->>'kind' AS submission_kind,
                (j.lock_token IS NOT NULL) AS has_lock_token,(j.lock_until>now()) AS lock_unexpired
           FROM minion_jobs j LEFT JOIN codex_parked_jobs p ON p.job_id=j.id
          WHERE j.id>$1 AND j.status=ANY($2::text[])
          ORDER BY j.id LIMIT $3`,
        [after, LIVE_UPGRADE_STATUSES, PAGE_SIZE, MAX_PAYLOAD_BYTES]);
      for (const row of rows) {
        const data = row.data;
        if (data === null) return upgradeError('snapshot_too_large');
        if (row.payload_bytes > MAX_PAYLOAD_BYTES) return upgradeError('snapshot_too_large');
        if (jobs.length >= maxJobs) upgradeError('inventory_too_large');
        const named = CODEX_GENERATIVE_JOBS.has(row.name) ? row.name : 'unclassified';
        const modelPinKeys = MODEL_PIN_KEYS.filter(key => Object.hasOwn(data, key));
        jobs.push({ id: row.id, name: named, queue: row.queue === 'default' ? 'default' : 'non_default',
          queue_hash: digest(row.queue),
          status: row.status, parent_job_id: row.parent_job_id,
          generation: jobMayGenerate(row.name, data) ? 'possible' : row.name === 'autopilot-cycle' ? 'freshness_only' : 'unclassified',
          model_pin_keys: modelPinKeys, submission_kind: row.submission_kind === 'application' ? 'application' : 'legacy_or_other',
          started: row.started_at !== null || row.attempts_started > 0 || row.attempts_made > 0,
          disposition: row.parked_job_id !== null ? 'parked' : row.status === 'active' ? 'drain' : 'park',
          ...(row.status === 'active' ? { claim_lease: !row.has_lock_token ? 'missing' : row.lock_unexpired ? 'unexpired' : 'expired' } : {}),
          payload_hash: digest(data) });
        after = row.id;
      }
      if (rows.length < PAGE_SIZE) break;
    }
    const lockRows = await tx.executeRaw<SupervisorLockRow>(
      `SELECT CASE WHEN octet_length(id)<=$1 THEN id ELSE NULL END AS id,
              octet_length(id)::int AS id_bytes,octet_length(coalesce(holder_host,''))::int AS host_bytes,
              holder_pid,CASE WHEN octet_length(coalesce(holder_host,''))<=$1 THEN holder_host ELSE NULL END AS holder_host,
              (ttl_expires_at>now()) AS ttl_unexpired,
              EXTRACT(EPOCH FROM (now()-last_refreshed_at))::int AS refresh_age_seconds
         FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-supervisor:%'
        ORDER BY gbrain_cycle_locks.id LIMIT $2`, [MAX_LOCK_FIELD_BYTES, maxSupervisorLocks + 1]);
    if (lockRows.length > maxSupervisorLocks) upgradeError('lock_inventory_too_large');
    const supervisorLocks = lockRows.map(row => {
      const lockId = row.id ?? upgradeError('lock_snapshot_too_large');
      if (row.id_bytes > MAX_LOCK_FIELD_BYTES || row.host_bytes > MAX_LOCK_FIELD_BYTES) upgradeError('lock_snapshot_too_large');
      const queue = lockId.slice(SUPERVISOR_LOCK_PREFIX.length);
      return { queue: queue === 'default' ? 'default' : 'non_default', queue_hash: digest(queue),
        holder_pid: row.holder_pid, holder_host_hash: row.holder_host === null ? null : digest(row.holder_host),
        ttl_signal: row.ttl_unexpired ? 'unexpired' : 'expired',
        refresh_age_seconds: row.refresh_age_seconds === null ? null : Number(row.refresh_age_seconds) };
    });
    const body = { version: 1, kind: 'queue_inventory', brain_id: brainId, live_count: jobs.length,
      jobs, queue_snapshot_complete: true, supervisor_locks: supervisorLocks,
      supervisor_lock_snapshot_complete: true, workers: 'uninspected', cutover_ready: false,
      note: 'Stop producers and workers on every host, then rerun this snapshot and use explicit job previews for parking.' };
    return { ...body, snapshot_hash: digest(body) };
  });
}
