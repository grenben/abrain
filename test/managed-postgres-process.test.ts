/**
 * Protects the subprocess boundary: explicit environment allowlisting, bounded output,
 * and timeout/cancellation process-group teardown with direct-child reaping.
 * Regressions leak ambient credentials, leave descendants running, or settle before close.
 * Uses local child processes only; it never invokes PostgreSQL or Homebrew.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _registeredCleanupCountForTests } from '../src/core/process-cleanup.ts';
import { createProcessRunner, ProcessCancelledError, ProcessTerminationUnconfirmedError, runProcess } from '../src/core/managed-postgres/process.ts';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-pg-process-'));
  temporaryDirectories.push(dir);
  return dir;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('child readiness handshake timed out');
}

describe('managed PostgreSQL subprocess adapter', () => {
  it('refuses a pre-aborted run without spawning a child', async () => {
    const marker = join(tempDir(), 'spawned');
    const controller = new AbortController();
    controller.abort();
    await expect(runProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`], { signal: controller.signal }))
      .rejects.toBeInstanceOf(ProcessCancelledError);
    expect(existsSync(marker)).toBe(false);
  });

  it('allows only caller-supplied safe variables and strips ambient PG/Homebrew variables', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      timeoutMs: 3000,
      env: {
        PATH: process.env.PATH, HOME: '/caller/home', PGPASSFILE: '/caller/passfile', PGREQUIREAUTH: '1',
        HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: '1',
        PGHOST: 'foreign.invalid', PGPASSWORD: 'do-not-inherit', HOMEBREW_NO_ANALYTICS: '1',
      },
    });
    const env = JSON.parse(result.stdout.toString()) as NodeJS.ProcessEnv;
    expect(env).toMatchObject({
      PATH: process.env.PATH, HOME: '/caller/home', PGPASSFILE: '/caller/passfile', PGREQUIREAUTH: '1',
      HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: '1',
    });
    expect(env.PGHOST).toBeUndefined();
    expect(env.PGPASSWORD).toBeUndefined();
    expect(env.HOMEBREW_NO_ANALYTICS).toBeUndefined();
  });

  it('does not inherit caller-process credentials when no environment is supplied', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({pass:process.env.PGPASSFILE, host:process.env.PGHOST, home:process.env.HOME}))'], { timeoutMs: 3000 });
    expect(JSON.parse(result.stdout.toString())).toEqual({ pass: undefined, host: undefined, home: undefined });
  });

  it('caps captured bytes without exposing omitted output', async () => {
    const result = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(20000))"], { timeoutMs: 3000, outputLimit: 2048 });
    expect(result.stdout.length).toBe(2048);
    expect(result.truncated).toBe(true);
  });

  it('preserves timeout result semantics and kills/reaps the child', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it('aborts a ready child and stubborn descendant without allowing delayed work', async () => {
    const dir = tempDir(), ready = join(dir, 'ready'), marker = join(dir, 'descendant-marker');
    const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),1800);setInterval(()=>{},1000)`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const controller = new AbortController();
    const registeredBefore = _registeredCleanupCountForTests();
    const pending = runProcess(process.execPath, ['-e', parent], { timeoutMs: 5000, signal: controller.signal });
    await waitForFile(ready);
    expect(_registeredCleanupCountForTests()).toBe(registeredBefore + 1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'ProcessCancelledError', code: 'PROCESS_CANCELLED' });
    expect(_registeredCleanupCountForTests()).toBe(registeredBefore);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(existsSync(marker)).toBe(false);
  });

  it('settles once when abort races timeout and still tears down the process tree', async () => {
    const dir = tempDir(), ready = join(dir, 'ready'), marker = join(dir, 'marker');
    const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),1800);setInterval(()=>{},1000)`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const controller = new AbortController();
    let settlements = 0;
    const pending = runProcess(process.execPath, ['-e', parent], { timeoutMs: 300, signal: controller.signal })
      .then((value) => { settlements++; return value; }, (error) => { settlements++; throw error; });
    await waitForFile(ready);
    setTimeout(() => controller.abort(), 300);
    const outcome = await Promise.allSettled([pending]);
    expect(outcome).toHaveLength(1);
    expect(settlements).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(existsSync(marker)).toBe(false);
  });

  it('classifies an unconfirmed group teardown only after escalation and retains cleanup registration', async () => {
    const dir = tempDir(), ready = join(dir, 'ready'), continuation = join(dir, 'continued');
    const runner = createProcessRunner({ groupExists: () => true });
    const controller = new AbortController();
    const registeredBefore = _registeredCleanupCountForTests();
    const leader = `process.on('SIGTERM',()=>process.exit(0));require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`;
    const pending = runner(process.execPath, ['-e', leader], { timeoutMs: 5000, signal: controller.signal })
      .then(result => { require('node:fs').writeFileSync(continuation, 'ordinary result'); return result; });
    await waitForFile(ready);
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 1_150));
    expect(_registeredCleanupCountForTests()).toBe(registeredBefore + 1);
    await expect(pending).rejects.toBeInstanceOf(ProcessTerminationUnconfirmedError);
    expect(_registeredCleanupCountForTests()).toBe(registeredBefore);
    expect(existsSync(continuation)).toBe(false);
  });

  it('ignores abort after the child has closed', async () => {
    const controller = new AbortController();
    const result = await runProcess(process.execPath, ['-e', "process.stdout.write('done')"], { signal: controller.signal });
    controller.abort();
    expect(result.stdout.toString()).toBe('done');
    expect(result.timedOut).toBe(false);
  });
});
