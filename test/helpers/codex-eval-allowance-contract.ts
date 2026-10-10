import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runLocalLongMemEval } from '../../src/commands/eval-longmemeval-subscription.ts';
import { splitEvalAllowance } from '../../src/eval/longmemeval/codex-allowance-flags.ts';
import { createSubscriptionRun, reserveSubscriptionAttempt, settleSubscriptionAttempt } from '../../src/core/ai/subscription-admission.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../../src/core/minions/subscription-jobs.ts';
import { configureGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { digest } from '../../src/core/persistence/digest.ts';

interface Fixture { root: string; engine(): BrainEngine; reply(value: unknown): void; calls(): unknown[] }
export function codexEvalAllowanceContract(f: Fixture) { describe('local Codex evaluation allowances', () => {
  const body='Aster moved to the coast.';
  const fixture=()=>{
    const root=mkdtempSync(join(tmpdir(),'codex-eval-allowance-')),dataset=join(root,'input.jsonl'),output=join(root,'output.jsonl');
    writeFileSync(dataset,JSON.stringify({question_id:'local-fixture',question_type:'single-session-user',question:'Where did Aster move?',answer:'The coast',
      answer_session_ids:['s1'],haystack_dates:['2026-06-02'],haystack_sessions:[{session_id:'s1',turns:[{role:'user',content:body}]}]}));
    f.reply({byRole:{reader:{answer:body,status:'answered',citations:[{session_id:'__first_session__',quote:body}]},judge:{answer:'yes'}}});
    const id=randomUUID(),deadline=new Date(Date.now()+600000).toISOString();let connects=0,closes=0;
    const flags=['--codex-request-id',id,'--codex-max-attempts','4','--codex-max-turns','4','--codex-deadline',deadline];
    const args=[dataset,'--keyword-only','--no-trajectory','--no-embed-cache','--output',output];
    const connect=async()=>{connects++;return{engine:f.engine(),close:async()=>{closes++;}};};
    const run=(grants=flags,base=args)=>runLocalLongMemEval([...base,...grants],connect);
    return{root,dataset,output,id,deadline,flags,args,connect,run,counts:()=>({connects,closes}),runId:`codex-eval:${id}`};
  };
  const grant=async(id:string)=>(await f.engine().executeRaw<{account_lane:string;attempts:number;accepted_turns:number}>(
    'SELECT account_lane,attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[id]))[0];
  test('local CLI creates a shared-lane grant, retains results and replays without another call',async()=>{
    const t=fixture(),before=f.calls().length,pages=await f.engine().executeRaw('SELECT id FROM pages');
    try{await t.run();expect(await grant(t.runId)).toEqual({account_lane:CODEX_JOB_ACCOUNT_LANE,attempts:1,accepted_turns:1});
      expect((await f.engine().executeRaw('SELECT id FROM pages'))).toEqual(pages);
      await t.run();expect(f.calls().length-before).toBe(1);expect(t.counts()).toEqual({connects:2,closes:2});
      expect(JSON.parse(readFileSync(t.output,'utf8').trim()).hypothesis).toBe(body);
    }finally{rmSync(t.root,{recursive:true,force:true});}
  });
  test.each(['--codex-max-attempts','--codex-max-turns','--codex-deadline','--aux-max-usd'])('changed %s cannot reuse an allowance identity',async flag=>{
    const t=fixture(),before=f.calls().length;
    try{await t.run();const flags=[...t.flags];
      if(flag==='--aux-max-usd')flags.push(flag,'1');else flags[flags.indexOf(flag)+1]=flag==='--codex-deadline'?new Date(Date.now()+500000).toISOString():flag==='--codex-max-attempts'?'5':'3';
      await expect(t.run(flags)).rejects.toMatchObject({code:'subscription_identity_conflict'});expect(f.calls().length-before).toBe(1);
    }finally{rmSync(t.root,{recursive:true,force:true});}
  });
  test('an expired identical stored allowance exports receipts while a new expired allowance is refused',async()=>{
    const t=fixture(),before=f.calls().length;
    try{await t.run();const expired=new Date(Date.now()-1000).toISOString(),flags=[...t.flags];flags[flags.indexOf('--codex-deadline')+1]=expired;
      // Move the synthetic persisted deadline across the clock boundary; replay supplies that exact stored value.
      await f.engine().executeRaw('UPDATE codex_subscription_runs SET deadline=$2 WHERE run_id=$1',[t.runId,expired]);
      await t.run(flags);expect(f.calls().length-before).toBe(1);
      const another=randomUUID();flags[1]=another;
      await expect(t.run(flags)).rejects.toMatchObject({code:'subscription_invalid'});expect(await grant(`codex-eval:${another}`)).toBeUndefined();
    }finally{rmSync(t.root,{recursive:true,force:true});}
  });
  test('help, absent consent and invalid flags do not connect an owner or infer',async()=>{
    const t=fixture(),before=f.calls().length;
    try{await runLocalLongMemEval(['--help'],t.connect);
      await expect(t.run([])).rejects.toThrow('explicit subscription allowance');
      const future=[...t.flags];future[future.indexOf('--codex-deadline')+1]=new Date(Date.now()+172800000).toISOString();
      for(const flags of [['--codex-max-attempts','1'],[...t.flags,'--codex-max-turns','1'],['--codex-max-attempts=1'],['--codex-unknown','1'],future,[...t.flags,'--aux-max-usd','0']])
        await expect(t.run(flags)).rejects.toThrow('Invalid private evaluation allowance');
      expect(t.counts()).toEqual({connects:0,closes:0});expect(f.calls().length).toBe(before);
    }finally{rmSync(t.root,{recursive:true,force:true});}
  });
  test('pure keyword retrieval needs neither a host grant nor inference',async()=>{
    const t=fixture(),before=f.calls().length;
    try{await t.run([], [...t.args,'--retrieval-only']);expect(t.counts()).toEqual({connects:0,closes:0});expect(f.calls().length).toBe(before);
    }finally{rmSync(t.root,{recursive:true,force:true});}
  });
  test('missing schema and conflicting owner pins fail before grant creation and always close the owner',async()=>{
    const t=fixture(),engine=f.engine(),getConfig=engine.getConfig,before=f.calls().length;
    try{engine.getConfig=async key=>key==='version'?'236':getConfig.call(engine,key);
      await expect(t.run()).rejects.toThrow('v257');engine.getConfig=getConfig;
      await engine.setConfig('models.eval.longmemeval','anthropic:fixture');
      await expect(t.run()).rejects.toMatchObject({code:'private_route_conflict'});
      expect(await grant(t.runId)).toBeUndefined();expect(f.calls().length).toBe(before);expect(t.counts()).toEqual({connects:2,closes:2});
    }finally{engine.getConfig=getConfig;await engine.setConfig('models.eval.longmemeval','');rmSync(t.root,{recursive:true,force:true});}
  });
  test('a busy shared account lane blocks local evaluation without provider fallback',async()=>{
    const t=fixture(),other=`fixture-${randomUUID()}`,before=f.calls().length;
    await createSubscriptionRun(f.engine(),{runId:other,accountLane:CODEX_JOB_ACCOUNT_LANE,maxAttempts:1,maxTurns:1,deadline:new Date(Date.now()+600000)});
    const attempt=await reserveSubscriptionAttempt(f.engine(),{runId:other,attemptId:randomUUID(),requestHash:digest(other),timeoutMs:1000});
    try{await expect(t.run()).rejects.toThrow();expect(f.calls().length).toBe(before);expect((await grant(t.runId))?.attempts).toBe(0);
      await settleSubscriptionAttempt(f.engine(),attempt,{state:'failed',failureCode:'fixture_not_dispatched'});await t.run();expect(f.calls().length-before).toBe(1);
    }finally{rmSync(t.root,{recursive:true,force:true});}
  });
  test('mixed retrieval requires its own cap, settles measured API usage and binds that cap for recovery',async()=>{
    const t=fixture(),configPath=join(f.root,'.gbrain','config.json'),original=readFileSync(configPath,'utf8');let embeds=0;
    writeFileSync(configPath,JSON.stringify({...JSON.parse(original),embedding_disabled:false}));
    configureGateway({embedding_model:'openai:text-embedding-3-small',embedding_dimensions:1536,env:{OPENAI_API_KEY:'sk-fixture-not-a-credential'}});
    __setEmbedTransportForTests(async({values}:{values:string[]})=>{embeds++;return{embeddings:values.map(()=>[1,...Array(1535).fill(0)]),usage:{tokens:17}} as never;});
    const hybrid=t.args.filter(arg=>arg!=='--keyword-only').concat(['--reranker','off','--mode','balanced']);
    try{await expect(t.run([...t.flags,'--max-usd','1'],hybrid)).rejects.toThrow();expect(embeds).toBe(0);
      const fresh=[...t.flags];fresh[1]=randomUUID();await t.run([...fresh,'--aux-max-usd','0.1'],hybrid);expect(embeds).toBeGreaterThan(0);
      const rows=await f.engine().executeRaw<{status:string}>('SELECT status FROM mcp_spend_reservations WHERE budget_key=$1',[`group:codex-eval:${fresh[1]}`]);
      expect(rows.length).toBeGreaterThan(0);expect(rows.every(row=>row.status==='settled')).toBe(true);
      const count=embeds;await expect(t.run([...fresh,'--aux-max-usd','0.2'],hybrid)).rejects.toMatchObject({code:'subscription_identity_conflict'});expect(embeds).toBe(count);
    }finally{__setEmbedTransportForTests(null);configureGateway({embedding_dimensions:1536,env:{}});writeFileSync(configPath,original);rmSync(t.root,{recursive:true,force:true});}
  });
  test('allowance parser preserves the base args and canonicalizes bounded identity',()=>{
    const t=fixture();try{expect(splitEvalAllowance([...t.args,...t.flags]).args).toEqual(t.args);
      expect(splitEvalAllowance(t.flags).allowance).toMatchObject({requestId:t.id,maxAttempts:4,maxTurns:4,deadline:new Date(t.deadline)});
    }finally{rmSync(t.root,{recursive:true,force:true});}
  });
}); }
