import { test, expect, spyOn, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runThinkCli } from '../../src/commands/think.ts';
import { withThinkSubscription } from '../../src/commands/think-subscription.ts';
import { invokeAI } from '../../src/core/ai/invocation-guard.ts';
import { runPhaseAutoThink } from '../../src/core/cycle/auto-think.ts';
import { digest } from '../../src/core/persistence/digest.ts';
import { withCodexSubscription, type CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { runCycle } from '../../src/core/cycle.ts';

interface Fixture {
  engine():BrainEngine; sourceId:string; root:string;
  run<T>(fn:(id:string)=>Promise<T>,hooks?:Partial<CodexSubscriptionContext>):Promise<T>;
  reply(value:unknown):void; valid:unknown; calls():unknown[];
}
export function codexThinkAutomationContract(f:Fixture){
  const opts=()=>({question:'Orbit',sourceId:f.sourceId,remote:false as const,save:true});
  const flags=(id=randomUUID(),extra:string[]=[])=>['--codex-request-id',id,'--codex-max-attempts','4','--codex-max-turns','4','--codex-deadline',new Date(Date.now()+600000).toISOString(),...extra];
  beforeEach(async()=>{for(const [key,value] of Object.entries({enabled:'false',questions:'["Orbit one","Orbit two"]',max_per_cycle:'2',cooldown_days:'0',auto_commit:'false',budget:'0'}))await f.engine().setConfig(`dream.auto_think.${key}`,value);});
  test('think CLI parses explicit allowances, scopes save and reuses its stable request',async()=>{
    const engine=f.engine(),args=['Orbit','--source',f.sourceId,'--save','--json',...flags()];
    const output:string[]=[],log=spyOn(console,'log').mockImplementation((value)=>{output.push(String(value));});
    const exit=spyOn(process,'exit').mockImplementation((code)=>{throw new Error(`unexpected CLI exit ${code}`);});
    try{
      await runThinkCli(engine,args);const first=JSON.parse(output.at(-1)!);expect(first.question).toBe('Orbit');expect(first.cost_usd).toBeNull();expect(first.codex_publication).toBeUndefined();
      expect(first.saved_slug).toStartWith('synthesis/orbit-');expect(await engine.getPage(first.saved_slug,{sourceId:f.sourceId})).not.toBeNull();
      const count=f.calls().length;await runThinkCli(engine,args);expect(JSON.parse(output.at(-1)!).saved_slug).toBe(first.saved_slug);expect(f.calls().length).toBe(count);
    }finally{exit.mockRestore();log.mockRestore();}
  });
  test('think allowance identity rejects changed questions, caps and malformed flags before inference',async()=>{
    const engine=f.engine(),args=flags(),before=f.calls().length;let executed=0;
    await withThinkSubscription(engine,args,opts(),async()=>{executed++;});
    await expect(withThinkSubscription(engine,args,{...opts(),question:'Changed'},async()=>{})).rejects.toMatchObject({code:'subscription_identity_conflict'});
    await expect(withThinkSubscription(engine,[...args,'--max-usd','1'],opts(),async()=>{})).rejects.toMatchObject({code:'subscription_identity_conflict'});
    await expect(withThinkSubscription(engine,[],opts(),async()=>{})).rejects.toThrow('all three');
    await expect(withThinkSubscription(engine,[...flags(),'--codex-request-id',randomUUID()],opts(),async()=>{})).rejects.toThrow('one --codex-request-id');
    await expect(withThinkSubscription(engine,['--codex-max-attempts=2'],opts(),async()=>{})).rejects.toThrow('malformed');
    expect(executed).toBe(1);expect(f.calls().length).toBe(before);
  });
  test('independent paid retrieval cap admits measured usage and preserves unknown usage holds',async()=>{
    const engine=f.engine(),args=flags(randomUUID(),['--max-usd','0.00003']);let dispatched=0;
    const call=()=>invokeAI({operation:'fixture.embedding',kind:'embedding',model:'openai:text-embedding-3-small',maxInputTokens:1000},async()=>{dispatched++;return 'ok';},()=>null);
    await withThinkSubscription(engine,args,opts(),call);expect(dispatched).toBe(1);
    await expect(withThinkSubscription(engine,args,opts(),call)).rejects.toThrow('budget');expect(dispatched).toBe(1);
    const rows=await engine.executeRaw<{status:string;usage_unknown_reason:string}>("SELECT status,usage_unknown_reason FROM mcp_spend_reservations WHERE budget_key LIKE $1",[`group:codex-think:${args[1]}:%`]);
    expect(rows).toEqual([{status:'pending',usage_unknown_reason:'provider_usage_unknown'}]);
    const measured=flags(randomUUID(),['--max-usd','0.01']);
    await withThinkSubscription(engine,measured,opts(),()=>invokeAI({operation:'fixture.embedding',kind:'embedding',model:'openai:text-embedding-3-small',maxInputTokens:1000},async()=>true,()=>({inputTokens:10,outputTokens:0})));
    expect(await engine.executeRaw('SELECT id FROM mcp_spend_log WHERE budget_key LIKE $1',[`group:codex-think:${measured[1]}:%`])).toHaveLength(1);
  });
  test('a swallowed auxiliary admission refusal still fails the whole private command',async()=>{
    let dispatched=0;
    await expect(withThinkSubscription(f.engine(),flags(),opts(),async()=>{
      try{await invokeAI({operation:'fixture.embedding',kind:'embedding',model:'openai:text-embedding-3-small',maxInputTokens:1000},async()=>{dispatched++;},()=>null);}catch{}
      return 'apparently complete';
    })).rejects.toMatchObject({code:'subscription_auxiliary_budget_required'});expect(dispatched).toBe(0);
  });
  test('automatic think dry run never consumes an allowance or creates retained results',async()=>{
    const engine=f.engine();await engine.setConfig('dream.auto_think.enabled','true');const count=f.calls().length;
    expect((await runPhaseAutoThink(engine,{dryRun:true,sourceId:f.sourceId})).status).toBe('skipped');expect(f.calls().length).toBe(count);
  });
  test('automatic think retains drafts and only completes after every selected question succeeds',async()=>{
    const engine=f.engine();await engine.setConfig('dream.auto_think.enabled','true');
    await f.run(async id=>{
      const original=engine.executeRaw;let changed=false;
      const fault=spyOn(engine,'executeRaw').mockImplementation(async function<T>(this:BrainEngine,sql:string,params?:unknown[],options?:Parameters<BrainEngine['executeRaw']>[2]):Promise<T[]>{
        const result=await original.call(this,sql,params,options);
        if(!changed&&sql.startsWith('UPDATE codex_auto_think_runs SET results=')&&params?.[2]==='0'&&String(params?.[3]).includes('"state":"complete"')){changed=true;f.reply({answer:'',citations:[],gaps:['No conclusion.']});}
        return result as T[];
      });
      try{expect((await runPhaseAutoThink(engine,{dryRun:false,sourceId:f.sourceId})).status).toBe('partial');}finally{fault.mockRestore();}
      const [partial]=await engine.executeRaw<{state:string;completed_at:unknown}>('SELECT state,completed_at FROM codex_auto_think_runs WHERE run_id=$1',[id]);expect(partial).toEqual({state:'accepted',completed_at:null});
      const beforeNewRun=f.calls().length;
      await f.run(async()=>{await expect(runPhaseAutoThink(engine,{dryRun:false,sourceId:f.sourceId})).rejects.toMatchObject({code:'write_pending'});});expect(f.calls().length).toBe(beforeNewRun);
      f.reply(f.valid);const count=f.calls().length;
      expect((await runPhaseAutoThink(engine,{dryRun:false,sourceId:f.sourceId})).status).toBe('complete');expect(f.calls().length-count).toBe(1);
      const [row]=await engine.executeRaw<{results:Record<string,{result:{answer:string}}>;state:string}>('SELECT state,results FROM codex_auto_think_runs WHERE run_id=$1',[id]);expect(row!.state).toBe('complete');expect(Object.keys(row!.results)).toHaveLength(2);expect(row!.results['0']!.result.answer).toContain('Orbit');
      const settled=f.calls().length;expect((await runPhaseAutoThink(engine,{dryRun:false,sourceId:f.sourceId})).status).toBe('complete');expect(f.calls().length).toBe(settled);
    });
  });
  test('valid empty automatic answers do not start cooldown',async()=>{
    const engine=f.engine();await engine.setConfig('dream.auto_think.enabled','true');f.reply({answer:'',citations:[],gaps:['No conclusion.']});
    await f.run(async id=>{expect((await runPhaseAutoThink(engine,{dryRun:false,sourceId:f.sourceId})).status).toBe('partial');
      expect((await engine.executeRaw<{completed_at:unknown}>('SELECT completed_at FROM codex_auto_think_runs WHERE run_id=$1',[id]))[0]!.completed_at).toBeNull();
      f.reply(f.valid);expect((await runPhaseAutoThink(engine,{dryRun:false,sourceId:f.sourceId})).status).toBe('complete');
    });
  });
  test('automatic saves complete from publication receipts and enforce source-scoped cooldown',async()=>{
    const engine=f.engine();await engine.setConfig('dream.auto_think.enabled','true');await engine.setConfig('dream.auto_think.auto_commit','true');
    await f.run(async id=>{expect((await runPhaseAutoThink(engine,{dryRun:false,sourceId:f.sourceId})).status).toBe('complete');
      expect(await engine.executeRaw("SELECT plan_id FROM codex_think_publications WHERE run_id=$1 AND state='complete'",[id])).toHaveLength(2);
    });
    await engine.setConfig('dream.auto_think.cooldown_days','30');const count=f.calls().length;
    await f.run(async()=>{expect((await runPhaseAutoThink(engine,{dryRun:false,sourceId:f.sourceId})).status).toBe('skipped');});expect(f.calls().length).toBe(count);
  });
  test('automatic think rejects a foreign brain and conflicting pins before creating a batch',async()=>{
    const engine=f.engine();await engine.setConfig('dream.auto_think.enabled','true');
    await f.run(async id=>{
      const foreign=new Proxy(engine,{get(target,key){if(key==='executeRaw')return async()=>[{brain_id:randomUUID()}];const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
      await expect(runPhaseAutoThink(foreign,{dryRun:false,sourceId:f.sourceId})).rejects.toMatchObject({code:'subscription_identity_conflict'});
      await engine.setConfig('models.auto_think','anthropic:claude-sonnet-4-6');
      try{await expect(runPhaseAutoThink(engine,{dryRun:false,sourceId:f.sourceId})).rejects.toThrow('private');}
      finally{await engine.setConfig('models.auto_think','');}
      expect(await engine.executeRaw('SELECT run_id FROM codex_auto_think_runs WHERE run_id=$1',[id])).toHaveLength(0);
    });
  });
  test('a replacement worker cannot resume the original batch fence before inference',async()=>{
    const engine=f.engine(),sourceId='auto-fence-fixture',data={source_id:sourceId},authority={kind:'application',version:1};
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)',[sourceId,'Worker fixture']);
    await engine.putPage('notes/orbit',{type:'note',title:'Orbit',compiled_truth:'Orbit launched in March.'},{sourceId});
    const [job]=await engine.executeRaw<{id:number}>("INSERT INTO minion_jobs(name,status,lock_token,lock_until,data,submission_authority) VALUES('fixture','active','worker-a',now()+interval '10 minutes',$1::text::jsonb,$2::text::jsonb) RETURNING id",[JSON.stringify(data),JSON.stringify(authority)]);
    await engine.setConfig('dream.auto_think.enabled','true');f.reply({answer:'',citations:[],gaps:['No conclusion.']});
    const fence={jobId:job!.id,lockToken:'worker-a',jobDigest:digest({data,authority})};
    await f.run(async runId=>{
      expect((await runPhaseAutoThink(engine,{dryRun:false,sourceId})).status).toBe('partial');
      await engine.executeRaw("UPDATE minion_jobs SET lock_token='worker-b',claim_generation=claim_generation+1 WHERE id=$1",[job!.id]);
      const before=f.calls().length;f.reply(f.valid);
      await withCodexSubscription({engine,runId,publicationFence:{...fence,lockToken:'worker-b'}},async()=>{
        await expect(runPhaseAutoThink(engine,{dryRun:false,sourceId})).rejects.toMatchObject({code:'write_claim_lost'});
      });
      expect(f.calls().length).toBe(before);
    },{publicationFence:fence});
  });
  test('cycle cancellation reaches the active native call and leaves its batch incomplete',async()=>{
    const engine=f.engine(),sourceId='auto-cancel-fixture';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)',[sourceId,'Cancellation fixture']);
    await engine.putPage('notes/orbit',{type:'note',title:'Orbit',compiled_truth:'Orbit launched in March.'},{sourceId});
    await engine.setConfig('dream.auto_think.enabled','true');f.reply({wait:true});
    await f.run(async id=>{
      const controller=new AbortController(),before=f.calls().length;
      const promise=runPhaseAutoThink(engine,{dryRun:false,sourceId,signal:controller.signal});
      const outcome=promise.then(()=>null,error=>error);
      try{
        for(let i=0;i<200&&f.calls().length===before;i++)await new Promise(r=>setTimeout(r,10));
        expect(f.calls().length).toBe(before+1);
      }finally{controller.abort();}
      expect(await outcome).toMatchObject({reason:'aborted'});
      expect((await engine.executeRaw<{state:string}>('SELECT state FROM codex_auto_think_runs WHERE run_id=$1',[id]))[0]!.state).toBe('accepted');
      expect((await engine.executeRaw<{state:string}>('SELECT state FROM codex_subscription_attempts WHERE run_id=$1',[id]))[0]!.state).toBe('unresolved');
      const after=f.calls().length;
      await f.run(async()=>{await expect(runPhaseAutoThink(engine,{dryRun:false,sourceId})).rejects.toMatchObject({code:'write_pending'});});expect(f.calls().length).toBe(after);
    });
  });
  test('the real cycle dispatcher runs the opted-in automatic think phase',async()=>{
    const engine=f.engine();await engine.setConfig('dream.auto_think.enabled','true');await engine.setConfig('dream.auto_think.questions','["Foreign"]');
    f.reply({answer:'Foreign private reference. [notes/foreign]',citations:[{page_slug:'notes/foreign',row_num:null,citation_index:1}],gaps:[]});
    await f.run(async()=>{
      const result=await runCycle(engine,{brainDir:f.root,phases:['auto_think'],dryRun:false});
      expect(result.phases.find(p=>p.phase==='auto_think')).toMatchObject({status:'ok',details:{billing:'subscription',cost_usd:null,synthesized:1}});
    });
  });
}
