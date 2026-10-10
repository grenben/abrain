import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configPath } from '../config-path.ts';
import { atomicWriteFileSync } from '../atomic-write.ts';
import { flushDirectory } from '../fs-durable.ts';
import { digest, sha256 } from '../persistence/digest.ts';
import { acquireNativeLock } from '../persistence/native-lock.ts';
import { FILE_GENERATIVE_PINS, makePinPlan, pinError, validatePinPlan, type PinPlan } from './private-pin-plan.ts';

interface FileReceipt {
  id: string; plan: PinPlan; state: 'pending_apply' | 'applied' | 'pending_rollback' | 'rolled_back';
  before_hash: string; after_hash: string; rollback_hash: string;
}
interface Journal { version: 1; generation: number; records: FileReceipt[] }
const paths = () => { const file = configPath(), dir = join(dirname(file), 'private-codex-pins'); return { file, dir, journal: join(dir, 'receipts.json'), lock: join(dir, 'writer.lock') }; };
function read(path: string, optional = false): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; return pinError('file_unavailable'); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) pinError('unsafe_file');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
function object(raw: string): Record<string, unknown> {
  try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch { /* sanitized below */ }
  return pinError('invalid_file');
}
function journal(): Journal {
  const raw = read(paths().journal, true);
  if (raw === undefined) return { version: 1, generation: 0, records: [] };
  const j = object(raw) as unknown as Journal;
  if (j.version !== 1 || !Number.isSafeInteger(j.generation) || j.generation < 0 || !Array.isArray(j.records) || j.records.length > 256) pinError('invalid_receipts');
  for (const r of j.records) {
    validatePinPlan(r.plan);
    if (r.plan.plane !== 'file' || r.plan.identity !== digest(paths().file) || !['pending_apply','applied','pending_rollback','rolled_back'].includes(r.state) ||
        !/^[a-f0-9-]{36}$/.test(r.id) || [r.before_hash,r.after_hash,r.rollback_hash].some(h => !/^[a-f0-9]{64}$/.test(h))) pinError('invalid_receipts');
  }
  return j;
}
const render = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
function save(j: Journal) { atomicWriteFileSync(paths().journal, render(j), { mode: 0o600, durable: true }); }
function publish(raw: string, expected: string) {
  atomicWriteFileSync(paths().file, raw, { mode: 0o600, durable: true,
    verify: () => { if (sha256(read(paths().file)!) !== expected) pinError('configuration_changed'); } });
}
function changed(raw: string, plan: PinPlan, reverse = false): string {
  const config = object(raw);
  for (const c of plan.changes) config[c.key] = reverse ? c.before : c.after;
  return render(config);
}
export function previewFilePins(target: string): PinPlan {
  const j = journal();
  if (j.records.some(r => r.state.startsWith('pending'))) pinError('pending_migration');
  const raw = read(paths().file)!, config = object(raw);
  return makePinPlan('file', digest(paths().file), String(j.generation), target,
    Object.fromEntries(FILE_GENERATIVE_PINS.map(key => [key, config[key]])), sha256(raw));
}
export function filePinReceipts(): FileReceipt[] { return journal().records; }
async function locked<T>(run: () => T): Promise<T> {
  mkdirSync(paths().dir, { recursive: true, mode: 0o700 });
  const claim = await acquireNativeLock(paths().lock, { timeoutMs: 0 });
  if (!claim) return pinError('migration_busy');
  try { return run(); } finally { await claim.release(); }
}
/** Journal before file replacement; recovery distinguishes old, applied and unrelated bytes. */
export async function applyFilePins(target: string, expected: string): Promise<FileReceipt> {
  if (!/^[a-f0-9]{64}$/.test(expected)) return pinError('preview_required');
  return locked(() => {
    const j = journal(); let record = j.records.find(r => r.plan.plan_hash === expected);
    if (!record) {
      const plan = previewFilePins(target);
      if (plan.plan_hash !== expected) return pinError('preview_changed');
      if (!plan.changes.length || j.records.length >= 256) return pinError('no_changes_or_receipts_full');
      const raw = read(paths().file)!, after = changed(raw, plan);
      if (sha256(raw) !== plan.snapshot_hash) return pinError('preview_changed');
      record = { id: randomUUID(), plan, state: 'pending_apply', before_hash: sha256(raw), after_hash: sha256(after), rollback_hash: sha256(changed(after, plan, true)) };
      j.records.push(record); save(j);
    }
    if (record.plan.target !== target || record.state === 'pending_rollback' || record.state === 'rolled_back') return pinError('receipt_state_changed');
    const raw = read(paths().file)!, hash = sha256(raw);
    if (record.state === 'applied') { if (hash !== record.after_hash) pinError('configuration_changed'); return record; }
    if (hash === record.before_hash) {
      const after = changed(raw, record.plan);
      if (sha256(after) !== record.after_hash) pinError('receipt_changed');
      publish(after, record.before_hash);
    } else if (hash !== record.after_hash) return pinError('configuration_changed');
    flushDirectory(dirname(paths().file));
    record.state = 'applied'; j.generation++; save(j); return record;
  });
}
export async function rollbackFilePins(id: string, expected: string): Promise<FileReceipt> {
  return locked(() => {
    const j = journal(), r = j.records.find(v => v.id === id);
    if (!r || r.plan.plan_hash !== expected || r.state === 'pending_apply') return pinError('receipt_required');
    const raw = read(paths().file)!, hash = sha256(raw);
    if (r.state === 'rolled_back') { if (hash !== r.rollback_hash) pinError('configuration_changed'); return r; }
    if (r.state === 'applied') { if (hash !== r.after_hash) pinError('configuration_changed'); r.state = 'pending_rollback'; save(j); }
    if (hash === r.after_hash) {
      const before = changed(raw, r.plan, true);
      if (sha256(before) !== r.rollback_hash) pinError('receipt_changed');
      publish(before, r.after_hash);
    } else if (hash !== r.rollback_hash) return pinError('configuration_changed');
    flushDirectory(dirname(paths().file));
    r.state = 'rolled_back'; j.generation++; save(j); return r;
  });
}
