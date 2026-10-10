import { maintenancePreflight } from '../../src/core/persistence/prepared-maintenance.ts';
import { reserveSynthesisSubmission, remainingSynthesisSubmissions } from '../../src/core/cycle/synthesize-codex-admission.ts';
import { beforeAll, afterAll, test, expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, renameSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription } from '../../src/core/ai/subscription-context.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { runPhaseSynthesize } from '../../src/core/cycle/synthesize.ts';
import { runPhasePatterns } from '../../src/core/cycle/patterns.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { __setMaintenanceWriteWaitForTests } from '../../src/core/persistence/maintenance-wait.ts';

export function codexSynthesisContract(factory: () => Promise<{engine:BrainEngine;cleanup?:()=>Promise<void>}>) {
  const root=mkdtempSync(join(tmpdir(),'codex-synthesis-')), bin=join(root,'fake.mjs'), control=join(root,'reply.json'), capture=join(root,'calls.jsonl');
  const keys=['HOME','GBRAIN_HOME','CODEX_HOME'] as const, saved=keys.map(k=>[k,process.env[k]] as const), fetch=globalThis.fetch;
  let engine:BrainEngine, cleanup:(()=>Promise<void>)|undefined, unregister:()=>void, restoreWait:()=>void;
  const quote='Early review prevents rework and keeps evidence attached to each decision.';
  const proposal=()=>({skipped:false,reason:'A durable lesson.',pages:[{lane:'reflection',title:'Early review',body:quote,quotes:[quote]}]});
  const reply=(value:unknown)=>writeFileSync(control,JSON.stringify(value));
  const calls=()=>existsSync(capture)?readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
  beforeAll(async()=>{
    for(const k of keys)process.env[k]=root;
    globalThis.fetch=(()=>{throw new Error('forbidden network');}) as unknown as typeof fetch;
    mkdirSync(join(root,'.gbrain'));writeFileSync(join(root,'.gbrain','config.json'),JSON.stringify({embedding_disabled:true,private_codex:{mode:'strict',model:'codex-cli:gpt-test',bin}}));
    const script=`#!${Bun.which('node')}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const a=process.argv.slice(2),arg=n=>a[a.indexOf(n)+1],schema=JSON.parse(readFileSync(arg('--output-schema'),'utf8')),prompt=readFileSync(0,'utf8');
appendFileSync(${JSON.stringify(capture)},JSON.stringify({schema,prompt})+'\\n');
const control=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
const value=schema.properties.score?{score:control.triageZero?0:0.9,content_type:'reflection',segments:control.triageZero?[]:[{quote:${JSON.stringify(quote)},note:'Durable review lesson'}],entities:[],reasons:['Evidence retained','Review lesson']}:
 schema.properties.pages.items.properties.lane?control.proposal:control.pattern;
const text=JSON.stringify(value);writeFileSync(arg('--output-last-message'),text);
for(const e of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed',usage:{input_tokens:30,cached_input_tokens:0,output_tokens:15}}])console.log(JSON.stringify(e));
`;
    writeFileSync(bin,script,{mode:0o700});unregister=__registerCodexFixtureForTests(bin,createHash('sha256').update(script).digest('hex'));
    ({engine,cleanup}=await factory());await engine.initSchema();configureGateway({env:{}});restoreWait=__setMaintenanceWriteWaitForTests(5000);
    for(const [key,value] of Object.entries({'dream.synthesize.enabled':'true','dream.synthesize.conversation_pages':'true','dream.synthesize.min_chars':'0',
      'dream.synthesize.reflections_slug_prefix':'reflections','dream.synthesize.originals_slug_prefix':'originals','dream.synthesize.output_root':'wiki',
      'dream.patterns.min_evidence':'2','dream.patterns.source_slug_prefix':'reflections','dream.patterns.output_slug_prefix':'patterns','sync.write_through':'true'}))await engine.setConfig(key,value);
  });
  afterAll(async()=>{
    await disposePersistenceConsumer(engine);await engine?.disconnect();await cleanup?.();unregister?.();restoreWait?.();resetGateway();globalThis.fetch=fetch;
    for(const [k,v] of saved)if(v===undefined)delete process.env[k];else process.env[k]=v;
    rmSync(root,{recursive:true,force:true});
  });
  async function fixture(kind='page', count=1) {
    await disposePersistenceConsumer(engine);await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const sourceId=`synth-${randomUUID().slice(0,8)}`,dir=join(root,sourceId);mkdirSync(dir);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)',[sourceId,dir]);
    for(let i=0;i<count;i++)await engine.putPage(`conversations/input-${i}`,{type:'conversation',title:'Synthetic transcript',compiled_truth:`${quote}\n\nAdditional synthetic context ${i}.`,frontmatter:{visibility:kind==='private'?'private':'world'}},{sourceId});
    const path=join(dir,'transcript.txt');writeFileSync(path,quote);
    await claimWorktree(engine,sourceId,dir);await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await engine.setConfig('dream.synthesize.max_chunks_per_transcript','8');await engine.setConfig('dream.synthesize.max_submissions_per_source_per_day','0');
    const scope=async<T>(fn:()=>Promise<T>,checkAuthority?:()=>Promise<void>,max=24)=>{
      const runId=randomUUID();await createSubscriptionRun(engine,{runId,accountLane:runId,maxAttempts:max,maxTurns:max,deadline:new Date(Date.now()+600000)});
      return withCodexSubscription({engine,runId,checkAuthority},fn);
    };
    const run=(checkAuthority?:()=>Promise<void>,max=24)=>scope(()=>runPhaseSynthesize(engine,{brainDir:dir,sourceId,dryRun:false,once:true,cycleDate:'2026-01-01',...(kind==='file'?{inputFile:path}:{})}),checkAuthority,max);
    reply({proposal:proposal()});return{sourceId,dir,path,run,scope};
  }
  const plans=(sourceId:string)=>engine.executeRaw<{plan_id:string;state:string;payload:{watermark:{key:string};pages:Array<{slug:string}>}}>('SELECT plan_id,state,payload FROM codex_publication_plans WHERE source_id=$1 AND kind=\'synthesis\' ORDER BY created_at',[sourceId]);
  const halt=(sourceId:string)=>async()=>{if((await plans(sourceId)).length)throw new Error('synthetic crash after retention');};
  test('real transcript → triage → reflection → pattern path publishes required summaries and grounded provenance',async()=>{
    const f=await fixture('page',2), before=calls().length;const r=await f.run();expect(r.status).toBe('ok');expect(r.details?.pages_written).toBe(4);
    const accepted=await plans(f.sourceId);expect(accepted.every(p=>p.state==='complete')).toBe(true);
    const reflections=accepted.flatMap(p=>p.payload.pages).filter(p=>p.slug.startsWith('reflections/'));
    for(const page of reflections){expect(existsSync(join(f.dir,`${page.slug}.md`))).toBe(true);expect((await engine.getPage(page.slug,{sourceId:f.sourceId}))!.frontmatter.raw_source).toContain('gbrain-page://');}
    reply({pattern:{skipped:false,reason:'Supported pattern.',pages:[{slug:'patterns/review',title:'Review',type:'note',body:quote,evidence:reflections.map(p=>({slug:p.slug,quote}))}]}});
    expect((await f.scope(()=>runPhasePatterns(engine,{brainDir:f.dir,sourceId:f.sourceId,dryRun:false,once:true}))).status).toBe('ok');
    expect(await engine.getPage('patterns/review',{sourceId:f.sourceId})).not.toBeNull();expect(calls().length-before).toBe(5);
    const count=calls().length;expect((await f.run()).details?.already_synthesized).toBe(2);expect(calls()).toHaveLength(count);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 AND state=\'committed\'',[f.sourceId])).toHaveLength(5);
  });
  test('crash after a reflection commit recovers the saved required summary without another model call',async()=>{
    const f=await fixture();expect((await f.run(async()=>{if((await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 AND state=\'committed\'',[f.sourceId])).length)throw new Error('crash');})).status).toBe('fail');
    const [plan]=await plans(f.sourceId);expect(plan!.state).toBe('accepted');expect(await engine.getConfig(plan!.payload.watermark.key)).toBeNull();
    const count=calls().length;reply({proposal:{bad:true}});const recovered=await f.run();expect(recovered.status).toBe('ok');expect(recovered.details?.recovered).toBe(true);expect(calls()).toHaveLength(count);
    expect((await plans(f.sourceId))[0]!.state).toBe('complete');expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1',[f.sourceId])).toHaveLength(2);
  });
  test.each(['quote','number','path','body_quote'])('invalid %s proposal cannot publish or mark completion',async kind=>{
    const f=await fixture(),p=proposal();if(kind==='quote')p.pages[0]!.quotes=['invented'];if(kind==='number')p.pages[0]!.body='The team saved 900 dollars.';
    if(kind==='path')Object.assign(p.pages[0]!,{slug:'escape/page'});if(kind==='body_quote')p.pages[0]!.body='> This never appeared in the transcript.';
    reply({proposal:p});const before=calls().length;expect((await f.run()).status).toBe('fail');expect(calls().length-before).toBe(2);expect(await plans(f.sourceId)).toHaveLength(0);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1',[f.sourceId])).toHaveLength(0);
  });
  test('private inputs never reach triage or synthesis',async()=>{
    const f=await fixture('private'),before=calls().length;expect((await f.run()).details?.excluded_visibility).toBe(1);expect(calls()).toHaveLength(before);expect(await plans(f.sourceId)).toHaveLength(0);
  });
  test('clean synthesis zero is retained and completed; a low triage verdict is not a synthesis completion',async()=>{
    const f=await fixture();reply({proposal:{skipped:true,reason:'No durable additions.',pages:[]}});expect((await f.run()).status).toBe('ok');expect((await plans(f.sourceId))[0]!.state).toBe('complete');
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1',[f.sourceId])).toHaveLength(0);
    const g=await fixture();reply({triageZero:true,proposal:proposal()});expect((await g.run()).status).toBe('ok');expect(await plans(g.sourceId)).toHaveLength(0);
  });
  test('local transcript publishes through native schema and refuses changed or replaced files on recovery',async()=>{
    const f=await fixture('file');expect((await f.run(halt(f.sourceId))).status).toBe('fail');const count=calls().length;
    renameSync(f.path,`${f.path}.old`);writeFileSync(f.path,quote);expect((await f.run()).status).toBe('fail');expect(calls()).toHaveLength(count);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 AND state=\'committed\'',[f.sourceId])).toHaveLength(0);
    const g=await fixture('file');expect((await g.run()).status).toBe('ok');expect((await plans(g.sourceId))[0]!.state).toBe('complete');
  });
  test('exhausted subscription allowance never publishes a partial proposal',async()=>{
    const f=await fixture();expect((await f.run(undefined,1)).status).toBe('fail');expect(await plans(f.sourceId)).toHaveLength(0);
  });
  test('multi-chunk output is fully retained before publication and completion covers every chunk',async()=>{
    const f=await fixture('file');writeFileSync(f.path,(`${quote}\n\n`).repeat(230));
    expect((await f.run()).status).toBe('ok');const [plan]=await plans(f.sourceId);
    const reflections=plan!.payload.pages.filter(p=>p.slug.startsWith('reflections/'));
    expect(reflections.length).toBeGreaterThan(1);
    for(const page of reflections)expect(existsSync(join(f.dir,`${page.slug}.md`))).toBe(true);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 AND state=\'committed\'',[f.sourceId])).toHaveLength(reflections.length+1);
  });
  test('oversize input and chunk caps fail before inference with no completion',async()=>{
    const f=await fixture('file'),count=calls().length;truncateSync(f.path,3*1024*1024);
    expect((await f.run()).status).toBe('fail');expect(calls()).toHaveLength(count);
    writeFileSync(f.path,(`${quote}\n\n`).repeat(230));await engine.setConfig('dream.synthesize.max_chunks_per_transcript','1');
    expect((await f.run()).status).toBe('fail');expect(calls()).toHaveLength(count);expect(await plans(f.sourceId)).toHaveLength(0);
  });
  test('daily submission cap defers remaining transcripts without silently spending past it',async()=>{
    const f=await fixture('page',2);await engine.setConfig('dream.synthesize.max_submissions_per_source_per_day','1');
    const count=calls().length,r=await f.run();expect(r.status).toBe('warn');expect(r.details?.deferred).toBe(1);
    expect(await plans(f.sourceId)).toHaveLength(1);expect(calls().length-count).toBe(2);
    expect((await f.run()).details?.deferred).toBe(1);expect(calls().length-count).toBe(2);
  });
  test('summary-file opt-out retains a required database receipt without writing its file',async()=>{
    const f=await fixture();await engine.setConfig('dream.synthesize.summary_file_write','false');
    try {expect((await f.run()).status).toBe('ok');const [plan]=await plans(f.sourceId);
      const summary=plan!.payload.pages.find(p=>p.slug.startsWith('dream-cycle-summaries/'))!;
      expect(await engine.getPage(summary.slug,{sourceId:f.sourceId})).not.toBeNull();expect(existsSync(join(f.dir,`${summary.slug}.md`))).toBe(false);
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 AND state=\'committed\'',[f.sourceId])).toHaveLength(2);
    } finally {await engine.setConfig('dream.synthesize.summary_file_write','true');}
  });
  test('read-only preview performs no inference or publication and conflicting pins refuse',async()=>{
    const f=await fixture(),count=calls().length;
    const r=await runPhaseSynthesize(engine,{sourceId:f.sourceId,brainDir:f.dir,dryRun:true,once:true});expect(r.status).toBe('ok');expect(calls()).toHaveLength(count);expect(await plans(f.sourceId)).toHaveLength(0);
    await engine.setConfig('models.dream.synthesize','anthropic:claude-test');
    try {expect((await f.run()).status).toBe('fail');expect(calls()).toHaveLength(count);}finally{await engine.setConfig('models.dream.synthesize','codex-cli:gpt-test');}
  });

  test('cached triage negatives do not starve later inputs behind the per-phase cap',async()=>{
    const f=await fixture('page',9);reply({triageZero:true,proposal:proposal()});const before=calls().length;
    expect((await f.run()).details?.deferred).toBe(1);expect(calls().length-before).toBe(8);
    expect((await f.run()).details?.deferred).toBe(0);expect(calls().length-before).toBe(9);expect(await plans(f.sourceId)).toHaveLength(0);
  });
  test('private or self-generated files are excluded before any call',async()=>{
    const f=await fixture('file'),count=calls().length;
    writeFileSync(f.path,`---\nvisibility: private\n---\n${quote}`);expect((await f.run()).details?.excluded_visibility).toBe(1);
    writeFileSync(f.path,`---\ndream_generated: true\n---\n${quote}`);expect((await f.run()).details?.transcripts_processed).toBe(0);
    expect(calls()).toHaveLength(count);expect(await plans(f.sourceId)).toHaveLength(0);
  });

  test('failed proposals consume daily admission and two concurrent reservations cannot exceed it',async()=>{
    const f=await fixture();await engine.setConfig('dream.synthesize.max_submissions_per_source_per_day','1');
    const bad=proposal();bad.pages[0]!.quotes=['invented'];reply({proposal:bad});expect((await f.run()).status).toBe('fail');
    const count=calls().length;reply({proposal:proposal()});expect((await f.run()).details?.deferred).toBe(1);expect(calls()).toHaveLength(count);
    const g=await fixture(),authority=(await maintenancePreflight(engine,g.sourceId,g.dir))!;
    const outcomes=await g.scope(()=>Promise.allSettled([reserveSynthesisSubmission(engine,authority,1),reserveSynthesisSubmission(engine,authority,1)]));
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect(await remainingSynthesisSubmissions(engine,authority,1)).toBe(0);
  });
  test('successful completion applies a source-scoped cooldown while deferred work does not',async()=>{
    const f=await fixture();expect((await f.run()).status).toBe('ok');const count=calls().length;
    const authority=(await maintenancePreflight(engine,f.sourceId,f.dir))!;expect(await remainingSynthesisSubmissions(engine,authority,1)).toBe(0);
    const r=await f.scope(()=>runPhaseSynthesize(engine,{sourceId:f.sourceId,brainDir:f.dir,dryRun:false}));
    expect(r.details?.reason).toBe('cooldown_active');expect(calls()).toHaveLength(count);
    const g=await fixture('page',2);await engine.setConfig('dream.synthesize.max_submissions_per_source_per_day','1');expect((await g.run()).status).toBe('warn');
    const next=await g.scope(()=>runPhaseSynthesize(engine,{sourceId:g.sourceId,brainDir:g.dir,dryRun:false}));expect(next.details?.reason).not.toBe('cooldown_active');expect(next.details?.deferred).toBe(1);
  });

}
