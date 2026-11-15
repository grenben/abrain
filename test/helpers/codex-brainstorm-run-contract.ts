import { withDistinctCodexModels } from './codex-role-fixture.ts';
import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { runBrainstorm, BRAINSTORM_PROFILE, formatBrainstormMarkdown, type BrainstormOptions } from '../../src/core/brainstorm/orchestrator.ts';
import { publishBrainstormResult } from '../../src/core/brainstorm/codex-publication.ts';
import { claimBrainstormRun, fenceBrainstormRun, releaseBrainstormRun } from '../../src/core/brainstorm/codex-store.ts';
import { withBrainstormAllowance } from '../../src/core/brainstorm/codex-local-grant.ts';
import { installFixtureChunks } from './page-projection.ts';
import { digest } from '../../src/core/persistence/digest.ts';
import { readBrainstormPublication } from '../../src/core/brainstorm/codex-publication-guard.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { configureGateway,__setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { validateCommandFlags } from '../../src/cli/main.ts';
import { runBrainstormCommand } from '../../src/commands/brainstorm.ts';

interface Fixture {root:string;engine():BrainEngine;sourceId:string;reply(value:unknown):void;calls():Array<any>;
  run<T>(fn:(id:string)=>Promise<T>,hooks?:Partial<CodexSubscriptionContext>,maxAttempts?:number):Promise<T>}
export function codexBrainstormRunContract(f:Fixture){describe('native brainstorm pipeline',()=>{
  let sourceId:string;
  const profile={...BRAINSTORM_PROFILE,k_close:1,m_far:1,ideas_per_cross:1};
  const run=(extra:Partial<BrainstormOptions>={})=>runBrainstorm(f.engine(),{}, {question:'Orbital launch',sourceId,profile,...extra});
  beforeEach(async()=>{
    sourceId=`brainstorm-${randomUUID().slice(0,8)}`;
    await f.engine().executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)',[sourceId,sourceId]);
    for(const [slug,body] of [['notes/launch','Orbital launch planning uses staged readiness checks.'],['concepts/geometry','Triangles have geometric constraints.']]){
      await f.engine().putPage(slug!,{type:'note',title:slug!,compiled_truth:body!},{sourceId});
      await installFixtureChunks(f.engine(),slug!,[{chunk_index:0,chunk_text:body!,chunk_source:'compiled_truth'}],{sourceId});
    }
    f.reply({autoBrainstorm:true});
  });
  afterEach(async()=>{await f.engine().executeRaw('UPDATE sources SET archived=true WHERE id=$1',[sourceId]);});
  test('cross and judge dispatch their distinct deep and utility tier models', async () => {
    await withDistinctCodexModels(async () => {
      const before = f.calls().length;
      await f.run(async () => { expect((await run()).generation_status).toBe('complete'); });
      const models = f.calls().slice(before).map(wire => wire.args[wire.args.indexOf('--model') + 1]);
      expect(models).toEqual(['deep-fixture', 'utility-fixture']);
    });
  });
  test('real retrieval, native cross, judge and prepared publication retain quotes, provenance and null cost',async()=>{
    const before=f.calls().length;
    await f.run(async id=>{
      const result=await run({ideaSlug:'wiki/ideas/native-fixture'});
      expect(result).toMatchObject({generation_status:'complete',judge_failed:false,cost:{actual_usd:null,estimated_usd:null,input_tokens:42,output_tokens:18,cap_source:'subscription'}});
      expect(result.ideas).toHaveLength(1);expect(result.ideas[0]!.evidence).toHaveLength(2);expect(result.ideas[0]!.passes).toBe(true);
      expect(formatBrainstormMarkdown(result)).toContain(`source: ${sourceId}`);
      expect(f.calls().length-before).toBe(2);
      const saved=await publishBrainstormResult(f.engine(),result);expect(saved.slug).toBe('wiki/ideas/native-fixture');
      expect(await f.engine().executeRaw('SELECT state,protocol_version FROM persistence_requests WHERE request_id=$1::uuid',[saved.request_id])).toEqual([{state:'committed',protocol_version:5}]);
      const page=await f.engine().getPage(saved.slug,{sourceId});expect(page?.frontmatter.cost_usd).toBeNull();
      expect((await f.engine().getLinks(saved.slug,{sourceId})).filter(l=>l.link_source==='codex-brainstorm')).toHaveLength(2);
      expect(await f.engine().executeRaw('SELECT publication_complete FROM codex_brainstorm_runs WHERE run_id=$1',[id])).toEqual([{publication_complete:true}]);
      const again=await run({ideaSlug:'wiki/ideas/native-fixture'});expect(again).toEqual(result);expect(await publishBrainstormResult(f.engine(),again)).toEqual(saved);
      expect(f.calls().length-before).toBe(2);
    });
    const wires=f.calls().slice(before);expect(wires.every(w=>w.args.includes('--output-schema')&&w.mode===0o600)).toBe(true);
    expect(wires[0]!.schema.properties.ideas.items.required).toEqual(['text','close_quote','far_quote']);
  });
  test('judge failure does not mark success; retry uses the retained selection and cross proposal',async()=>{
    f.reply({autoBrainstorm:true,badJudge:true});const before=f.calls().length;
    await f.run(async id=>{
      await expect(run()).rejects.toMatchObject({reason:'invalid_output'});
      expect(await f.engine().executeRaw('SELECT state,result FROM codex_brainstorm_runs WHERE run_id=$1',[id])).toEqual([{state:'idle',result:null}]);
      f.reply({autoBrainstorm:true});const engine=f.engine(),query=engine.listPrefixSampledPages;
      engine.listPrefixSampledPages=async()=>{throw new Error('must reuse selection');};
      try{expect((await run()).ideas).toHaveLength(1);}finally{engine.listPrefixSampledPages=query;}
      expect(f.calls().length-before).toBe(3);
    });
  });
  test('valid empty cross output is retained as empty, without a judge call or publication',async()=>{
    f.reply({autoBrainstorm:true,emptyCross:true});const before=f.calls().length;
    await f.run(async id=>{
      const result=await run({ideaSlug:'wiki/ideas/empty'});expect(result.generation_status).toBe('empty');expect(result.ideas).toEqual([]);
      expect(f.calls().length-before).toBe(1);expect(await f.engine().getPage('wiki/ideas/empty',{sourceId})).toBeNull();
      expect(await f.engine().executeRaw('SELECT publication FROM codex_brainstorm_runs WHERE run_id=$1',[id])).toEqual([{publication:null}]);
    });
  });
  test('malformed cross and missing completion remain distinct from empty output and prevent duplicate admission',async()=>{
    f.reply({raw:'not JSON'});await f.run(async()=>{await expect(run()).rejects.toMatchObject({reason:'invalid_output'});});
    f.reply({missingCompletion:true});const before=f.calls().length;
    await f.run(async id=>{
      await expect(run()).rejects.toMatchObject({reason:'missing_completion'});await expect(run()).rejects.toMatchObject({code:'subscription_lane_busy'});
      expect(f.calls().length-before).toBe(1);expect(await f.engine().executeRaw('SELECT state FROM codex_brainstorm_runs WHERE run_id=$1',[id])).toEqual([{state:'needs_reconciliation'}]);
    });
  });
  test('forged quotes and model-authored authority fail before accepting the cross',async()=>{
    for(const value of [{ideas:[{text:'An idea.',close_quote:'Invented',far_quote:'Triangles have geometric constraints.'}]},
      {ideas:[{text:'A proposal [foreign/page].',close_quote:'Orbital launch planning uses staged readiness checks.',far_quote:'Triangles have geometric constraints.'}]},
      {ideas:[],source_id:'foreign'}]){
      f.reply(value);await f.run(async id=>{await expect(run()).rejects.toMatchObject({reason:'invalid_output'});
        expect(await f.engine().executeRaw('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[id])).toEqual([{accepted_turns:0}]);});
    }
  });
  test('changed request or evidence cannot regenerate under the old identity',async()=>{
    const before=f.calls().length;await f.run(async()=>{
      await run();await expect(run({question:'Changed question'})).rejects.toMatchObject({code:'subscription_identity_conflict'});
      await f.engine().putPage('concepts/geometry',{type:'note',title:'Geometry',compiled_truth:'A different geometry.'},{sourceId});
      await expect(run()).rejects.toMatchObject({code:'revision_conflict'});expect(f.calls().length-before).toBe(2);
    });
  });
  test('expired grants can recover accepted results without inference',async()=>{
    const before=f.calls().length;await f.run(async id=>{
      const result=await run();await f.engine().executeRaw("UPDATE codex_subscription_runs SET deadline=now()-interval '1 second' WHERE run_id=$1",[id]);
      expect(await run()).toEqual(result);expect(f.calls().length-before).toBe(2);
    });
  });
  test('private evidence stays private when published',async()=>{
    await f.engine().putPage('concepts/geometry',{type:'note',title:'Geometry',compiled_truth:'Triangles have geometric constraints.',frontmatter:{visibility:'private'}},{sourceId});
    await f.run(async()=>{const result=await run({ideaSlug:'wiki/ideas/private'});await publishBrainstormResult(f.engine(),result);
      expect((await f.engine().getPage('wiki/ideas/private',{sourceId}))?.frontmatter.visibility).toBe('private');});
  });
  test('target revision conflict leaves a retained plan and cannot claim a successful save',async()=>{
    await f.run(async id=>{const result=await run({ideaSlug:'wiki/ideas/conflict'});
      await f.engine().putPage('wiki/ideas/conflict',{type:'note',title:'Existing',compiled_truth:'Preserve this.'},{sourceId});
      await expect(publishBrainstormResult(f.engine(),result)).rejects.toThrow();
      expect((await f.engine().getPage('wiki/ideas/conflict',{sourceId}))?.compiled_truth).toBe('Preserve this.');
      expect(await f.engine().executeRaw('SELECT publication_complete FROM codex_brainstorm_runs WHERE run_id=$1',[id])).toEqual([{publication_complete:false}]);
    });
  });
  test('two owners and expired-owner writes are fenced',async()=>{
    await f.run(async id=>{
      const host={engine:f.engine(),runId:id},hash=digest('synthetic-owner');const first=await claimBrainstormRun(host,hash);
      await expect(claimBrainstormRun(host,hash)).rejects.toMatchObject({code:'subscription_owner_lost'});
      await f.engine().executeRaw("UPDATE codex_brainstorm_runs SET lease_until=now()-interval '1 second' WHERE run_id=$1",[id]);
      const second=await claimBrainstormRun(host,hash);
      await expect(f.engine().transaction(tx=>fenceBrainstormRun(tx,host,first))).rejects.toMatchObject({code:'subscription_owner_lost'});
      await releaseBrainstormRun(host,second,false);
    });
  });
  test('local allowance grants bind inputs and limits atomically and share the job account lane',async()=>{
    const id=randomUUID(),flags=['--codex-request-id',id,'--codex-max-attempts','4','--codex-max-turns','4','--codex-deadline',new Date(Date.now()+600000).toISOString()];
    const execute=(args=flags,extra:Partial<BrainstormOptions>={})=>withBrainstormAllowance(f.engine(),args,()=>run(extra));
    const before=f.calls().length;const result=await execute();expect(await execute()).toEqual(result);expect(f.calls().length-before).toBe(2);
    expect(await f.engine().executeRaw('SELECT account_lane,attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[`codex-brainstorm:${id}`])).toEqual([{account_lane:'codex-subscription',attempts:2,accepted_turns:2}]);
    await expect(execute(flags,{question:'Changed'})).rejects.toMatchObject({code:'subscription_identity_conflict'});
    const changed=[...flags];changed[3]='5';await expect(execute(changed)).rejects.toMatchObject({code:'subscription_identity_conflict'});
    expect(f.calls().length-before).toBe(2);
  });
  test('lost acknowledgment after result commit reuses both result and publication plan',async()=>{
    const engine=f.engine(),transaction=engine.transaction,before=f.calls().length;
    try{await f.run(async id=>{
      let fired=false;engine.transaction=(async function(this:BrainEngine,fn:Parameters<BrainEngine['transaction']>[0]){
        const value=await transaction.call(this,fn);
        if(this!==engine)return value;
        if(!fired&&(await engine.executeRaw('SELECT run_id FROM codex_brainstorm_runs WHERE run_id=$1 AND result IS NOT NULL',[id])).length){fired=true;throw new Error('fixture_result_commit_ack_lost');}return value;
      }) as BrainEngine['transaction'];
      await expect(run({ideaSlug:'wiki/ideas/ack'})).rejects.toThrow();engine.transaction=transaction;expect(fired).toBe(true);
      const result=await run({ideaSlug:'wiki/ideas/ack'});await publishBrainstormResult(engine,result);expect(f.calls().length-before).toBe(2);
    });}finally{engine.transaction=transaction;}
  });
  test.each(['admitted','committed'] as const)('recovery after %s write acknowledgment loss keeps the same canonical request',async stage=>{
    const engine=f.engine(),transaction=engine.transaction,before=f.calls().length;
    try{await f.run(async id=>{
      const result=await run({ideaSlug:'wiki/ideas/receipt'}),plan=await readBrainstormPublication(engine,id),requestId=plan.publication.admission.requestId;
      let fired=false;engine.transaction=(async function(this:BrainEngine,fn:Parameters<BrainEngine['transaction']>[0]){
        const value=await transaction.call(this,fn);
        if(this!==engine)return value;
        const found=await engine.executeRaw<{state:string}>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid',[requestId]);
        if(!fired&&found.length&&(stage==='admitted'||found[0]!.state==='committed')){fired=true;throw new Error('fixture_write_ack_lost');}return value;
      }) as BrainEngine['transaction'];
      await publishBrainstormResult(engine,result).catch(()=>undefined);engine.transaction=transaction;expect(fired).toBe(true);
      const saved=await publishBrainstormResult(engine,await run({ideaSlug:'wiki/ideas/receipt'}));expect(saved.request_id).toBe(requestId!);
      expect(await engine.executeRaw('SELECT state FROM persistence_requests WHERE request_id=$1::uuid',[requestId])).toEqual([{state:'committed'}]);
      expect(f.calls().length-before).toBe(2);
    });}finally{engine.transaction=transaction;}
  });
  test('edited results and downgraded write protocols cannot reach effects',async()=>{
    await f.run(async id=>{
      const result=await run({ideaSlug:'wiki/ideas/forged'}),plan=await readBrainstormPublication(f.engine(),id);
      await expect(publishBrainstormResult(f.engine(),{...result,question:'Forged'})).rejects.toMatchObject({code:'idempotency_conflict'});
      await expect(admitWrite(f.engine(),{...plan.publication.admission,protocolVersion:1})).rejects.toThrow();
      expect(await f.engine().getPage('wiki/ideas/forged',{sourceId})).toBeNull();
    });
  });
  test('a vanished worker claim cannot publish an otherwise accepted plan',async()=>{
    await f.run(async()=>{
      const result=await run({ideaSlug:'wiki/ideas/stale'});await expect(publishBrainstormResult(f.engine(),result)).rejects.toMatchObject({code:'write_claim_lost'});
      expect(await f.engine().getPage('wiki/ideas/stale',{sourceId})).toBeNull();
    },{publicationFence:{jobId:2147483000,lockToken:randomUUID(),jobDigest:digest('missing-fixture-job')}});
  });
  test('invalid bounds, foreign models and legacy checkpoint identities fail before inference',async()=>{
    const before=f.calls().length;await f.run(async()=>{
      for(const options of [{resumeRunId:'legacy-file-id'},{maxFarSet:10000},{profile:{...profile,k_close:999}},{maxIdeasPerJudgeCall:0},
        {profile:{...profile,judge_config:{...profile.judge_config,threshold:99}}}])await expect(run(options)).rejects.toThrow();
      await expect(run({modelOverride:'anthropic:fixture'})).rejects.toMatchObject({code:'private_route_conflict'});
      await expect(run({judgeModel:'openai:fixture'})).rejects.toMatchObject({code:'private_route_conflict'});
      expect(f.calls().length).toBe(before);
    });
  });
  test('paid embeddings require their own allowance and provider failure cannot become a successful keyword fallback',async()=>{
    const config=join(f.root,'.gbrain','config.json'),saved=readFileSync(config,'utf8');let embeddings=0;
    writeFileSync(config,JSON.stringify({...JSON.parse(saved),embedding_disabled:false}));
    configureGateway({embedding_model:'openai:text-embedding-3-small',embedding_dimensions:1536,env:{OPENAI_API_KEY:'sk-fixture-not-a-credential'}});
    __setEmbedTransportForTests(async({values}:{values:string[]})=>{embeddings++;return{embeddings:values.map(()=>[1,...Array(1535).fill(0)]),usage:{tokens:17}} as never;});
    try{
      await f.run(async()=>{await expect(run()).rejects.toMatchObject({code:'subscription_auxiliary_budget_required'});});expect(embeddings).toBe(0);
      __setEmbedTransportForTests(async()=>{embeddings++;throw new Error('synthetic_embedding_failure');});
      await f.run(async id=>{await expect(run({maxCostUsd:0.1})).rejects.toThrow();
        expect(await f.engine().executeRaw('SELECT result FROM codex_brainstorm_runs WHERE run_id=$1',[id])).toEqual([{result:null}]);});expect(embeddings).toBeGreaterThan(0);
    }finally{__setEmbedTransportForTests(null);configureGateway({embedding_dimensions:1536,env:{}});writeFileSync(config,saved);}
  });
  test('cancellation settles the native process and retains no successful result',async()=>{
    f.reply({wait:true});const before=f.calls().length,abort=new AbortController();
    await f.run(async id=>{
      const pending=run({abortSignal:abort.signal});
      const rejection=pending.then(()=>null,error=>error);
      try{for(let i=0;i<200&&f.calls().length===before;i++)await Bun.sleep(10);expect(f.calls().length).toBe(before+1);}
      finally{abort.abort();}
      expect(await rejection).toMatchObject({reason:'aborted'});
      expect(await f.engine().executeRaw('SELECT result FROM codex_brainstorm_runs WHERE run_id=$1',[id])).toEqual([{result:null}]);
      expect(await f.engine().executeRaw("SELECT attempt_id FROM codex_subscription_attempts WHERE run_id=$1 AND state='active'",[id])).toHaveLength(0);
    });
  });
  test('managed publication writes the canonical file and reuses its committed receipt',async()=>{
    const engine=f.engine(),destination=`brainstorm-managed-${randomUUID().slice(0,8)}`,dir=join(f.root,destination);
    await disposePersistenceConsumer(engine);mkdirSync(dir);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)',[destination,dir]);
    await claimWorktree(engine,destination,dir);
    try{await f.run(async()=>{
      const opts={sourceId:destination,sourceIds:[sourceId],ideaSlug:'wiki/ideas/canonical'},result=await run(opts);
      const saved=await publishBrainstormResult(engine,result),count=f.calls().length;
      const content=readFileSync(join(dir,saved.slug+'.md'),'utf8');expect(content).toContain('Connect the two domains');
      expect(content).toContain('provenance: codex-brainstorm');
      expect(await publishBrainstormResult(engine,await run(opts))).toEqual(saved);expect(f.calls().length).toBe(count);
    });}finally{await disposePersistenceConsumer(engine);await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1',[destination]);}
  });
  test('actual CLI entrypoint uses explicit bounds and repeats the retained request without another call',async()=>{
    const before=f.calls().length,id=randomUUID(),args=['Orbital launch','--source',sourceId,'--limit','1','--json','--yes',
      '--codex-request-id',id,'--codex-max-attempts','10','--codex-max-turns','10','--codex-deadline',new Date(Date.now()+600000).toISOString()];
    for(const command of ['brainstorm','lsd'])expect(validateCommandFlags(command,args)).toBeNull();
    await runBrainstormCommand(f.engine(),args);const calls=f.calls().length;expect(calls).toBeGreaterThan(before);
    await runBrainstormCommand(f.engine(),args);expect(f.calls().length).toBe(calls);
  });
});}
