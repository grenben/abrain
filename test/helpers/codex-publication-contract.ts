import { beforeAll, afterAll, test, expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription } from '../../src/core/ai/subscription-context.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { runPhasePatterns } from '../../src/core/cycle/patterns.ts';
import { pendingPublication, executePublication, retainPublication } from '../../src/core/cycle/codex-publication-plan.ts';
import { maintenancePreflight } from '../../src/core/persistence/prepared-maintenance.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { __setMaintenanceWriteWaitForTests } from '../../src/core/persistence/maintenance-wait.ts';

export function codexPublicationContract(factory: () => Promise<{engine:BrainEngine;cleanup?:()=>Promise<void>}>) {
  const root = mkdtempSync(join(tmpdir(), 'codex-publish-')), bin = join(root, 'fake.mjs');
  const control = join(root, 'reply.json'), capture = join(root, 'capture.jsonl');
  const keys = ['HOME', 'GBRAIN_HOME', 'CODEX_HOME'] as const, saved = keys.map(k => [k, process.env[k]] as const);
  const originalFetch = globalThis.fetch;
  let engine: BrainEngine, cleanup: (()=>Promise<void>) | undefined, unregister: ()=>void, restoreWait: ()=>void;
  const quote = 'Independent synthetic observations show that early review prevents rework.';
  beforeAll(async () => {
    for (const k of keys) process.env[k] = root;
    globalThis.fetch = (() => { throw new Error('forbidden network'); }) as unknown as typeof fetch;
    mkdirSync(join(root, '.gbrain'));
    writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ embedding_disabled: true,
      private_codex: { mode: 'strict', model: 'codex-cli:gpt-test', bin } }));
    const script = `#!${Bun.which('node')}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const a=process.argv.slice(2),arg=n=>a[a.indexOf(n)+1];
const schema=JSON.parse(readFileSync(arg('--output-schema'),'utf8')),prompt=readFileSync(0,'utf8');
appendFileSync(${JSON.stringify(capture)},JSON.stringify({schema,prompt})+'\\n');
const text=readFileSync(${JSON.stringify(control)},'utf8');writeFileSync(arg('--output-last-message'),text);
for(const e of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed',usage:{input_tokens:30,cached_input_tokens:0,output_tokens:15}}])console.log(JSON.stringify(e));
`;
    writeFileSync(bin, script, { mode: 0o700 }); unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(script).digest('hex'));
    ({engine, cleanup} = await factory()); await engine.initSchema(); configureGateway({env:{}});
    restoreWait = __setMaintenanceWriteWaitForTests(5000);
    await engine.setConfig('dream.patterns.min_evidence', '2');
    await engine.setConfig('dream.patterns.source_slug_prefix', 'reflections');
    await engine.setConfig('dream.patterns.output_slug_prefix', 'patterns');
    await engine.setConfig('sync.write_through', 'true');
  });
  afterAll(async () => {
    await disposePersistenceConsumer(engine); await engine?.disconnect(); await cleanup?.(); unregister?.(); restoreWait?.(); resetGateway(); globalThis.fetch = originalFetch;
    for (const [k,v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(root, {recursive:true,force:true});
  });
  async function fixture() {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const sourceId = `pub-${randomUUID().slice(0,8)}`, dir = join(root, sourceId); mkdirSync(dir);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId,dir]);
    for (const slug of ['reflections/one','reflections/two']) await engine.putPage(slug, { type:'note',title:slug,compiled_truth:quote }, {sourceId});
    await claimWorktree(engine, sourceId, dir);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const proposal = (slugs = ['patterns/review']) => ({ skipped:false,reason:'Shared evidence supports a pattern.',pages:slugs.map(slug=>({slug,title:'Early review',type:'note',body:'Early review prevents rework.',
      evidence:[{slug:'reflections/one',quote},{slug:'reflections/two',quote}]})) });
    const run = async (checkAuthority?:()=>Promise<void>) => {
      const runId = randomUUID();
      await createSubscriptionRun(engine, {runId,accountLane:runId,maxAttempts:2,maxTurns:2,deadline:new Date(Date.now()+600000)});
      return withCodexSubscription({engine,runId,checkAuthority},()=>runPhasePatterns(engine,{sourceId,brainDir:dir,once:true,dryRun:false,cycleDate:'2026-01-01'}));
    };
    return {sourceId,dir,proposal,run};
  }
  const reply = (value:unknown)=>writeFileSync(control, JSON.stringify(value));
  const calls = ()=>existsSync(capture)?readFileSync(capture,'utf8'):'';
  test('production patterns publishes a retained proposal through receipts, files and source-scoped provenance', async()=>{
    const f = await fixture(); reply(f.proposal());
    const result = await f.run(); expect(result.status).toBe('ok'); expect(result.details?.patterns_written).toBe(1);
    expect(existsSync(join(f.dir,'patterns/review.md'))).toBe(true);
    const page = await engine.getPage('patterns/review',{sourceId:f.sourceId});
    expect(page?.compiled_truth).toContain(quote); expect(page?.frontmatter?.dream_generated).toBe(true);
    const plans = await engine.executeRaw<{state:string}>('SELECT state FROM codex_publication_plans WHERE source_id=$1',[f.sourceId]);
    expect(plans).toEqual([{state:'complete'}]);
    const receipts = await engine.executeRaw<{state:string}>('SELECT state FROM persistence_requests WHERE source_id=$1',[f.sourceId]);
    expect(receipts).toEqual([{state:'committed'}]);
    const edges = await engine.executeRaw("SELECT id FROM links WHERE link_source='codex-publication' AND from_page_id=$1",[page!.id]); expect(edges).toHaveLength(2);
  });
  test('whole proposal fails before any effects for fabricated or repeated evidence',async()=>{
    const f=await fixture(); const bad=f.proposal(['patterns/valid','patterns/invalid']); bad.pages[1]!.evidence[1]!.quote='invented';reply(bad);
    expect((await f.run()).status).toBe('fail');
    expect(await engine.getPage('patterns/valid',{sourceId:f.sourceId})).toBeNull();
    expect(await engine.executeRaw('SELECT plan_id FROM codex_publication_plans WHERE source_id=$1',[f.sourceId])).toHaveLength(0);
  });
  test('partial commit resumes the exact retained plan without another model call',async()=>{
    const f=await fixture();reply(f.proposal(['patterns/first','patterns/second']));
    const checkAuthority = async () => {
      if (await engine.getPage('patterns/first',{sourceId:f.sourceId})) throw new Error('synthetic crash after first commit');
    };
    expect((await f.run(checkAuthority)).status).toBe('fail');
    expect(await engine.getPage('patterns/first',{sourceId:f.sourceId})).not.toBeNull();
    const before=calls();reply({malformed:true});
    const recovered=await f.run();expect(recovered.status).toBe('ok');expect(recovered.details?.recovered).toBe(true);expect(calls()).toBe(before);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1',[f.sourceId])).toHaveLength(2);
  });
  test('a clean zero has an accepted plan and watermark while invalid output has neither',async()=>{
    const f=await fixture();reply({skipped:true,reason:'No supported pattern.',pages:[]});expect((await f.run()).status).toBe('ok');
    const plans=await engine.executeRaw<{payload:{watermark:{key:string;value:string}};state:string}>('SELECT payload,state FROM codex_publication_plans WHERE source_id=$1',[f.sourceId]);
    expect(plans[0]!.state).toBe('complete');expect(await engine.getConfig(plans[0]!.payload.watermark.key)).toBe(plans[0]!.payload.watermark.value);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1',[f.sourceId])).toHaveLength(0);
  });
  const haltAfterRetention = (sourceId:string) => async () => {
    if ((await engine.executeRaw('SELECT plan_id FROM codex_publication_plans WHERE source_id=$1',[sourceId])).length) throw new Error('synthetic halt after retention');
  };
  test.each(['duplicate','bad_link','bad_relative','traversal','authority','type'])('rejects %s in the full proposal before effects', async kind=>{
    const f=await fixture(), value=f.proposal();
    if(kind==='duplicate') value.pages[0]!.evidence[1]!.slug='reflections/one';
    if(kind==='bad_link') value.pages[0]!.body='See [[unknown/page]].';
    if(kind==='bad_relative') value.pages[0]!.body='See [source](../../unknown.md).';
    if(kind==='traversal') value.pages[0]!.slug='patterns/../escape';
    if(kind==='authority') Object.assign(value.pages[0]!,{principal:'model-controlled'});
    if(kind==='type') value.pages[0]!.type='person';
    reply(value);expect((await f.run()).status).toBe('fail');
    expect(await engine.executeRaw('SELECT plan_id FROM codex_publication_plans WHERE source_id=$1',[f.sourceId])).toHaveLength(0);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1',[f.sourceId])).toHaveLength(0);
  });
  test('retained identity rejects changed inputs and a competing plan',async()=>{
    const f=await fixture();reply(f.proposal());expect((await f.run(haltAfterRetention(f.sourceId))).status).toBe('fail');
    const authority=(await maintenancePreflight(engine,f.sourceId,f.dir))!;
    const plan=(await pendingPublication(engine,authority,'patterns'))!;
    const changed=structuredClone(plan);changed.payload.pages[0]!.content+='changed';
    await expect(executePublication(engine,authority,changed)).rejects.toThrow();
    await expect(retainPublication(engine,authority,'patterns',changed.payload)).rejects.toThrow('codex_publication_pending');
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1',[f.sourceId])).toHaveLength(0);
    expect(await engine.getConfig(plan.payload.watermark.key)).toBeNull();
    const before=calls();expect((await f.run()).status).toBe('ok');expect(calls()).toBe(before);
  });
  test('changed evidence blocks retained publication without another call or a successful watermark',async()=>{
    const f=await fixture();reply(f.proposal());expect((await f.run(haltAfterRetention(f.sourceId))).status).toBe('fail');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("UPDATE pages SET compiled_truth='changed evidence',content_hash='changed',frontmatter=frontmatter || '{\"visibility\":\"private\"}'::jsonb WHERE source_id=$1 AND slug='reflections/one'",[f.sourceId]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before=calls();expect((await f.run()).status).toBe('fail');expect(calls()).toBe(before);
    expect(await engine.getPage('patterns/review',{sourceId:f.sourceId})).toBeNull();
    const [plan]=await engine.executeRaw<{state:string;payload:{watermark:{key:string}}}>('SELECT state,payload FROM codex_publication_plans WHERE source_id=$1',[f.sourceId]);
    expect(plan!.state).toBe('accepted');expect(await engine.getConfig(plan!.payload.watermark.key)).toBeNull();
  });
  test('an existing output refuses the entire batch without overwriting it',async()=>{
    const f=await fixture();
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.putPage('patterns/existing',{type:'note',title:'Existing',compiled_truth:'Keep this.'},{sourceId:f.sourceId});
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    reply(f.proposal(['patterns/new','patterns/existing']));expect((await f.run()).status).toBe('fail');
    expect((await engine.getPage('patterns/existing',{sourceId:f.sourceId}))!.compiled_truth).toBe('Keep this.');
    expect(await engine.getPage('patterns/new',{sourceId:f.sourceId})).toBeNull();
    expect(await engine.executeRaw('SELECT plan_id FROM codex_publication_plans WHERE source_id=$1',[f.sourceId])).toHaveLength(0);
  });
  test('source archival and cancelled recovery preserve the accepted plan and committed effects',async()=>{
    const f=await fixture();reply(f.proposal(['patterns/first','patterns/second']));
    expect((await f.run(async()=>{if(await engine.getPage('patterns/first',{sourceId:f.sourceId}))throw new Error('stop');})).status).toBe('fail');
    const authority=(await maintenancePreflight(engine,f.sourceId,f.dir))!, plan=(await pendingPublication(engine,authority,'patterns'))!;
    const abort=new AbortController();abort.abort();await expect(executePublication(engine,authority,plan,abort.signal)).rejects.toThrow();
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1',[f.sourceId]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before=calls();expect((await f.run()).status).toBe('fail');expect(calls()).toBe(before);
    expect(await engine.getPage('patterns/first',{sourceId:f.sourceId})).not.toBeNull();
    expect(await engine.getPage('patterns/second',{sourceId:f.sourceId})).toBeNull();
    expect(await engine.getConfig(plan.payload.watermark.key)).toBeNull();
  });

  test('a clean zero rechecks evidence after retention and cannot mark changed input complete',async()=>{
    const f=await fixture();reply({skipped:true,reason:'No supported pattern.',pages:[]});
    expect((await f.run(haltAfterRetention(f.sourceId))).status).toBe('fail');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.putPage('reflections/one',{type:'note',title:'Changed',compiled_truth:'New evidence.'},{sourceId:f.sourceId});
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before=calls();expect((await f.run()).status).toBe('fail');expect(calls()).toBe(before);
    const [plan]=await engine.executeRaw<{state:string;payload:{watermark:{key:string}}}>('SELECT state,payload FROM codex_publication_plans WHERE source_id=$1',[f.sourceId]);
    expect(plan!.state).toBe('accepted');expect(await engine.getConfig(plan!.payload.watermark.key)).toBeNull();
  });

  test('completed plan replay leaves a newer watermark untouched',async()=>{
    const f=await fixture();reply(f.proposal());expect((await f.run()).status).toBe('ok');
    const authority=(await maintenancePreflight(engine,f.sourceId,f.dir))!;
    const [plan]=await engine.executeRaw<import('../../src/core/cycle/codex-publication-plan.ts').PublicationPlan>(
      'SELECT plan_id,payload,payload_hash,state FROM codex_publication_plans WHERE source_id=$1',[f.sourceId]);
    await engine.setConfig(plan!.payload.watermark.key,'2030-01-01T00:00:00.000Z');
    expect(await executePublication(engine,authority,plan!)).toBe(1);
    expect(await engine.getConfig(plan!.payload.watermark.key)).toBe('2030-01-01T00:00:00.000Z');
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1',[f.sourceId])).toHaveLength(1);
  });

}
