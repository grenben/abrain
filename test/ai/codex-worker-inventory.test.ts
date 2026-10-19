import { test, expect, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryLocalGbrainProcesses } from '../../src/core/minions/codex-worker-inventory.ts';
import { run } from '../../src/cli/commands/private-codex.ts';
import * as output from '../../src/core/cli-force-exit.ts';
import type { CliDispatchContext } from '../../src/cli/command-table.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const stat = (pid: number, ticks: string) => `${pid} (gbrain worker) ${['S', ...Array(18).fill('0'), ticks].join(' ')}`;

test('local process inventory identifies worker, supervisor and child without exposing launcher values', () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-worker-inventory-'));
  try {
    mkdirSync(join(root, 'self/ns'), { recursive: true });
    symlinkSync('pid:[4026532123]', join(root, 'self/ns/pid'));
    const rows: Array<[number, string[], string]> = [
      [11, ['bun', '/checkout/gbrain-codex-v307-dev/src/cli.ts', 'jobs', 'work', '--queue', 'PRIVATE_QUEUE'], 'worker'],
      [12, ['/installed/bin/gbrain', 'jobs', 'supervisor', 'start'], 'supervisor'],
      [13, ['tini', '-s', '--', '/installed/bin/gbrain', 'jobs', 'run-child', '--job-id', '55'], 'job_child'],
      [14, ['bun', '/tmp/unrelated.ts', 'gbrain'], 'other'],
      [15, ['bun', 'src/cli.ts', 'jobs', 'work'], 'source_worker'],
      [16, ['/installed/bin/gbrain', 'serve', '--http'], 'server'],
      [17, ['/installed/bin/gbrain', 'autopilot'], 'autopilot'],
    ];
    for (const [pid, argv] of rows) {
      const dir = join(root, String(pid));
      mkdirSync(dir);
      writeFileSync(join(dir, 'stat'), stat(pid, String(pid * 100)));
      writeFileSync(join(dir, 'cmdline'), `${argv.join('\0')}\0`);
      symlinkSync('/private/install/gbrain', join(dir, 'exe'));
      writeFileSync(join(dir, 'environ'), 'GBRAIN_MODEL=SECRET_MODEL\0DATABASE_URL=SECRET_DB\0GBRAIN_SUPERVISED=1\0');
    }
    const found = inventoryLocalGbrainProcesses({ procRoot: root, platform: 'linux' });
    expect(found.local_scan_complete).toBe(true);
    expect(found.processes.map(row => row.role)).toEqual(['worker', 'supervisor', 'job_child', 'worker', 'server', 'autopilot']);
    expect(found.processes[0]).toMatchObject({ pid: 11, start_ticks: '1100',
      environment: { fingerprints: { GBRAIN_MODEL: sha('SECRET_MODEL'), GBRAIN_SUPERVISED: sha('1') },
        connection_keys_present: ['DATABASE_URL'] } });
    expect(found).toMatchObject({ cross_host_complete: false, cutover_ready: false });
    expect(JSON.stringify(found)).not.toContain('SECRET_MODEL');
    expect(JSON.stringify(found)).not.toContain('SECRET_DB');
    expect(JSON.stringify(found)).not.toContain('PRIVATE_QUEUE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unreadable local process data and unsupported hosts never report complete coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-worker-inventory-'));
  try {
    mkdirSync(join(root, 'self/ns'), { recursive: true });
    symlinkSync('pid:[42]', join(root, 'self/ns/pid'));
    mkdirSync(join(root, '99'));
    writeFileSync(join(root, '99/stat'), stat(99, '999'));
    writeFileSync(join(root, '99/cmdline'), 'gbrain\0jobs\0work\0');
    mkdirSync(join(root, '100'));
    writeFileSync(join(root, '100/cmdline'), 'gbrain\0jobs\0work\0');
    const partial = inventoryLocalGbrainProcesses({ procRoot: root, platform: 'linux' });
    expect(partial).toMatchObject({ local_scan_complete: false, uninspectable_processes: 3,
      processes: [{ pid: 99, environment: 'uninspectable', executable_path_hash: null }] });
    const unsupported = inventoryLocalGbrainProcesses({ procRoot: root, platform: 'darwin' });
    expect(unsupported).toMatchObject({ local_scan_complete: false, reason: 'unsupported_platform', cutover_ready: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workers CLI performs the host scan without opening a brain database', async () => {
  const written: string[] = [];
  const print = spyOn(output, 'writeStdoutFinal').mockImplementation(async value => { written.push(value); });
  const ctx = { connectEngine: async () => { throw new Error('database must stay closed'); } } as unknown as CliDispatchContext;
  try {
    await run(['jobs', 'workers', '--json'], ctx);
    expect(JSON.parse(written.join(''))).toMatchObject({ kind: 'local_worker_inventory', cutover_ready: false,
      cross_host_complete: false });
  } finally { print.mockRestore(); }
});

test('preflight on an older brain reports missing migration without querying the queue', async () => {
  const written: string[] = [], queried: string[] = [];
  const print = spyOn(output, 'writeStdoutFinal').mockImplementation(async value => { written.push(value); });
  const engine = { executeRaw: async (sql: string) => {
    queried.push(sql);
    if (!sql.startsWith("SELECT to_regclass('minion_jobs')")) throw new Error('queue must stay unread');
    return [{ jobs: true, parking: false, locks: true }];
  }, disconnect: async () => {} };
  const ctx = { connectEngine: async (opts: unknown) => {
    expect(opts).toEqual({ probeOnly: true }); return engine;
  } } as unknown as CliDispatchContext;
  try {
    await run(['jobs', 'preflight', '--json'], ctx);
    const report = JSON.parse(written.join(''));
    expect(report.blockers).toContainEqual({ code: 'job_upgrade_schema_missing',
      required_migration: 267, missing_relations: ['codex_parked_jobs'] });
    expect(report).toMatchObject({ status: 'blocked', cutover_ready: false,
      brain_id: null, queue_snapshot_hash: null });
    expect(queried).toHaveLength(1);
    expect(output.currentExitCode()).toBe(1);
  } finally { print.mockRestore(); output._resetCliExitVerdictForTests(); process.exitCode = 0; }
});
