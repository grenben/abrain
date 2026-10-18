import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { __assertCodexHostBoundaryForTests, __registerCodexFixtureForTests, assertCodexNamespaceAvailable, assertTrustedCodexExecutable, openQualifiedCodexRuntime } from '../../src/core/ai/providers/codex-qualification.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { access, chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexProposal } from '../../src/core/ai/providers/codex-proposal.ts';
import { codexEnvironment, runCodexProcess } from '../../src/core/ai/providers/codex-process.ts';

const root = await mkdtemp(join(tmpdir(), 'codex-proposal-test-'));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const env = { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: root, OPENAI_API_KEY: 'synthetic-tripwire', ANTHROPIC_API_KEY: 'synthetic-tripwire' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgUbL4DwACCgFmeGgpMwAAAABJRU5ErkJggg==', 'base64');
let sequence = 0;
async function fake(mode: string): Promise<{ bin: string; capture: string }> {
  const bin = join(root, `codex-${mode}-${sequence++}.mjs`);
  const capture = `${bin}.json`;
  const script = `#!${Bun.which('node')}
import { readFileSync, writeFileSync, writeSync, statSync } from 'node:fs';
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
const catalogSetting = args.find(value => value.startsWith('model_catalog_json='));
const catalogPath = JSON.parse(catalogSetting.slice('model_catalog_json='.length));
const prompt = readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args,prompt,pid:process.pid,cwd:process.cwd(),env:process.env,schema:JSON.parse(readFileSync(arg('--output-schema'),'utf8')),schemaMode:statSync(arg('--output-schema')).mode & 511,catalog:JSON.parse(readFileSync(catalogPath,'utf8')),catalogMode:statSync(catalogPath).mode & 511,rootMarkerMode:statSync('.gbrain-codex-root').mode & 511,dirMode:statSync(process.cwd()).mode & 511,image:args.includes('--image')?Array.from(readFileSync(arg('--image'))):null}));
const mode = ${JSON.stringify(mode)};
const emit = event => { const line = JSON.stringify(event)+'\\n'; for (let i=0;i<line.length;i+=3) writeSync(1,line.slice(i,i+3)); };
if (mode === 'exit') { writeSync(2,'synthetic secret provider error'); process.exit(7); }
if (mode === 'timeout' || mode === 'abort') { process.on('SIGTERM',()=>{}); await new Promise(r=>setTimeout(r,30000)); }
if (mode === 'overflow') { writeSync(2,'x'.repeat(4096)); process.exit(0); }
emit({type:'thread.started',thread_id:'synthetic'}); emit({type:'turn.started'});
if (mode === 'missing') process.exit(0);
if (mode === 'malformed') { writeSync(1,'{bad\\n'); process.exit(0); }
if (mode === 'refusal') { emit({type:'item.completed',item:{type:'refusal'}}); process.exit(0); }
if (mode === 'native') { emit({type:'item.started',item:{type:'command_execution',command:'forbidden'}}); process.exit(0); }
if (mode === 'provider') { emit({type:'turn.failed',error:{message:'synthetic private details'}}); process.exit(0); }
const text = mode === 'bad-output' ? '{"answer":42}' : mode === 'extra' ? '{"answer":"ok","extra":true}' : '{"answer":"ok"}';
writeFileSync(arg('--output-last-message'),mode==='mismatch' ? '{"answer":"other"}' : text);
emit({type:'item.completed',item:{type:'agent_message',text}});
emit({type:'turn.completed',usage:{input_tokens:11,cached_input_tokens:3,output_tokens:7}});
if (mode === 'trailing') emit({type:'turn.started'});
`;
  await writeFile(bin, script, { mode: 0o700 });
  __registerCodexFixtureForTests(bin,createHash('sha256').update(script).digest('hex'));
  return { bin, capture };
}
const input = (bin: string) => ({ bin, model: 'gpt-test', prompt: 'synthetic only', schema, env });

describe('Codex proposal production transport with fake executable', () => {
  test('transports the real schema/image, stdin, filtered env, private files and isolation flags', async () => {
    const { bin, capture } = await fake('good');
    const result = await runCodexProposal({ ...input(bin), images: [{ mime: 'image/png', bytes: png }] });
    expect(result.value).toEqual({ answer: 'ok' });
    expect(result.usage).toEqual({ inputTokens: 11, cachedInputTokens: 3, outputTokens: 7 });
    expect(result.billing).toEqual({ kind: 'subscription', costUsd: null, remainingQuota: null });
    const seen = JSON.parse(await readFile(capture, 'utf8'));
    expect(seen.prompt).toBe('synthetic only'); expect(seen.schema).toEqual(schema);
    expect(seen.image).toEqual(Array.from(png)); expect(seen.schemaMode).toBe(0o600); expect(seen.dirMode).toBe(0o700);
    expect(seen.catalogMode).toBe(0o600); expect(seen.rootMarkerMode).toBe(0o600);
    expect(seen.catalog.models).toHaveLength(1);
    expect(seen.catalog.models[0]).toMatchObject({ slug: 'gpt-test', shell_type: 'disabled', tool_mode: 'direct',
      apply_patch_tool_type: null, experimental_supported_tools: [], supports_search_tool: false });
    expect(seen.args.some((arg: string) => arg.startsWith('model_catalog_json='))).toBe(true);
    expect(seen.args).toContain('project_root_markers=[".gbrain-codex-root"]');
    for (const flag of ['--output-schema', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config', 'read-only', 'forced_login_method="chatgpt"', 'web_search="disabled"', 'features.shell_tool=false', 'features.goals=false', 'tools.experimental_request_user_input.enabled=false', 'features.hooks=true', 'suppress_unstable_features_warning=true']) expect(seen.args).toContain(flag);
    expect(seen.args).not.toContain('features.codex_hooks=true');
    expect(seen.args).not.toContain('features.memory_tool=false');
    expect(seen.args.at(-1)).toBe('-'); expect(seen.args).not.toContain('synthetic only');
    expect(seen.env).not.toHaveProperty('OPENAI_API_KEY'); expect(seen.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(seen.env.CODEX_HOME).toBe(root);
    await expect(access(seen.cwd)).rejects.toThrow();
  });
  test.each([['exit', 'exit'], ['missing', 'missing_completion'], ['malformed', 'malformed_lifecycle'], ['refusal', 'refusal'], ['native', 'native_action'], ['provider', 'provider_failure'], ['bad-output', 'invalid_output'], ['extra', 'invalid_output'], ['mismatch', 'invalid_output'], ['trailing', 'malformed_lifecycle']])('%s remains a sanitized typed failure', async (mode, reason) => {
    const { bin } = await fake(mode);
    try { await runCodexProposal(input(bin)); throw new Error('expected rejection'); }
    catch (error) { expect(error).toMatchObject({ reason, settled: true }); expect(String(error)).not.toContain('synthetic private'); }
  });
  test('rejects unsupported schemas, invalid images, relative binaries and pre-abort before dispatch', async () => {
    const { bin, capture } = await fake('guard');
    await expect(runCodexProposal({ ...input(bin), schema: { ...schema, oneOf: [] } })).rejects.toMatchObject({ reason: 'unsupported_schema' });
    await expect(runCodexProposal({ ...input(bin), images: [{ mime: 'image/png', bytes: Uint8Array.from([1,2,3,4]) }] })).rejects.toMatchObject({ reason: 'invalid_input' });
    await expect(runCodexProposal({ ...input(bin), bin: 'codex' })).rejects.toMatchObject({ reason: 'invalid_input' });
    await expect(runCodexProposal({ ...input(bin), signal: AbortSignal.abort() })).rejects.toMatchObject({ reason: 'aborted' });
    await expect(access(capture)).rejects.toThrow();
  });
  test('bounds output including stderr', async () => {
    const { bin } = await fake('overflow');
    await expect(runCodexProposal({ ...input(bin), maxOutputBytes: 1024 })).rejects.toMatchObject({ reason: 'output_limit' });
  });
  test('timeout kills a TERM-resistant child before removing resources', async () => {
    const { bin, capture } = await fake('timeout');
    await expect(runCodexProposal({ ...input(bin), timeoutMs: 500 })).rejects.toMatchObject({ reason: 'timeout', settled: true });
    const seen = JSON.parse(await readFile(capture, 'utf8'));
    expect(() => process.kill(seen.pid, 0)).toThrow(); await expect(access(seen.cwd)).rejects.toThrow();
  });
  test('abort settles an active child', async () => {
    const { bin } = await fake('abort');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 500);
    try { await expect(runCodexProposal({ ...input(bin), signal: controller.signal })).rejects.toMatchObject({ reason: 'aborted', settled: true }); }
    finally { clearTimeout(timer); }
  });
  test('PID namespace teardown settles a detached descendant', async () => {
    if (process.platform !== 'linux') return;
    const probe = spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '--pid', '--fork',
      '--kill-child', '--mount-proc', '/bin/true'], { stdio: 'ignore', timeout: 2_000 });
    if (probe.status !== 0) return; // Unsupported hosts cannot admit the production runtime.
    const bin = join(root, `codex-pidns-${sequence++}.sh`);
    const beat = `${bin}.heartbeat`;
    const script = `#!/bin/sh
setsid sh -c 'i=0; while [ "$i" -lt 40 ]; do printf x >> "$1"; i=$((i+1)); sleep 0.05; done' sh "$1" >/dev/null 2>&1 &
cat >/dev/null
sleep 3
`;
    await writeFile(bin, script, { mode: 0o700 });
    const runtime = await open(bin, 'r');
    try {
      const controller = new AbortController();
      const running = runCodexProcess({ runtimeFd: runtime.fd, args: [beat], cwd: root,
        env: codexEnvironment(env), prompt: 'synthetic', signal: controller.signal,
        timeoutMs: 5_000, maxOutputBytes: 1024, isolation: 'pid-namespace' });
      void running.catch(() => {});
      let started = false;
      for (let i = 0; i < 150; i++) {
        try { if ((await stat(beat)).size > 0) { started = true; break; } } catch { /* startup */ }
        await Bun.sleep(20);
      }
      controller.abort();
      await expect(running).rejects.toMatchObject({ reason: 'aborted', settled: true });
      expect(started).toBe(true);
      const before = (await stat(beat)).size;
      await Bun.sleep(250);
      const after = (await stat(beat)).size;
      if (after !== before) await Bun.sleep(3_000); // Let a broken bounded fixture end before cleanup.
      expect(after).toBe(before);
    } finally { await runtime.close(); }
  });
  test('unqualified or modified executables never dispatch', async () => {
    const {bin,capture}=await fake('tampered'); await writeFile(bin,'#!/bin/sh\nexit 0\n');
    await expect(runCodexProposal(input(bin))).rejects.toMatchObject({reason:'runtime_unqualified'});
    await expect(access(capture)).rejects.toThrow();
    await expect(runCodexProposal(input('/synthetic/unqualified-codex'))).rejects.toMatchObject({reason:'runtime_unqualified'});
  });
  test('production host boundary refuses inherited managed configuration and mutable parents', async () => {
    const hostRoot = join(root, `codex-host-boundary-${sequence++}`);
    const etc = join(hostRoot, 'etc');
    await mkdir(etc, { recursive: true });
    const binDir = join(hostRoot, 'usr', 'bin');
    await mkdir(binDir, { recursive: true });
    const unshare = join(binDir, 'unshare');
    await writeFile(unshare, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const proof = join(binDir, 'true');
    await writeFile(proof, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await chmod(hostRoot, 0o755); await chmod(etc, 0o755);
    await chmod(join(hostRoot, 'usr'), 0o755); await chmod(binDir, 0o755);
    const trustedUid = (await stat(hostRoot)).uid;
    const callerUid = trustedUid + 1;
    const trustedFile = await stat(unshare);
    expect(() => assertTrustedCodexExecutable(trustedFile, trustedUid)).not.toThrow();
    expect(() => assertTrustedCodexExecutable(trustedFile, callerUid)).toThrow();
    await chmod(unshare, 0o777);
    const mutableFile = await stat(unshare);
    expect(() => assertTrustedCodexExecutable(mutableFile, trustedUid)).toThrow();
    await chmod(unshare, 0o755);
    expect(() => assertCodexNamespaceAvailable(unshare, proof)).not.toThrow();
    await writeFile(unshare, '#!/bin/sh\nexit 1\n');
    expect(() => assertCodexNamespaceAvailable(unshare, proof)).toThrow();
    await writeFile(unshare, '#!/bin/sh\nexit 0\n');
    await expect(__assertCodexHostBoundaryForTests(hostRoot, trustedUid, callerUid)).resolves.toBeUndefined();
    await expect(__assertCodexHostBoundaryForTests(hostRoot, trustedUid + 2, callerUid)).rejects.toThrow();
    await mkdir(join(etc, 'codex'));
    await expect(__assertCodexHostBoundaryForTests(hostRoot, trustedUid, callerUid)).rejects.toThrow();
    await rm(join(etc, 'codex'), { recursive: true });
    await symlink('missing-codex', join(etc, 'codex'));
    await expect(__assertCodexHostBoundaryForTests(hostRoot, trustedUid, callerUid)).rejects.toThrow();
    await rm(join(etc, 'codex'));
    await chmod(etc, 0o777);
    await expect(__assertCodexHostBoundaryForTests(hostRoot, trustedUid, callerUid)).rejects.toThrow();
    await chmod(etc, 0o755);
    await chmod(unshare, 0o777);
    await expect(__assertCodexHostBoundaryForTests(hostRoot, trustedUid, callerUid)).rejects.toThrow();
    await chmod(unshare, 0o755);
    await chmod(proof, 0o777);
    await expect(__assertCodexHostBoundaryForTests(hostRoot, trustedUid, callerUid)).rejects.toThrow();
    await chmod(proof, 0o755);
    await expect(__assertCodexHostBoundaryForTests(hostRoot, trustedUid, trustedUid)).rejects.toThrow();
    const symlinkRoot = join(root, `codex-host-link-${sequence++}`);
    await mkdir(join(symlinkRoot, 'usr', 'bin'), { recursive: true });
    await writeFile(join(symlinkRoot, 'usr', 'bin', 'unshare'), '', { mode: 0o755 });
    await writeFile(join(symlinkRoot, 'usr', 'bin', 'true'), '', { mode: 0o755 });
    await chmod(symlinkRoot, 0o755);
    await chmod(join(symlinkRoot, 'usr'), 0o755);
    await chmod(join(symlinkRoot, 'usr', 'bin'), 0o755);
    await symlink(etc, join(symlinkRoot, 'etc'));
    await expect(__assertCodexHostBoundaryForTests(symlinkRoot, trustedUid, callerUid)).rejects.toThrow();
  });
  test('a path replacement after qualification cannot change the spawned executable', async () => {
    if (process.platform !== 'linux') return;
    const bin = join(root, `codex-pin-${sequence++}`);
    const original = '#!/bin/sh\nprintf "pinned-original\\n"\n';
    await writeFile(bin, original, { mode: 0o700 });
    const unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(original).digest('hex'));
    const runtime = await openQualifiedCodexRuntime(bin);
    try {
      await rename(bin, `${bin}.old`);
      await writeFile(bin, '#!/bin/sh\nprintf "replacement\\n"\n', { mode: 0o700 });
      expect(await runCodexProcess({ runtimeFd: runtime.file.fd, args: [], cwd: root, env: codexEnvironment(env),
        prompt: 'synthetic', timeoutMs: 5_000, maxOutputBytes: 1024 })).toBe('pinned-original\n');
    } finally { await runtime.file.close(); unregister(); }
  });
  test('unconfirmed group termination retains scratch and an unresolved outcome', async () => {
    const {bin,capture}=await fake('unconfirmed');
    const originalKill=process.kill;
    process.kill=((pid:number,signal?:string|number)=>{
      if(pid<0 && signal===0) throw Object.assign(new Error('synthetic denial'),{code:'EPERM'});
      return originalKill(pid,signal as NodeJS.Signals);
    }) as typeof process.kill;
    try { await expect(runCodexProposal(input(bin))).rejects.toMatchObject({reason:'termination_unconfirmed',settled:false}); }
    finally { process.kill=originalKill; }
    const seen=JSON.parse(await readFile(capture,'utf8'));
    await access(seen.cwd);expect(()=>process.kill(seen.pid,0)).toThrow();
    await rm(seen.cwd,{recursive:true,force:true});
  });

});
