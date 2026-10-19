import type { BrainEngine } from '../engine.ts';
import { digest } from '../persistence/digest.ts';
import { CODEX_GENERATIVE_JOBS, jobMayGenerate } from './subscription-job-kinds.ts';
import { LIVE_UPGRADE_STATUSES, upgradeError, upgradeIdentity } from './codex-upgrade-snapshot.ts';

const PAGE_SIZE = 128;
const MAX_LIVE_JOBS = 10_000;
const MAX_PAYLOAD_BYTES = 262_144;
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
}

/** One read-only snapshot of every nonterminal queue row. No payload or pin value leaves this function. */
export async function inventoryQueuedJobs(engine: BrainEngine, maxJobs = MAX_LIVE_JOBS) {
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > MAX_LIVE_JOBS) upgradeError('invalid_inventory_limit');
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
                j.submission_authority->>'kind' AS submission_kind
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
          payload_hash: digest(data) });
        after = row.id;
      }
      if (rows.length < PAGE_SIZE) break;
    }
    const body = { version: 1, kind: 'queue_inventory', brain_id: brainId, live_count: jobs.length,
      jobs, queue_snapshot_complete: true, workers: 'uninspected', cutover_ready: false,
      note: 'Stop producers and workers, then rerun this snapshot and use explicit job previews for parking.' };
    return { ...body, snapshot_hash: digest(body) };
  });
}
