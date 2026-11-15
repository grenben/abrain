/** Combines two separately timed, read-only inventories; never certifies a cutover. */
export interface QueueCutoverEvidence {
  snapshot_hash: string;
  brain_id: string;
  queue_snapshot_complete: boolean;
  supervisor_lock_snapshot_complete: boolean;
  parking_schema_present?: boolean;
  jobs: Array<Record<string, unknown>>;
  supervisor_locks: Array<Record<string, unknown>>;
}

export interface LocalCutoverEvidence {
  scope: string;
  namespace_hash?: string | null;
  local_scan_complete: boolean;
  uninspectable_processes?: number;
  processes: Array<Record<string, unknown>>;
}

interface Blocker {
  code: string;
  count?: number;
  required_migration?: number;
  missing_relations?: string[];
  ids_sample?: number[];
  processes_sample?: Array<{ pid: number; role: string }>;
}

const MAX_SAMPLE = 128;

/** Actionable blockers plus explicit external gates; no absence proof from either snapshot. */
export function reviewPrivateCutover(queue: QueueCutoverEvidence | null, local: LocalCutoverEvidence,
  selfPid: number, missingRelations: string[] = []) {
  const blockers: Blocker[] = [];
  if (missingRelations.length || queue === null) blockers.push({ code: 'job_upgrade_schema_missing', required_migration: 267,
    missing_relations: missingRelations });
  if (queue !== null && (!queue.queue_snapshot_complete || !queue.supervisor_lock_snapshot_complete)) {
    blockers.push({ code: 'database_snapshot_incomplete' });
  }
  const active = (queue?.jobs ?? []).filter(job => job.status === 'active').map(job => Number(job.id));
  if (active.length) blockers.push({ code: 'active_jobs_require_drain', count: active.length, ids_sample: active.slice(0, MAX_SAMPLE) });
  const pending = (queue?.jobs ?? []).filter(job => job.disposition === 'park').map(job => Number(job.id));
  if (pending.length) blockers.push({ code: 'pending_jobs_require_disposition', count: pending.length, ids_sample: pending.slice(0, MAX_SAMPLE) });
  if (queue?.supervisor_locks.length) blockers.push({ code: 'supervisor_lock_rows_require_review', count: queue.supervisor_locks.length });
  const candidates = local.processes.filter(item => item.pid !== selfPid);
  if (candidates.length) blockers.push({ code: 'local_gbrain_processes_require_stop_or_review', count: candidates.length,
    processes_sample: candidates.slice(0, MAX_SAMPLE).map(item => ({ pid: Number(item.pid), role: String(item.role ?? 'unclassified') })) });
  if (!local.local_scan_complete) blockers.push({ code: 'local_process_scan_incomplete', count: local.uninspectable_processes ?? 0 });
  return { version: 1, kind: 'cutover_preflight', status: blockers.length ? 'blocked' : 'incomplete',
    cutover_ready: false, snapshots_atomic: false,
    brain_id: queue?.brain_id ?? null, queue_snapshot_hash: queue?.snapshot_hash ?? null,
    queue_snapshot_mode: queue === null ? 'unavailable' : queue.parking_schema_present === false ? 'legacy_without_parking' : 'current',
    local_scope: local.scope, local_namespace_hash: local.namespace_hash ?? null,
    blockers, external_requirements: [
      'all_worker_hosts_and_pid_namespaces_quiesced',
      'producer_and_server_stop_verified',
      'runtime_qualification',
      'copied_brain_custody',
      'feature_acceptance_and_activation_review',
    ] };
}
