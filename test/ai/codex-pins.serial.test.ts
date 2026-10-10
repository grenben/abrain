/** Protect file pin migration privacy, CAS, durable recovery and rollback via real
 * atomic writes/native locks. Routing tests never changed files; no test-only API. */
import { beforeAll, beforeEach, afterAll, test, expect, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { previewFilePins, applyFilePins, rollbackFilePins, filePinReceipts } from '../../src/core/ai/private-pin-file.ts';
import { pinPreview } from '../../src/core/ai/private-pin-plan.ts';
import { acquireNativeLock } from '../../src/core/persistence/native-lock.ts';
import * as atomic from '../../src/core/atomic-write.ts';
import * as output from '../../src/core/cli-force-exit.ts';
import { run } from '../../src/cli/commands/private-codex.ts';
import type { CliDispatchContext } from '../../src/cli/command-table.ts';

const root = mkdtempSync(join(tmpdir(), 'codex-pin-file-')), file = join(root, '.gbrain/config.json'), dir = join(root, '.gbrain/private-codex-pins');
const previous = process.env.GBRAIN_HOME, target = 'codex-cli:gpt-fixture', fetch = globalThis.fetch;
const config = { chat_model: 'anthropic:fixture', expansion_model: 'haiku', chat_fallback_chain: ['anthropic:fixture','openai:fixture'],
  embedding_model: 'voyage:fixture', anthropic_api_key: 'SYNTHETIC_CREDENTIAL_CANARY', unrelated: { preserve: true } };
beforeAll(() => { process.env.GBRAIN_HOME = root; mkdirSync(join(root, '.gbrain')); globalThis.fetch = (() => { throw new Error('forbidden network'); }) as unknown as typeof fetch; });
beforeEach(() => { rmSync(dir, { recursive: true, force: true }); writeFileSync(file, JSON.stringify(config)); });
afterAll(() => { if (previous === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = previous; globalThis.fetch = fetch; rmSync(root, { recursive: true, force: true }); });
test('file preview is read-only and exposes only routing metadata', () => {
  const before = readFileSync(file, 'utf8'), plan = previewFilePins(target), preview = pinPreview(plan);
  expect(plan.changes).toHaveLength(3); expect(readFileSync(file, 'utf8')).toBe(before); expect(existsSync(dir)).toBe(false);
  expect(JSON.stringify(preview)).not.toContain('SYNTHETIC_CREDENTIAL_CANARY'); expect(preview.coverage_complete).toBe(false);
  expect(preview.uninspected_planes).toContain('database'); expect(preview.activation).toBe('unchanged');
});
test('file apply and rollback preserve credentials, auxiliaries and activation state', async () => {
  const plan = previewFilePins(target), r = await applyFilePins(target, plan.plan_hash), value = JSON.parse(readFileSync(file, 'utf8'));
  expect(value).toEqual({ ...config, chat_model: target, expansion_model: target, chat_fallback_chain: [target] });
  expect(value.private_codex).toBeUndefined(); expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, 'receipts.json'), 'utf8')).not.toContain('SYNTHETIC_CREDENTIAL_CANARY');
  expect(await applyFilePins(target, plan.plan_hash)).toEqual(r);
  expect((await rollbackFilePins(r.id, plan.plan_hash)).state).toBe('rolled_back');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(config);
  expect((await rollbackFilePins(r.id, plan.plan_hash)).state).toBe('rolled_back');
  expect(previewFilePins(target).plan_hash).not.toBe(plan.plan_hash);
});
test('changed file refuses apply and rollback without overwriting the change', async () => {
  const plan = previewFilePins(target); writeFileSync(file, JSON.stringify({ ...config, new_setting: true }));
  await expect(applyFilePins(target, plan.plan_hash)).rejects.toThrow('preview_changed');
  const next = previewFilePins(target), r = await applyFilePins(target, next.plan_hash);
  const changed = { ...JSON.parse(readFileSync(file, 'utf8')), operator_change: true }; writeFileSync(file, JSON.stringify(changed));
  await expect(rollbackFilePins(r.id, next.plan_hash)).rejects.toThrow('configuration_changed');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(changed);
});
for (const afterEffect of [false, true]) test(`crash ${afterEffect ? 'after' : 'before'} config replacement recovers the retained plan`, async () => {
  const plan = previewFilePins(target), original = atomic.atomicWriteFileSync;
  const fault = spyOn(atomic, 'atomicWriteFileSync').mockImplementation((path, content, opts) => {
    if (path === file) { if (afterEffect) original(path, content, opts); throw new Error('synthetic migration crash'); }
    return original(path, content, opts);
  });
  try { await expect(applyFilePins(target, plan.plan_hash)).rejects.toThrow('synthetic migration crash'); } finally { fault.mockRestore(); }
  const before = filePinReceipts()[0]!; expect(before.state).toBe('pending_apply');
  expect(() => previewFilePins(target)).toThrow('pending_migration');
  const write = spyOn(atomic, 'atomicWriteFileSync');
  try {
    const r = await applyFilePins(target, plan.plan_hash); expect(r.id).toBe(before.id); expect(r.state).toBe('applied');
    expect(write.mock.calls.filter(c => c[0] === file)).toHaveLength(afterEffect ? 0 : 1);
  } finally { write.mockRestore(); }
});
test('a crash after rollback file replacement settles without repeating the replacement', async () => {
  const p = previewFilePins(target), r = await applyFilePins(target, p.plan_hash), original = atomic.atomicWriteFileSync;
  const fault = spyOn(atomic, 'atomicWriteFileSync').mockImplementation((path, content, opts) => { original(path, content, opts); if (path === file) throw new Error('synthetic rollback crash'); });
  try { await expect(rollbackFilePins(r.id, p.plan_hash)).rejects.toThrow('synthetic rollback crash'); } finally { fault.mockRestore(); }
  expect(filePinReceipts()[0]!.state).toBe('pending_rollback');
  const write = spyOn(atomic, 'atomicWriteFileSync');
  try { expect((await rollbackFilePins(r.id, p.plan_hash)).state).toBe('rolled_back'); expect(write.mock.calls.filter(c => c[0] === file)).toHaveLength(0); }
  finally { write.mockRestore(); }
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(config);
});
test('staging-time drift leaves the other writer bytes and a pending receipt intact', async () => {
  const p = previewFilePins(target), original = atomic.atomicWriteFileSync, concurrent = JSON.stringify({ ...config, writer: 'synthetic other owner' });
  const fault = spyOn(atomic, 'atomicWriteFileSync').mockImplementation((path, content, opts) => original(path, content,
    path === file ? { ...opts, afterStagingFlush: () => writeFileSync(file, concurrent) } : opts));
  try { await expect(applyFilePins(target, p.plan_hash)).rejects.toThrow('configuration_changed'); } finally { fault.mockRestore(); }
  expect(readFileSync(file, 'utf8')).toBe(concurrent); expect(filePinReceipts()[0]!.state).toBe('pending_apply');
  await expect(applyFilePins(target, p.plan_hash)).rejects.toThrow('configuration_changed');
});
test('native ownership prevents competing migration writers', async () => {
  const p = previewFilePins(target), claim = await acquireNativeLock(join(dir, 'writer.lock'), { timeoutMs: 0 });
  expect(claim).toBeTruthy();
  try { await expect(applyFilePins(target, p.plan_hash)).rejects.toThrow('migration_busy'); }
  finally { await claim!.release(); }
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(config);
});
test('CLI file preview cannot connect a database or start inference', async () => {
  const connectEngine = () => { throw new Error('forbidden connection'); }, written: string[] = [];
  const spy = spyOn(output, 'writeStdoutFinal').mockImplementation(async text => { written.push(text); });
  try { await run(['pins','preview','--plane','file','--model',target,'--json'], { connectEngine } as unknown as CliDispatchContext); }
  finally { spy.mockRestore(); }
  expect(JSON.parse(written.join('')).plane).toBe('file'); expect(existsSync(dir)).toBe(false);
});
test('invalid or unconfirmed CLI mutations refuse before a database connection', async () => {
  let connections = 0;
  const ctx = { connectEngine: () => { connections++; throw new Error('forbidden connection'); } } as unknown as CliDispatchContext;
  for (const args of [
    ['pins','apply','--plane','database','--model',target,'--expect','a'.repeat(64)],
    ['pins','preview','--plane','database','--model','openai:fixture'],
    ['pins','rollback','--plane','database','--id','bad-id','--expect','a'.repeat(64),'--yes'],
    ['pins','receipts','--plane','database','--model',target],
  ]) await expect(run(args, ctx)).rejects.toThrow('Codex pin migration refused');
  expect(connections).toBe(0); expect(existsSync(dir)).toBe(false);
});
