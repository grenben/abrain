import { createHash } from 'node:crypto';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { afterAll, describe, expect, test } from 'bun:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexProposal } from '../../src/core/ai/providers/codex-proposal.ts';

const root = await mkdtemp(join(tmpdir(), 'codex-proposal-test-'));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const env = { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: root, OPENAI_API_KEY: 'synthetic-tripwire', ANTHROPIC_API_KEY: 'synthetic-tripwire' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
let sequence = 0;
async function fake(mode: string): Promise<{ bin: string; capture: string }> {
  const bin = join(root, `codex-${mode}-${sequence++}.mjs`);
  const capture = `${bin}.json`;
  const script = `#!${Bun.which('node')}
import { readFileSync, writeFileSync, writeSync, statSync } from 'node:fs';
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
const prompt = readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args,prompt,pid:process.pid,cwd:process.cwd(),env:process.env,schema:JSON.parse(readFileSync(arg('--output-schema'),'utf8')),schemaMode:statSync(arg('--output-schema')).mode & 511,dirMode:statSync(process.cwd()).mode & 511,image:args.includes('--image')?Array.from(readFileSync(arg('--image'))):null}));
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
    for (const flag of ['--output-schema', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config', 'read-only', 'forced_login_method="chatgpt"', 'web_search="disabled"', 'features.shell_tool=false']) expect(seen.args).toContain(flag);
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
  test('unqualified or modified executables never dispatch', async () => {
    const {bin,capture}=await fake('tampered'); await writeFile(bin,'#!/bin/sh\nexit 0\n');
    await expect(runCodexProposal(input(bin))).rejects.toMatchObject({reason:'runtime_unqualified'});
    await expect(access(capture)).rejects.toThrow();
    await expect(runCodexProposal(input('/synthetic/unqualified-codex'))).rejects.toMatchObject({reason:'runtime_unqualified'});
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
