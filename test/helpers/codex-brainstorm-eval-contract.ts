import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { runPrivateBrainstormEval } from '../../src/eval/brainstorm/codex.ts';
import { DEFAULT_BRAINSTORM_THRESHOLDS } from '../../src/eval/brainstorm/metrics.ts';
import { runEvalBrainstorm } from '../../src/commands/eval-brainstorm.ts';
import { withBrainstormAllowance } from '../../src/core/brainstorm/codex-local-grant.ts';
import { runBrainstorm, BRAINSTORM_PROFILE } from '../../src/core/brainstorm/orchestrator.ts';
import { claimEvalRun, releaseEvalRun } from '../../src/eval/longmemeval/codex-run-store.ts';
import { digest } from '../../src/core/persistence/digest.ts';
import { installFixtureChunks } from './page-projection.ts';
interface Fixture {root:string;engine():BrainEngine;reply(value:unknown):void;calls():Array<any>;
  run<T>(fn:(id:string)=>Promise<T>,hooks?:Partial<CodexSubscriptionContext>,maxAttempts?:number):Promise<T>}
export function codexBrainstormEvalContract(f:Fixture){describe('native brainstorm evaluation',()=>{
  let source:string,path:string;
  const run=(extra:Record<string,unknown>={})=>runPrivateBrainstormEval(f.engine(),{path,source,thresholds:DEFAULT_BRAINSTORM_THRESHOLDS,...extra});
  beforeEach(async()=>{
    source=`brainstorm-eval-${randomUUID().slice(0,8)}`;path=join(f.root,source+'.jsonl');
    writeFileSync(path,'{"question":"Orbital launch first"}\n{"question":"Orbital launch second"}\n');
    await f.engine().executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
    for(const [slug,body] of [['notes/launch','Orbital launch planning uses staged readiness checks.'],['concepts/geometry','Triangles have geometric constraints.']]){
      await f.engine().putPage(slug!,{type:'note',title:slug!,compiled_truth:body!},{sourceId:source});
      await installFixtureChunks(f.engine(),slug!,[{chunk_index:0,chunk_text:body!,chunk_source:'compiled_truth'}],{sourceId:source});
    }
    f.reply({autoBrainstorm:true});
  });
  afterEach(async()=>{await f.engine().executeRaw('UPDATE sources SET archived=true WHERE id=$1',[source]);});
  test('two fixtures consume one shared grant and retain separate complete receipts',async()=>{
    const before=f.calls().length;
    await f.run(async id=>{
      const report=await run();expect(report).toMatchObject({schema_version:2,verdict:'pass',completed_fixtures:2,selected_fixtures:2,total_cost_usd:null});
      expect(f.calls().length-before).toBe(4);
      expect(await f.engine().executeRaw('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[id])).toEqual([{attempts:4,accepted_turns:4}]);
      expect(await f.engine().executeRaw('SELECT protocol,state FROM codex_brainstorm_runs WHERE subscription_run_id=$1 ORDER BY run_id',[id])).toEqual([{protocol:2,state:'complete'},{protocol:2,state:'complete'}]);
      expect(await run()).toEqual(report);expect(f.calls().length-before).toBe(4);
      expect(await f.engine().executeRaw("SELECT state,question_count FROM codex_eval_runs WHERE run_id=$1",[id])).toEqual([{state:'complete',question_count:2}]);
    });
  });
  test('one exhausted batch cannot receive fresh per-fixture limits or a passing partial verdict',async()=>{
    const before=f.calls().length;await f.run(async id=>{
      expect(await run()).toMatchObject({verdict:'inconclusive',completed_fixtures:1,failure_code:'subscription_exhausted'});
      expect(f.calls().length-before).toBe(3);
      expect(await f.engine().executeRaw('SELECT stage FROM codex_eval_results WHERE run_id=$1',[id])).toEqual([{stage:'answer'}]);
      expect(await run()).toMatchObject({verdict:'inconclusive',completed_fixtures:1,failure_code:'subscription_exhausted'});
      expect(f.calls().length-before).toBe(3);
    },{},3);
  });
  test('failed later fixtures are not cached judgments; retry reuses earlier successes',async()=>{
    const before=f.calls().length;f.reply({autoBrainstorm:true,failCrossQuestion:'second'});
    await f.run(async id=>{
      expect(await run()).toMatchObject({verdict:'inconclusive',completed_fixtures:1,failure_code:'invalid_output'});
      expect(await f.engine().executeRaw('SELECT count(*)::int AS count FROM codex_eval_results WHERE run_id=$1',[id])).toEqual([{count:1}]);
      f.reply({autoBrainstorm:true});expect(await run()).toMatchObject({verdict:'pass',completed_fixtures:2});expect(f.calls().length-before).toBe(5);
    },{},8);
  });
  test('valid empty output completes fixtures without pretending a useful grade exists',async()=>{
    f.reply({autoBrainstorm:true,emptyCross:true});await f.run(async id=>{
      const report=await run();expect(report).toMatchObject({verdict:'inconclusive',completed_fixtures:2,parseable_fixtures:0});
      expect(report.per_fixture.every(r=>r.outcome==='empty'&&r.mean_usefulness===null&&!r.judge_failed)).toBe(true);
      expect(await f.engine().executeRaw('SELECT state FROM codex_eval_runs WHERE run_id=$1',[id])).toEqual([{state:'complete'}]);
    });
  });
  test('changed dataset, thresholds and source refuse the old identity before new inference',async()=>{
    await f.run(async()=>{
      await run();const before=f.calls().length,bytes=readFileSync(path,'utf8');
      writeFileSync(path,bytes.replace('second','changed'));await expect(run()).rejects.toMatchObject({code:'subscription_identity_conflict'});writeFileSync(path,bytes);
      await expect(run({thresholds:{...DEFAULT_BRAINSTORM_THRESHOLDS,distance_min:0.3}})).rejects.toMatchObject({code:'subscription_identity_conflict'});
      await expect(run({source:'default'})).rejects.toMatchObject({code:'subscription_identity_conflict'});expect(f.calls().length).toBe(before);
    });
  });
  test('expired completed grants export the same evidence-backed report without inference',async()=>{
    await f.run(async id=>{const report=await run(),before=f.calls().length;
      await f.engine().executeRaw("UPDATE codex_subscription_runs SET deadline=now()-interval '1 second' WHERE run_id=$1",[id]);
      expect(await run()).toEqual(report);expect(f.calls().length).toBe(before);
    });
  });
  test('evidence revision changes cannot pass through cached evaluation summaries',async()=>{
    await f.run(async()=>{await run();const before=f.calls().length;
      await f.engine().putPage('notes/launch',{type:'note',title:'Changed',compiled_truth:'Changed evidence.'},{sourceId:source});
      expect(await run()).toMatchObject({verdict:'inconclusive',failure_code:'revision_conflict',completed_fixtures:0});expect(f.calls().length).toBe(before);
    });
  });
  test('a live second owner cannot take over the batch',async()=>{
    await f.run(async id=>{
      await run();const [row]=await f.engine().executeRaw<{binding_hash:string}>('SELECT binding_hash FROM codex_eval_runs WHERE run_id=$1',[id]);
      const host={engine:f.engine(),runId:id},claim=await claimEvalRun(host,row!.binding_hash,2,'answer');
      try{await expect(run()).rejects.toMatchObject({code:'subscription_owner_lost'});}finally{await releaseEvalRun(host,claim,false);}
    });
  });
  test('malformed rows and invalid bounds fail before the allowance is persisted',async()=>{
    const id=randomUUID(),flags=['--codex-request-id',id,'--codex-max-attempts','4','--codex-max-turns','4','--codex-deadline',new Date(Date.now()+600000).toISOString()];
    const before=f.calls().length;writeFileSync(path,'{"question":"valid"}\nmalformed');
    await expect(withBrainstormAllowance(f.engine(),flags,()=>run())).rejects.toMatchObject({reason:'invalid_input'});
    expect(await f.engine().executeRaw('SELECT run_id FROM codex_subscription_runs WHERE run_id=$1',[`codex-brainstorm:${id}`])).toHaveLength(0);
    expect(f.calls().length).toBe(before);
  });
  test('evaluation and single brainstorm cannot silently share the same durable request identity',async()=>{
    await f.run(async()=>{await run();const before=f.calls().length;
      await expect(runBrainstorm(f.engine(),{}, {question:'Orbital launch',sourceId:source,profile:{...BRAINSTORM_PROFILE,k_close:1,m_far:1}})).rejects.toMatchObject({code:'subscription_identity_conflict'});
      expect(f.calls().length).toBe(before);
    });
  });
  test('a lost fixture acknowledgment reuses its accepted result instead of consuming another allowance',async()=>{
    const engine=f.engine(),transaction=engine.transaction,before=f.calls().length;
    try{await f.run(async id=>{
      let fired=false;
      engine.transaction=(async function(this:BrainEngine,fn:Parameters<BrainEngine['transaction']>[0]){
        const value=await transaction.call(this,fn);if(this!==engine)return value;
        if(!fired&&(await engine.executeRaw('SELECT question_key FROM codex_eval_results WHERE run_id=$1',[id])).length){fired=true;throw new Error('fixture_ack_lost');}return value;
      }) as BrainEngine['transaction'];
      expect(await run()).toMatchObject({verdict:'inconclusive',failure_code:'evaluation_failed'});engine.transaction=transaction;
      expect(fired).toBe(true);expect(await run()).toMatchObject({verdict:'pass',completed_fixtures:2});expect(f.calls().length-before).toBe(4);
    });}finally{engine.transaction=transaction;}
  });
  test('corrupted durable summaries cannot be exported as valid grades',async()=>{
    await f.run(async id=>{await run();const before=f.calls().length;
      await f.engine().executeRaw("UPDATE codex_eval_results SET payload_hash=$2 WHERE run_id=$1",[id,'0'.repeat(64)]);
      expect(await run()).toMatchObject({verdict:'inconclusive',failure_code:'subscription_identity_conflict',completed_fixtures:0});expect(f.calls().length).toBe(before);
    });
  });
  test('duplicate question rows remain distinct fixtures without minting child grants',async()=>{
    writeFileSync(path,'{"question":"Orbital launch"}\n{"question":"Orbital launch"}\n');const before=f.calls().length;
    await f.run(async id=>{expect(await run()).toMatchObject({verdict:'pass',completed_fixtures:2});
      expect(f.calls().length-before).toBe(4);
      expect(await f.engine().executeRaw('SELECT DISTINCT run_id FROM codex_subscription_attempts WHERE run_id=$1',[id])).toEqual([{run_id:id}]);
    });
  });
  test('an unsettled native attempt keeps the account lane and blocks batch replay',async()=>{
    f.reply({missingCompletion:true});const before=f.calls().length;
    await f.run(async id=>{expect(await run()).toMatchObject({verdict:'inconclusive',failure_code:'missing_completion',completed_fixtures:0});
      expect(await f.engine().executeRaw('SELECT state FROM codex_eval_runs WHERE run_id=$1',[id])).toEqual([{state:'needs_reconciliation'}]);
      await expect(run()).rejects.toMatchObject({code:'subscription_lane_busy'});expect(f.calls().length-before).toBe(1);
    });
  });
  test('material retrieval settings changed during inference cannot accept a fixture',async()=>{
    const engine=f.engine(),execute=engine.executeRaw;let changed=false;
    await f.run(async id=>{
      engine.executeRaw=(async function(this:BrainEngine,sql:string,params?:unknown[]){
        const rows=await execute.call(this,sql,params);
        if(this===engine&&!changed&&sql.includes('UPDATE codex_subscription_attempts SET state=')){
          changed=true;await engine.setConfig('search.brainstorm_fixture','changed');
        }
        return rows;
      }) as BrainEngine['executeRaw'];
      try{expect(await run()).toMatchObject({verdict:'inconclusive',failure_code:'subscription_identity_conflict',completed_fixtures:0});expect(changed).toBe(true);}
      finally{engine.executeRaw=execute;await engine.executeRaw("DELETE FROM config WHERE key='search.brainstorm_fixture'");}
      expect(await engine.executeRaw('SELECT question_key FROM codex_eval_results WHERE run_id=$1',[id])).toHaveLength(0);
    });
  });
  test('actual evaluation CLI creates one bounded allowance and repeats retained fixtures',async()=>{
    const id=randomUUID(),args=[path,'--source',source,'--json','--codex-request-id',id,'--codex-max-attempts','4','--codex-max-turns','4','--codex-deadline',new Date(Date.now()+600000).toISOString()],before=f.calls().length;
    expect(await runEvalBrainstorm(f.engine(),args)).toBe(0);expect(await runEvalBrainstorm(f.engine(),args)).toBe(0);expect(f.calls().length-before).toBe(4);
    expect(await f.engine().executeRaw('SELECT account_lane,attempts FROM codex_subscription_runs WHERE run_id=$1',[`codex-brainstorm:${id}`])).toEqual([{account_lane:'codex-subscription',attempts:4}]);
  });
});}
