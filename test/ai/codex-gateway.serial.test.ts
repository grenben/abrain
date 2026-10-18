import { beforeAll, afterAll, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { chat, expand, generateOcrText, configureGateway, resetGateway, withBudgetTracker } from '../../src/core/ai/gateway.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription } from '../../src/core/ai/subscription-context.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { BudgetTracker } from '../../src/core/budget/budget-tracker.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { resetDecideSearchCache } from '../../src/core/search/decide-stage.ts';
import { flushDecideWrites } from '../../src/core/ai/decide/store.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { runDecide } from '../../src/core/ai/decide/index.ts';
import { readDecideConfig } from '../../src/core/ai/decide/config.ts';
import { llmCapability } from '../../src/core/ai/decide/providers/llm-structured.ts';
import { PNG_PIXEL, JPEG_PIXELS, WEBP_PIXELS, syntheticPng } from '../helpers/codex-image-fixtures.ts';
const root=mkdtempSync(join(tmpdir(),'codex-gateway-')); const bin=join(root,'fixture.mjs'), capture=join(root,'capture.jsonl');
const saved=Object.fromEntries(['GBRAIN_HOME','HOME','CODEX_HOME'].map(k=>[k,process.env[k]]));
const originalFetch=globalThis.fetch;
let engine: PGLiteEngine;
let unregister:()=>void;
let seq=0;
const withRun = async <T>(run:()=>Promise<T>,maxAttempts=5) => {
  const runId=`gateway-${seq++}`;
  await createSubscriptionRun(engine,{runId,accountLane:'fixture-account',maxAttempts,maxTurns:maxAttempts,deadline:new Date(Date.now()+600_000)});
  return withCodexSubscription({engine,runId},run);
};
beforeAll(async()=>{
  engine=new PGLiteEngine();
  process.env.GBRAIN_HOME=root;process.env.HOME=root;process.env.CODEX_HOME=root;
  globalThis.fetch=(()=>{throw new Error('forbidden network');}) as unknown as typeof fetch;
  mkdirSync(join(root,'.gbrain'));
  writeFileSync(join(root,'.gbrain','config.json'),JSON.stringify({embedding_disabled:true,private_codex:{mode:'strict',model:'codex-cli:gpt-test',bin}}));
  const script=`#!${Bun.which('node')}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1];
const schema=JSON.parse(readFileSync(arg('--output-schema'),'utf8')),prompt=readFileSync(0,'utf8');
appendFileSync(${JSON.stringify(capture)},JSON.stringify({args,schema,prompt})+'\\n');
if(prompt.includes('hold-first'))await new Promise(resolve=>setTimeout(resolve,200));
const answers={};if(schema.properties.answers)for(const [id,shape] of Object.entries(schema.properties.answers.properties)){
  const p=shape.properties;if(p.noul)answers[id]={type:'noul',noul:0.7};
  else if(p.choice)answers[id]={type:'choice',choice:p.choice.enum[0],confidence:0.8,probabilities:Object.fromEntries(Object.keys(p.probabilities.properties).map((k,i)=>[k,i===0?0.8:0.2]))};
  else answers[id]={type:'score',score:0,confidence:0.8,probabilities:Object.fromEntries(Object.keys(p.probabilities.properties).map((k,i)=>[k,i===0?0.8:0.2]))};
}
const value=schema.properties.answers?{answers}:schema.properties.queries?{queries:[]}:schema.properties.answer?{answer:'bounded'}:{text:''};
const text=JSON.stringify(value);writeFileSync(arg('--output-last-message'),text);
for(const event of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:2,output_tokens:3}}])console.log(JSON.stringify(event));
`;
  writeFileSync(bin,script,{mode:0o700});unregister=__registerCodexFixtureForTests(bin,createHash('sha256').update(script).digest('hex'));
  await engine.connect({database_url:''});await engine.initSchema();configureGateway({env:{},embedding_model:'openai:text-embedding-3-small'});
  await engine.putPage('notes/decision',{type:'note',title:'Decision',compiled_truth:'alpha keyword decision'});
  await installFixtureChunks(engine,'notes/decision',[{chunk_index:0,chunk_text:'alpha keyword decision',chunk_source:'compiled_truth'}]);
});
afterAll(async()=>{
  await engine.disconnect();unregister?.();globalThis.fetch=originalFetch;
  for(const [k,v] of Object.entries(saved)) if(v===undefined) delete process.env[k];else process.env[k]=v;
  resetGateway();rmSync(root,{recursive:true,force:true});
});
test('USD-only admission never starts unpriced inference',async()=>{
  await expect(chat({messages:[{role:'user',content:'synthetic'}]})).rejects.toMatchObject({code:'subscription_required'});
});
test('gateway transports caller schema to the real adapter and retains unknown monetary cost',async()=>{
  const schema={type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false};
  const tracker=new BudgetTracker({maxCostUsd:0.001,capSource:'user',label:'fixture'});
  const result=await withRun(()=>withBudgetTracker(tracker,()=>chat({messages:[{role:'user',content:'synthetic'}],responseSchema:{name:'fixture',schema}})));
  expect(JSON.parse(result.text)).toEqual({answer:'bounded'});expect(result.providerMetadata?.billing.costUsd).toBeNull();
  const lines=readFileSync(capture,'utf8').trim().split('\n').map(s=>JSON.parse(s));expect(lines.at(-1).schema).toEqual(schema);
  const snapshot=tracker.snapshot();expect(snapshot.models[0]?.cost_usd).toBeNull();
  // The independently metered auxiliary request still cannot exceed the USD cap.
  try { tracker.reserve({modelId:'openai:text-embedding-3-small',kind:'embed',estimatedInputTokens:1_000_000,maxOutputTokens:0}); throw new Error('expected cap'); }
  catch(error) { expect(error).toMatchObject({reason:'cost'}); }
});
test('private typed decisions use exact Codex schema, model identity and host admission',async()=>{
  expect(llmCapability('llm:codex-cli:gpt-test')).toBe('structured');
  const config=readDecideConfig({'decide.provider':'llm:codex-cli:gpt-test'});
  const request={slot:'intent' as const,callSite:'search',state:{query:{class:'query' as const,text:'synthetic'}},
    questions:[{id:'n',kind:'noul' as const,instructions:'Check.'},{id:'c',kind:'choice' as const,instructions:'Pick.',options:{yes:'Yes',no:'No'}},
      {id:'s',kind:'score' as const,instructions:'Score.',levels:['low','high']}],deadlineMs:20_000};
  const before=readFileSync(capture,'utf8').trim().split('\n').length;
  await expect(runDecide(request,{engine:null,config})).rejects.toMatchObject({code:'subscription_required'});
  expect(readFileSync(capture,'utf8').trim().split('\n')).toHaveLength(before);
  const result=await withRun(()=>runDecide(request,{engine:null,config}),2);
  expect(result.provider).toBe('llm:codex-cli:gpt-test');expect(result.model_resolved).toBe('codex-cli:gpt-test');
  expect(result.answers.n).toEqual({kind:'noul',p:0.7});expect(result.answers.c?.kind).toBe('choice');
  expect(result.answers.s?.kind).toBe('score');expect(result.uncalibrated).toBe(true);
  const last=JSON.parse(readFileSync(capture,'utf8').trim().split('\n').at(-1)!);
  expect(Object.keys(last.schema.properties.answers.properties).sort()).toEqual(['c','n','s']);
  expect(last.schema.properties.answers.additionalProperties).toBe(false);
  expect([...last.schema.properties.answers.required].sort()).toEqual(['c','n','s']);
});
test('parallel chat requests share one accepted-turn lane, and a queued abort never dispatches',async()=>{
  const count=()=>existsSync(capture)?readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).length:0;
  const before=count();
  await withRun(async()=>{
    const results=await Promise.all(['one','two'].map(content=>chat({messages:[{role:'user',content}]})));
    expect(results.map(result=>result.text)).toEqual(['','']);
  },2);
  expect(count()).toBe(before+2);
  await withRun(async()=>{
    const first=chat({messages:[{role:'user',content:'hold-first'}]});
    const abort=new AbortController();
    const queued=chat({messages:[{role:'user',content:'queued-abort'}],abortSignal:abort.signal});
    setTimeout(()=>abort.abort(),20);
    await expect(queued).rejects.toMatchObject({reason:'aborted'});
    await first;
  },2);
  expect(count()).toBe(before+3);
});
test('standalone private search records its Codex decision without a paid provider',async()=>{
  const keys={'decide.provider':'llm:codex-cli:gpt-test','decide.slots.intent.mode':'on','decide.slots.intent.threshold':'0.6','decide.slots.intent.wait_ms':'2000'};
  for(const [key,value] of Object.entries(keys))await engine.setConfig(key,value);
  resetDecideSearchCache();
  try{
    await withRun(async()=>{
      const results=await hybridSearch(engine,'alpha keyword',{limit:5,expansion:false});
      expect(results.some(result=>result.slug==='notes/decision')).toBe(true);
    },2);
    await flushDecideWrites();
    const rows=await engine.executeRaw<Record<string,unknown>>('SELECT provider,model_resolved,call_site,answer_choice,outcome FROM decision_receipts WHERE slot=$1',['intent']);
    expect(rows.some(row=>row.provider==='llm:codex-cli:gpt-test'&&row.model_resolved==='codex-cli:gpt-test'&&row.call_site==='search'&&row.answer_choice!==null)).toBe(true);
  }finally{for(const key of Object.keys(keys))await engine.setConfig(key,'');resetDecideSearchCache();}
});
test('the query operation records a Codex answerability decision',async()=>{
  const keys={'decide.provider':'llm:codex-cli:gpt-test','decide.slots.answerable.mode':'on','decide.slots.answerable.threshold':'0.5','decide.slots.answerable.force_on':'true'};
  for(const [key,value] of Object.entries(keys))await engine.setConfig(key,value);
  resetDecideSearchCache();
  try{
    const query=operations.find(op=>op.name==='query')!;
    const ctx={engine,config:{engine:'pglite'},logger:{info(){},warn(){},error(){}},dryRun:false,remote:false,sourceId:'default'} as OperationContext;
    await withRun(async()=>{
      const result=await query.handler(ctx,{query:'alpha keyword',expand:false,limit:5});
      expect(result).toBeDefined();
    },2);
    await flushDecideWrites();
    const rows=await engine.executeRaw<Record<string,unknown>>('SELECT provider,model_resolved,call_site,answer_value,outcome FROM decision_receipts WHERE slot=$1',['answerable']);
    expect(rows.some(row=>row.provider==='llm:codex-cli:gpt-test'&&row.model_resolved==='codex-cli:gpt-test'&&row.call_site==='query'&&row.answer_value!==null)).toBe(true);
  }finally{for(const key of Object.keys(keys))await engine.setConfig(key,'');resetDecideSearchCache();}
});
test('valid empty expansion/OCR remains distinct from provider failure and uses image argv',async()=>{
  expect(await withRun(()=>expand('synthetic search'))).toEqual(['synthetic search']);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgUbL4DwACCgFmeGgpMwAAAABJRU5ErkJggg==','base64');
  expect(await withRun(()=>generateOcrText(png,'image/png'))).toBe('');
  const last=JSON.parse(readFileSync(capture,'utf8').trim().split('\n').at(-1)!);expect(last.args).toContain('--image');
});
test('one-shot callers do not acquire native tools, exhaustion refuses a second attempt',async()=>{
  await expect(withRun(()=>chat({messages:[],tools:[{name:'shell',description:'forbidden',inputSchema:{}}]}))).rejects.toMatchObject({code:'private_native_loop_unsupported'});
  await withRun(async()=>{
    await chat({messages:[{role:'user',content:'first'}]});
    await expect(chat({messages:[{role:'user',content:'second'}]})).rejects.toMatchObject({code:'subscription_exhausted'});
  },1);
});

test('corrupt OCR pixels consume no attempt and never reach the executable',async()=>{
  const callsBefore=readFileSync(capture,'utf8');
  const before=await engine.executeRaw<{n:number|string}>('SELECT COUNT(*) AS n FROM codex_subscription_attempts');
  await withRun(async()=>{
    await expect(generateOcrText(syntheticPng({pixels:Uint8Array.of(0)}),'image/png')).rejects.toMatchObject({reason:'invalid_input'});
    expect(readFileSync(capture,'utf8')).toBe(callsBefore);
    const after=await engine.executeRaw<{n:number|string}>('SELECT COUNT(*) AS n FROM codex_subscription_attempts');
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
    expect(await generateOcrText(PNG_PIXEL,'image/png')).toBe('');
  },1);
});

test('JPEG and WebP OCR use the same bounded admission and native image interface',async()=>{
  await withRun(async()=>{
    expect(await generateOcrText(JPEG_PIXELS,'image/jpeg')).toBe('');
    expect(await generateOcrText(WEBP_PIXELS,'image/webp')).toBe('');
    const calls=readFileSync(capture,'utf8').trim().split('\n').slice(-2).map(s=>JSON.parse(s));
    expect(calls.every(c=>c.args.includes('--image'))).toBe(true);
  },2);
});

test('terminal invalid output retains measured usage and can be followed by a subsequent bounded attempt',async()=>{
  await withRun(async()=>{
    await expect(chat({messages:[{role:'user',content:'synthetic invalid'}],responseSchema:{name:'fixture',schema:{
      type:'object',properties:{answer:{type:'integer'}},required:['answer'],additionalProperties:false}}})).rejects.toMatchObject({reason:'invalid_output'});
    const rows=await engine.executeRaw<{state:string;input_tokens:number|string}>('SELECT state,input_tokens FROM codex_subscription_attempts WHERE failure_code=$1',['invalid_output']);
    expect(rows).toHaveLength(1);expect(rows[0]?.state).toBe('failed');expect(Number(rows[0]?.input_tokens)).toBe(10);
    expect((await chat({messages:[{role:'user',content:'synthetic retry'}]})).text).toBe('');
  });
});
