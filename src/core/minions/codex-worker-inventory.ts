/** Local process evidence for a private cutover. Never an absence proof across hosts or PID namespaces. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

const MAX_PROCESSES = 65_536;
const MAX_CANDIDATES = 256;
const MAX_COMMAND_BYTES = 65_536;
const MAX_ENV_BYTES = 1_048_576;
const FINGERPRINT_KEYS = new Set([
  'GBRAIN_HOME', 'GBRAIN_MODEL', 'GBRAIN_CHAT_MODEL', 'GBRAIN_EMBEDDING_MODEL',
  'GBRAIN_SUPERVISED', 'GBRAIN_ALLOW_SHELL_JOBS', 'GBRAIN_PLUGIN_PATH',
  'GBRAIN_JOB_CHILD_CLI', 'GBRAIN_SUPERVISOR_PID_FILE',
]);
const PRESENCE_ONLY_KEYS = new Set(['DATABASE_URL', 'GBRAIN_DATABASE_URL']);
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

function gbrainArgIndex(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const prior = i === 0 ? '' : basename(argv[0]!);
    const runtimeScript = ['bun', 'node'].includes(prior) && (i === 1 || (i === 2 && argv[1]!.startsWith('-')));
    const tiniChild = prior === 'tini' && argv[i - 1] === '--';
    if (i > 0 && !runtimeScript && !tiniChild) continue;
    // Source workers also run as `bun src/cli.ts jobs work`; include this
    // conservative candidate even when the checkout directory is not in argv.
    if (runtimeScript && /^(?:\.\/)?(?:src\/)?cli\.ts$/.test(arg) && argv[i + 1] === 'jobs') return i;
    if (basename(arg) === 'gbrain' || /(?:^|[/\\])gbrain[^/\\]*[/\\](?:src[/\\]cli\.ts|bin[/\\]gbrain)$/.test(arg)) return i;
  }
  return -1;
}

function role(argv: string[], index: number): 'worker' | 'supervisor' | 'job_child' | 'other_gbrain' {
  if (argv[index + 1] !== 'jobs') return 'other_gbrain';
  switch (argv[index + 2]) {
    case 'work': return 'worker';
    case 'supervisor': return 'supervisor';
    case 'run-child': return 'job_child';
    default: return 'other_gbrain';
  }
}

/** Linux stat field 22, with the parenthesized process name allowed to contain spaces or `)`. */
function processStartTicks(raw: string): string | null {
  const end = raw.lastIndexOf(')');
  if (end < 0) return null;
  const fields = raw.slice(end + 1).trim().split(/\s+/);
  const ticks = fields[19];
  return ticks && /^\d+$/.test(ticks) ? ticks : null;
}

function launchEnvironment(raw: Buffer) {
  if (raw.length > MAX_ENV_BYTES) throw new Error('environment_too_large');
  const fingerprints: Record<string, string> = {};
  const presence: string[] = [];
  for (const item of raw.toString('utf8').split('\0')) {
    const equals = item.indexOf('=');
    if (equals < 1) continue;
    const key = item.slice(0, equals);
    if (FINGERPRINT_KEYS.has(key)) fingerprints[key] = digest(item.slice(equals + 1));
    if (PRESENCE_ONLY_KEYS.has(key)) presence.push(key);
  }
  return { fingerprints, connection_keys_present: [...new Set(presence)].sort() };
}

export interface LocalWorkerInventoryOptions {
  procRoot?: string;
  platform?: NodeJS.Platform;
}

/**
 * Inspect the current PID namespace without reading the worker registry (whose read prunes files).
 * A disappearing process is a race; an unreadable live process makes local coverage incomplete.
 */
export function inventoryLocalGbrainProcesses(opts: LocalWorkerInventoryOptions = {}) {
  const procRoot = opts.procRoot ?? '/proc';
  const platform = opts.platform ?? process.platform;
  const base = { version: 1, kind: 'local_worker_inventory', scope: 'current_pid_namespace',
    cutover_ready: false, cross_host_complete: false };
  if (platform !== 'linux') return { ...base, local_scan_complete: false, reason: 'unsupported_platform', processes: [] };
  let entries: string[];
  try { entries = readdirSync(procRoot).filter(entry => /^\d+$/.test(entry)); }
  catch { return { ...base, local_scan_complete: false, reason: 'proc_unavailable', processes: [] }; }
  if (entries.length > MAX_PROCESSES) return { ...base, local_scan_complete: false, reason: 'process_limit', processes: [] };
  let namespace_hash: string | null = null;
  try { namespace_hash = digest(readlinkSync(join(procRoot, 'self/ns/pid'))); } catch { /* unknown namespace */ }
  const processes: Array<Record<string, unknown>> = [];
  let uninspectable = 0;
  for (const entry of entries.sort((a, b) => Number(a) - Number(b))) {
    const dir = join(procRoot, entry);
    let command: Buffer;
    let ticks: string | null;
    try {
      command = readFileSync(join(dir, 'cmdline'));
      ticks = processStartTicks(readFileSync(join(dir, 'stat'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || existsSync(dir)) uninspectable++;
      continue;
    }
    if (!ticks || command.length > MAX_COMMAND_BYTES) { uninspectable++; continue; }
    const argv = command.toString('utf8').split('\0').filter(Boolean);
    const index = gbrainArgIndex(argv);
    if (index < 0) continue;
    if (processes.length >= MAX_CANDIDATES) return { ...base, namespace_hash,
      local_scan_complete: false, reason: 'candidate_limit', uninspectable_processes: uninspectable, processes: [] };
    let executable_path_hash: string | null = null;
    try { executable_path_hash = digest(readlinkSync(join(dir, 'exe'))); } catch { uninspectable++; }
    let environment: ReturnType<typeof launchEnvironment> | null = null;
    try { environment = launchEnvironment(readFileSync(join(dir, 'environ'))); } catch { uninspectable++; }
    processes.push({ pid: Number(entry), start_ticks: ticks, role: role(argv, index),
      argv_hash: digest(command), executable_path_hash,
      environment: environment ?? 'uninspectable' });
  }
  return { ...base, namespace_hash, local_scan_complete: uninspectable === 0 && namespace_hash !== null,
    uninspectable_processes: uninspectable, process_count: entries.length, processes };
}
