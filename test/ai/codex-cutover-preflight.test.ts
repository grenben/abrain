import { test, expect } from 'bun:test';
import { reviewPrivateCutover } from '../../src/core/minions/codex-cutover-preflight.ts';

const queue = () => ({ snapshot_hash: 'synthetic-hash', brain_id: 'synthetic-brain',
  queue_snapshot_complete: true, supervisor_lock_snapshot_complete: true,
  jobs: [] as Array<Record<string, unknown>>, supervisor_locks: [] as Array<Record<string, unknown>> });
const local = () => ({ scope: 'current_pid_namespace', namespace_hash: 'synthetic-namespace',
  local_scan_complete: true, uninspectable_processes: 0, processes: [] as Array<Record<string, unknown>> });

test('cutover preflight reports all observed blockers without treating the scanning CLI as a worker', () => {
  const q = queue(), l = local();
  q.jobs.push({ id: 12, status: 'active', disposition: 'drain' },
    { id: 14, status: 'waiting', disposition: 'park' },
    { id: 15, status: 'paused', disposition: 'parked' });
  q.supervisor_locks.push({ holder_pid: 25 });
  l.processes.push({ pid: 100, role: 'other_gbrain' }, { pid: 101, role: 'server' });
  const report = reviewPrivateCutover(q, l, 100);
  expect(report).toMatchObject({ status: 'blocked', cutover_ready: false, snapshots_atomic: false,
    blockers: [
      { code: 'active_jobs_require_drain', count: 1, ids_sample: [12] },
      { code: 'pending_jobs_require_disposition', count: 1, ids_sample: [14] },
      { code: 'supervisor_lock_rows_require_review', count: 1 },
      { code: 'local_gbrain_processes_require_stop_or_review', count: 1,
        processes_sample: [{ pid: 101, role: 'server' }] },
    ] });
  expect(JSON.stringify(report)).not.toContain('holder_pid');
});

test('cutover preflight cannot certify readiness with empty or partial snapshots', () => {
  expect(reviewPrivateCutover(queue(), local(), 100)).toMatchObject({ status: 'incomplete',
    blockers: [], cutover_ready: false, snapshots_atomic: false });
  const q = queue(), l = local();
  q.queue_snapshot_complete = false; l.local_scan_complete = false; l.uninspectable_processes = 2;
  expect(reviewPrivateCutover(q, l, 100).blockers).toEqual([
    { code: 'database_snapshot_incomplete' },
    { code: 'local_process_scan_incomplete', count: 2 },
  ]);
});

test('missing upgrade schema keeps queue unknown while retaining local blockers', () => {
  const l = local(); l.processes.push({ pid: 77, role: 'server' });
  const report = reviewPrivateCutover(null, l, 100, ['codex_parked_jobs']);
  expect(report).toMatchObject({ status: 'blocked', brain_id: null, queue_snapshot_hash: null,
    cutover_ready: false, blockers: [
      { code: 'job_upgrade_schema_missing', required_migration: 267, missing_relations: ['codex_parked_jobs'] },
      { code: 'local_gbrain_processes_require_stop_or_review', count: 1,
        processes_sample: [{ pid: 77, role: 'server' }] },
    ] });
});

test('legacy queue evidence retains migration blocker and observed jobs', () => {
  const q = { ...queue(), parking_schema_present: false };
  q.jobs.push({ id: 27, status: 'waiting', disposition: 'park' });
  const report = reviewPrivateCutover(q, local(), 100, ['codex_parked_jobs']);
  expect(report).toMatchObject({ status: 'blocked', cutover_ready: false,
    brain_id: 'synthetic-brain', queue_snapshot_hash: 'synthetic-hash', queue_snapshot_mode: 'legacy_without_parking',
    blockers: [
      { code: 'job_upgrade_schema_missing', required_migration: 267, missing_relations: ['codex_parked_jobs'] },
      { code: 'pending_jobs_require_disposition', count: 1, ids_sample: [27] },
    ] });
});
