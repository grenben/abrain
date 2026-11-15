import { withDistinctCodexModels } from './codex-role-fixture.ts';
import { describe, beforeEach, test, expect, spyOn } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { configPath } from '../../src/core/config-path.ts';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { preparePrivateAbTrial, inspectPrivateAbTrial, recordPrivateAbPreference } from '../../src/core/calibration/think-ab-codex.ts';
import { runAbTrial, buildAbReport } from '../../src/core/calibration/think-ab.ts';
import { runCalibration } from '../../src/commands/calibration.ts';
import type { CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { declareDurablePersistence } from '../../src/core/persistence/protocol.ts';
import { digest } from '../../src/core/persistence/digest.ts';
interface Fixture {
  engine():BrainEngine;sourceId:string;
  run<T>(fn:(id:string)=>Promise<T>,hooks?:Partial<CodexSubscriptionContext>,maxAttempts?:number):Promise<T>;
  reply(value:unknown):void;valid:unknown;calls():any[];
}
export function codexThinkAbContract(f:Fixture){describe('native calibration A/B trials',()=>{
  const input=(trialId=randomUUID())=>({engine:f.engine(),sourceId:f.sourceId,remote:false,question:'Orbit',holder:'self',trialId});
  beforeEach(async()=>{
    for(const [source,text] of [[f.sourceId,'LOCAL AB PROFILE'],['default','FOREIGN AB PROFILE']])
      await f.engine().executeRaw(`INSERT INTO calibration_profiles(source_id,holder,published,total_resolved,pattern_statements,active_bias_tags,model_id,domain_scorecards,voice_gate_passed,voice_gate_attempts) VALUES($1,'self',false,5,$2::text[],ARRAY[]::text[],'fixture','{}'::jsonb,true,1)`,[source,[text]]);
  });
  test('A/B revocation inside an awaited host fence stops before any trial or inference', async () => {
    const path = configPath(), saved = readFileSync(path, 'utf8'), opts = input(), count = f.calls().length;
    try {
      await f.run(async () => {
        await expect(preparePrivateAbTrial(opts)).rejects.toMatchObject({ code: 'private_route_conflict' });
      }, { checkAuthority: async () => {
        const value = JSON.parse(saved); value.private_codex.enabled_roles = [];
        writeFileSync(path, JSON.stringify(value));
      } });
      expect(await f.engine().executeRaw('SELECT trial_id FROM codex_think_ab_trials WHERE trial_id=$1::uuid', [opts.trialId])).toEqual([]);
      expect(f.calls().length).toBe(count);
    } finally { writeFileSync(path, saved); }
  });
  test('both nested think calls retain the A/B role and choose deep over the core reasoning tier', async () => {
    await withDistinctCodexModels(async () => {
      const before = f.calls().length;
      await f.run(async () => { expect((await preparePrivateAbTrial(input())).state).toBe('ready'); });
      expect(f.calls().slice(before).map(wire => wire.args[wire.args.indexOf('--model') + 1])).toEqual(['deep-fixture', 'deep-fixture']);
    });
  });
  test('two native calls retain grounded answers and profile provenance without inventing a preference',async()=>{
    const opts=input(),before=f.calls().length;
    await f.run(async()=>{
      const trial=await preparePrivateAbTrial(opts);expect(trial.state).toBe('ready');expect(trial.result_id).toBeNull();
      expect(trial.baseline?.codex_evidence_hash).toMatch(/^[a-f0-9]{64}$/);expect(trial.calibrated?.codex_evidence_hash).not.toBe(trial.baseline?.codex_evidence_hash);
      expect(trial.baseline?.citations).toHaveLength(1);expect(trial.calibrated?.usage).toEqual({input_tokens:21,output_tokens:9});
      expect(trial.binding.profile.source_id).toBe(f.sourceId);expect(trial.binding.profile.pattern_statements).toEqual(['LOCAL AB PROFILE']);
      expect(f.calls()[before].prompt).not.toContain('LOCAL AB PROFILE');expect(f.calls()[before+1].prompt).toContain('LOCAL AB PROFILE');expect(f.calls()[before+1].prompt).not.toContain('FOREIGN AB PROFILE');
      await preparePrivateAbTrial(opts);expect(f.calls().length-before).toBe(2);
    });
    const count=f.calls().length;
    const id=await recordPrivateAbPreference(f.engine(),f.sourceId,opts.trialId,false,'with_calibration','Useful framing');
    expect(await recordPrivateAbPreference(f.engine(),f.sourceId,opts.trialId,false,'with_calibration','Useful framing')).toBe(id);
    await expect(recordPrivateAbPreference(f.engine(),f.sourceId,opts.trialId,false,'baseline')).rejects.toMatchObject({code:'idempotency_conflict'});
    expect((await inspectPrivateAbTrial(f.engine(),f.sourceId,opts.trialId,false)).state).toBe('rated');expect(f.calls().length).toBe(count);
  });
  test('partial trials resume the retained baseline and failures cannot become ratings',async()=>{
    const opts=input(),engine=f.engine();
    await f.run(async()=>{
      const original=engine.executeRaw;let changed=false;
      const fault=spyOn(engine,'executeRaw').mockImplementation(async function<T>(this:BrainEngine,sql:string,params?:unknown[],options?:Parameters<BrainEngine['executeRaw']>[2]):Promise<T[]>{
        const rows=await original.call(this,sql,params,options);
        if(!changed&&sql.startsWith('UPDATE codex_think_ab_trials SET baseline=')){changed=true;f.reply({answer:'',citations:[],gaps:['No supported conclusion.']});}
        return rows as T[];
      });
      try{await expect(preparePrivateAbTrial(opts)).rejects.toMatchObject({code:'invalid_params'});}finally{fault.mockRestore();}
      const partial=await inspectPrivateAbTrial(engine,f.sourceId,opts.trialId,false);expect(partial.state).toBe('accepted');expect(partial.baseline?.answer).toContain('Orbit');expect(partial.calibrated).toBeNull();
      await expect(recordPrivateAbPreference(engine,f.sourceId,opts.trialId,false,'neither')).rejects.toMatchObject({code:'write_pending'});
      f.reply(f.valid);const count=f.calls().length;expect((await preparePrivateAbTrial(opts)).state).toBe('ready');expect(f.calls().length-count).toBe(1);
    });
  });
  test.each([{raw:'malformed'},{refusal:true},{missingCompletion:true}])('invalid lifecycle or content never creates a trial result',async reply=>{
    const opts=input();f.reply(reply);
    await f.run(async()=>{await expect(preparePrivateAbTrial(opts)).rejects.toThrow();});
    const trial=await inspectPrivateAbTrial(f.engine(),f.sourceId,opts.trialId,false);expect(trial.state).toBe('accepted');expect(trial.baseline).toBeNull();expect(trial.result_id).toBeNull();
  });
  test('profile drift after baseline refuses further inference and preserves the partial trial',async()=>{
    const opts=input(),engine=f.engine();
    await f.run(async()=>{
      const original=engine.executeRaw;let changed=false;
      const fault=spyOn(engine,'executeRaw').mockImplementation(async function<T>(this:BrainEngine,sql:string,params?:unknown[],options?:Parameters<BrainEngine['executeRaw']>[2]):Promise<T[]>{
        const rows=await original.call(this,sql,params,options);
        if(!changed&&sql.startsWith('UPDATE codex_think_ab_trials SET baseline=')){changed=true;await original.call(this,"UPDATE calibration_profiles SET pattern_statements=ARRAY['Changed profile'] WHERE source_id=$1",[f.sourceId]);}
        return rows as T[];
      });
      const count=f.calls().length;
      try{await expect(preparePrivateAbTrial(opts)).rejects.toMatchObject({code:'revision_conflict'});}finally{fault.mockRestore();}
      expect(f.calls().length-count).toBe(1);expect((await inspectPrivateAbTrial(engine,f.sourceId,opts.trialId,false)).baseline).not.toBeNull();
    });
  });
  test('changed take evidence refuses the second call while retaining the original provenance',async()=>{
    const opts=input(),engine=f.engine();
    const [take]=await engine.executeRaw<{id:number;claim:string}>("SELECT t.id,t.claim FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug='notes/orbit' AND t.row_num=1",[f.sourceId]);
    await f.run(async()=>{
      const original=engine.executeRaw;let changed=false;
      const fault=spyOn(engine,'executeRaw').mockImplementation(async function<T>(this:BrainEngine,sql:string,params?:unknown[],options?:Parameters<BrainEngine['executeRaw']>[2]):Promise<T[]>{
        const rows=await original.call(this,sql,params,options);
        if(!changed&&sql.startsWith('UPDATE codex_think_ab_trials SET baseline=')){changed=true;await original.call(this,"UPDATE takes SET claim='Changed fixture evidence' WHERE id=$1",[take!.id]);}
        return rows as T[];
      });
      const count=f.calls().length;
      try{await expect(preparePrivateAbTrial(opts)).rejects.toMatchObject({code:'revision_conflict'});expect(f.calls().length-count).toBe(1);}
      finally{fault.mockRestore();await engine.transaction(async tx=>{await declareDurablePersistence(tx);await tx.executeRaw('UPDATE takes SET claim=$2 WHERE id=$1',[take!.id,take!.claim]);});}
      expect((await inspectPrivateAbTrial(engine,f.sourceId,opts.trialId,false)).baseline?.comparison_evidence.some(e=>e.takes.some(t=>Number(t.id)===Number(take!.id)))).toBe(true);
    });
  });
  test('missing profile, remote callers, injected runners and conflicting pins fail before inference',async()=>{
    const engine=f.engine(),opts=input(),before=f.calls().length;
    await f.run(async()=>{
      await expect(preparePrivateAbTrial({...opts,remote:true})).rejects.toMatchObject({code:'permission_denied'});
      await expect(runAbTrial({...opts,thinkRunner:async()=>({answer:'forged'}),preferenceResolver:async()=> 'tie'})).rejects.toMatchObject({code:'invalid_params'});
      await engine.setConfig('models.think','anthropic:claude-sonnet-4-6');
      try{await expect(preparePrivateAbTrial(opts)).rejects.toThrow('private');}finally{await engine.setConfig('models.think','');}
      await engine.executeRaw('DELETE FROM calibration_profiles WHERE source_id=$1',[f.sourceId]);
      await expect(preparePrivateAbTrial(opts)).rejects.toMatchObject({code:'not_found'});
    });expect(f.calls().length).toBe(before);
  });
  test('oversized profiles fail before a trial or model call is admitted',async()=>{
    const opts=input(),before=f.calls().length;
    await f.engine().executeRaw('UPDATE calibration_profiles SET pattern_statements=$2::text[] WHERE source_id=$1',[f.sourceId,['x'.repeat(600000)]]);
    await f.run(async()=>{await expect(preparePrivateAbTrial(opts)).rejects.toMatchObject({code:'invalid_params'});});
    expect(f.calls().length).toBe(before);expect(await f.engine().executeRaw('SELECT trial_id FROM codex_think_ab_trials WHERE trial_id=$1::uuid',[opts.trialId])).toHaveLength(0);
  });
  test('quota exhaustion retains baseline without a false completed comparison',async()=>{
    const opts=input(),before=f.calls().length;
    await f.run(async()=>{await expect(preparePrivateAbTrial(opts)).rejects.toMatchObject({code:'subscription_exhausted'});},{},1);
    const trial=await inspectPrivateAbTrial(f.engine(),f.sourceId,opts.trialId,false);expect(trial.baseline).not.toBeNull();expect(trial.calibrated).toBeNull();expect(trial.result_id).toBeNull();expect(f.calls().length-before).toBe(1);
  });
  test('changed question or source cannot reuse a trial identity',async()=>{
    const opts=input();await f.run(async()=>{
      await preparePrivateAbTrial(opts);const before=f.calls().length;
      await expect(preparePrivateAbTrial({...opts,question:'Changed'})).rejects.toMatchObject({code:'idempotency_conflict'});
      await expect(preparePrivateAbTrial({...opts,sourceId:'default'})).rejects.toMatchObject({code:'idempotency_conflict'});expect(f.calls().length).toBe(before);
    });await expect(inspectPrivateAbTrial(f.engine(),'default',opts.trialId,false)).rejects.toMatchObject({code:'not_found'});
  });
  test('a lost rating acknowledgement reuses the committed result identity',async()=>{
    const engine=f.engine(),opts=input();await f.run(()=>preparePrivateAbTrial(opts));
    const original=engine.transaction;let failed=false;
    const fault=spyOn(engine,'transaction').mockImplementation(async function<T>(this:BrainEngine,fn:(tx:BrainEngine)=>Promise<T>):Promise<T>{
      const result=await original.call(this,fn) as T;
      if(!failed&&typeof result==='string'){failed=true;throw new Error('synthetic lost acknowledgement');}return result;
    });
    try{await expect(recordPrivateAbPreference(engine,f.sourceId,opts.trialId,false,'tie')).rejects.toThrow('synthetic');}finally{fault.mockRestore();}
    const retained=await inspectPrivateAbTrial(engine,f.sourceId,opts.trialId,false);expect(retained.state).toBe('rated');
    expect(await recordPrivateAbPreference(engine,f.sourceId,opts.trialId,false,'tie')).toBe(String(retained.result_id));
  });
  test('worker lease loss prevents accepting answers and further inference',async()=>{
    const engine=f.engine(),opts=input(),data={source_id:f.sourceId},authority={kind:'application',version:1};
    const [job]=await engine.executeRaw<{id:number}>("INSERT INTO minion_jobs(name,status,lock_token,lock_until,data,submission_authority) VALUES('fixture','active','worker-a',now()+interval '10 minutes',$1::text::jsonb,$2::text::jsonb) RETURNING id",[JSON.stringify(data),JSON.stringify(authority)]);
    await f.run(async()=>{
      await engine.executeRaw("UPDATE minion_jobs SET lock_token='worker-b',claim_generation=claim_generation+1 WHERE id=$1",[job!.id]);const before=f.calls().length;
      await expect(preparePrivateAbTrial(opts)).rejects.toMatchObject({code:'write_claim_lost'});expect(f.calls().length).toBe(before);
    },{publicationFence:{jobId:job!.id,lockToken:'worker-a',jobDigest:digest({data,authority})}});
  });
  test('CLI runs a real trial, then shows and rates it without additional inference',async()=>{
    const engine=f.engine(),id=randomUUID(),chunks:string[]=[];
    const out=spyOn(process.stdout,'write').mockImplementation((chunk:any)=>{chunks.push(String(chunk));return true;});
    const args=['ab-run','Orbit','--source',f.sourceId,'--json','--codex-request-id',id,'--codex-max-attempts','2','--codex-max-turns','2','--codex-deadline',new Date(Date.now()+600000).toISOString()];
    try{
      await runCalibration(engine,args,{} as never);expect(JSON.parse(chunks.at(-1)!).trial_id).toBe(id);const count=f.calls().length;
      await runCalibration(engine,['ab-show',id,'--source',f.sourceId,'--json'],{} as never);expect(JSON.parse(chunks.at(-1)!).state).toBe('ready');
      await runCalibration(engine,['ab-rate',id,'--source',f.sourceId,'--prefer','baseline','--json'],{} as never);expect(JSON.parse(chunks.at(-1)!).preferred).toBe('baseline');expect(f.calls().length).toBe(count);
    }finally{out.mockRestore();}
  });
  test('the public harness dispatches native think and records only the supplied preference',async()=>{
    const opts=input(),before=f.calls().length;let asked=0;
    await f.run(async()=>{
      const result=await runAbTrial({...opts,preferenceResolver:async answers=>{asked++;expect(answers.baseline).toContain('Orbit');expect(answers.withCalibration).toContain('Orbit');return 'neither';}});
      expect(result.preferred).toBe('neither');expect(result.rowId).toBeDefined();
    });expect(asked).toBe(1);expect(f.calls().length-before).toBe(2);
  });
  test('competing preferences produce one canonical result and refuse changed input',async()=>{
    const opts=input();await f.run(()=>preparePrivateAbTrial(opts));
    const results=await Promise.allSettled(['baseline','with_calibration'].map(preferred=>recordPrivateAbPreference(f.engine(),f.sourceId,opts.trialId,false,preferred as 'baseline'|'with_calibration')));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    const trial=await inspectPrivateAbTrial(f.engine(),f.sourceId,opts.trialId,false);
    expect(await f.engine().executeRaw('SELECT id FROM think_ab_results WHERE id=$1',[trial.result_id])).toHaveLength(1);
  });
  test('active cancellation leaves no answer, vote or released subscription ownership',async()=>{
    const opts=input(),controller=new AbortController();f.reply({wait:true});
    await f.run(async id=>{
      const before=f.calls().length,outcome=preparePrivateAbTrial({...opts,signal:controller.signal}).then(()=>null,error=>error);
      try{for(let i=0;i<200&&f.calls().length===before;i++)await new Promise(r=>setTimeout(r,10));expect(f.calls().length).toBe(before+1);}
      finally{controller.abort();}
      expect(await outcome).toMatchObject({reason:'aborted'});
      const trial=await inspectPrivateAbTrial(f.engine(),f.sourceId,opts.trialId,false);expect(trial.baseline).toBeNull();expect(trial.result_id).toBeNull();
      expect((await f.engine().executeRaw<{state:string}>('SELECT state FROM codex_subscription_attempts WHERE run_id=$1',[id]))[0]!.state).toBe('unresolved');
    });
  });
  test('report windows are parameterized and source scoped',async()=>{
    const engine=f.engine();const before=await buildAbReport(engine,{sourceId:'default'});
    const opts=input();await f.run(()=>preparePrivateAbTrial(opts));await recordPrivateAbPreference(engine,f.sourceId,opts.trialId,false,'baseline');
    expect(await buildAbReport(engine,{sourceId:'default'})).toEqual(before);
    await expect(buildAbReport(engine,{days:NaN})).rejects.toMatchObject({code:'invalid_params'});
  });
});}
