/** Real subprocess-boundary regressions for cleanup and the managed CLI SIGINT bridge. */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-pg-signal-'));
  roots.push(dir);
  return dir;
}

function launch(script: string): ChildProcess {
  return spawn(process.execPath, ['-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
}

async function waitFor(path: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    if (child.exitCode !== null) throw new Error(`helper exited before readiness (${child.exitCode})`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('helper readiness handshake timed out');
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

describe.serial('managed PostgreSQL signal teardown boundary', () => {
  it('awaits process-group teardown before unwinding the lifecycle lock on SIGTERM cleanup', async () => {
    const dir = root(), ready = join(dir, 'ready'), abortStarted = join(dir, 'abort-started'), marker = join(dir, 'delayed-marker'), lockReleased = join(dir, 'lock-released'), continued = join(dir, 'continued');
    const processModule = join(process.cwd(), 'src/core/managed-postgres/process.ts');
    const cleanupModule = join(process.cwd(), 'src/core/process-cleanup.ts');
    const ownershipModule = join(process.cwd(), 'src/core/managed-postgres/ownership.ts');
    const configDir = join(dir, 'config');
    mkdirSync(configDir, { mode: 0o700 });
    const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),2200);setInterval(()=>{},1000)`;
    const leader = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`;
    const script = `
      const {spawn}=require('node:child_process');
      const fs=require('node:fs');
      const {pathToFileURL}=require('node:url');
      Promise.all([import(pathToFileURL(${JSON.stringify(cleanupModule)})),import(pathToFileURL(${JSON.stringify(processModule)})),import(pathToFileURL(${JSON.stringify(ownershipModule)}))]).then(async ([cleanup,proc,ownership])=>{
        cleanup.installSignalHandlers();
        const paths=ownership.managedPaths(${JSON.stringify(configDir)});
        ownership.ensurePrivateDir(paths.root);
        const release=ownership.acquireLifecycleLock(paths);
        const controller=new AbortController();
        const pending=proc.runProcess(process.execPath,['-e',${JSON.stringify(leader)}],{timeoutMs:6000,signal:controller.signal});
        const readyDeadline=Date.now()+8000;
        while(!fs.existsSync(${JSON.stringify(ready)})&&Date.now()<readyDeadline) await new Promise(r=>setTimeout(r,20));
        if(!fs.existsSync(${JSON.stringify(ready)})) throw Error('child readiness timeout');
        controller.abort();
        fs.writeFileSync(${JSON.stringify(abortStarted)},'pending');
        let cancelled=false;
        try { await pending; }
        catch(e) { if(e.name!=='ProcessCancelledError') throw e; cancelled=true; }
        finally { release(); fs.writeFileSync(${JSON.stringify(lockReleased)},String(fs.existsSync(paths.lock))); }
        if(!cancelled) fs.writeFileSync(${JSON.stringify(continued)},'bad');
      }).catch(e=>{console.error(e);process.exit(9)});
    `;
    const child = launch(script);
    const exit = exited(child);
    await waitFor(ready, child);
    await waitFor(abortStarted, child);
    child.kill('SIGTERM');
    expect(await exit).toBe(143);
    expect(existsSync(lockReleased)).toBe(true);
    expect(readFileSync(lockReleased, 'utf8')).toBe('false');
    expect(existsSync(continued)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 2300));
    expect(existsSync(marker)).toBe(false);
    expect(processExists(Number(readFileSync(ready, 'utf8')))).toBe(false);
  });

  it('turns real CLI SIGINT into cancellation JSON and waits out the child group', async () => {
    const dir = root(), ready = join(dir, 'ready'), marker = join(dir, 'delayed-marker');
    const processModule = join(process.cwd(), 'src/core/managed-postgres/process.ts');
    const cliModule = join(process.cwd(), 'src/cli/commands/postgres.ts');
    const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),1600);setInterval(()=>{},1000)`;
    const script = `
      const {pathToFileURL}=require('node:url');
      Promise.all([import(pathToFileURL(${JSON.stringify(cliModule)})),import(pathToFileURL(${JSON.stringify(processModule)}))]).then(async ([cli,proc])=>{
        const pending=cli.runManagedPostgresCli(['start','--json'],{
          planProvision:async()=>{throw Error('unused')},provision:async()=>{throw Error('unused')},status:async()=>{throw Error('unused')},stop:async()=>{throw Error('unused')},
          start:async context=>{await proc.runProcess(process.execPath,['-e',${JSON.stringify(descendant)}],{timeoutMs:6000,signal:context.signal});return {classification:'ready'};}
        });
        const fs=require('node:fs');
        const deadline=Date.now()+8000; while(!fs.existsSync(${JSON.stringify(ready)})&&Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
        if(!fs.existsSync(${JSON.stringify(ready)})) throw Error('readiness timeout');
        process.send?.('ready');
        const code=await pending; process.exitCode=code;
      }).catch(e=>{console.error(e);process.exit(9)});
    `;
    const child = launch(script);
    let stdout = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    const exit = exited(child);
    await waitFor(ready, child);
    child.kill('SIGINT');
    expect(await exit).not.toBe(0);
    expect(stdout).toContain('"reason":"cancelled"');
    expect(stdout).toContain('"status":"error"');
    await new Promise(resolve => setTimeout(resolve, 1900));
    expect(existsSync(marker)).toBe(false);
    expect(processExists(Number(readFileSync(ready, 'utf8')))).toBe(false);
  });
});
