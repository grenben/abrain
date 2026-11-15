import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import type { Trajectory, BenchmarkTask } from '../../src/core/skillopt/types.ts';
import { scoreTrajectory } from '../../src/core/skillopt/score.ts';
import { getPrivateGateFailureDiagnostic, runValidationGate } from '../../src/core/skillopt/validate-gate.ts';
import { isSkilloptMustAbort } from '../../src/core/skillopt/must-abort.ts';
interface Fixture {engine():BrainEngine;reply(value:unknown):void;calls():Array<any>;
  run<T>(fn:(id:string)=>Promise<T>,hooks?:Partial<CodexSubscriptionContext>,maxAttempts?:number):Promise<T>}
const trajectory=(extra:Partial<Trajectory>={}):Trajectory=>({task_id:'synthetic-task',task:'Explain a grounded constraint.',final_text:'Grounded constraints improve the proposed test.',
  tool_calls:[],usage:{input_tokens:12,output_tokens:9,cache_read_tokens:0,cache_creation_tokens:0},turns:1,stop_reason:'end',duration_ms:1,...extra});
const judge={kind:'llm' as const,rubric:'Score whether the answer describes a grounded constraint.'};
const valid={score:0.8,rationale:'The answer describes a grounded constraint.',evidence_quote:'Grounded constraints'};
export function codexSkilloptScoreContract(f:Fixture){describe('native skillopt judging',()=>{
  const score=(value=trajectory(),options:Parameters<typeof scoreTrajectory>[2]={})=>scoreTrajectory(value,judge,options);
  test('actual scorer transports native schema, grounded evidence and measured judge usage',async()=>{
    f.reply(valid);const before=f.calls().length;await f.run(async id=>{
      const result=await score();expect(result).toMatchObject({score:0.8,judge_evidence_quote:valid.evidence_quote,judge_billing:{kind:'subscription',costUsd:null,remainingQuota:null},judge_cache_hit:false,judge_usage:{input_tokens:21,output_tokens:9}});
      expect(result.judge_error).toBeUndefined();expect((await score()).judge_cache_hit).toBe(true);expect((await score()).judge_usage).toBeUndefined();
      expect(await f.engine().executeRaw('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[id])).toEqual([{attempts:1,accepted_turns:1}]);
    });expect(f.calls().length-before).toBe(1);const wire=f.calls().at(-1)!;
    expect(wire.args).toContain('--output-schema');expect(wire.mode).toBe(0o600);expect(wire.schema.required).toEqual(['evidence_hash','score','rationale','evidence_quote']);
    expect(wire.prompt).toContain(trajectory().final_text);
  });
  test.each([{raw:'bad'},{...valid,score:'0.8'},{...valid,score:-0.1},{...valid,score:1.1},{...valid,rationale:' '},
    {...valid,evidence_quote:'invented evidence'},{...valid,evidence_hash:'forged'},{...valid,approved:true},
    {...valid,rationale:'bad\u0000note'},{...valid,evidence_quote:null}])('invalid judgments never become numeric grades or cached results',async value=>{
    f.reply(value);await f.run(async id=>{await expect(score()).rejects.toMatchObject({reason:'invalid_output'});
      expect(await f.engine().executeRaw('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[id])).toEqual([{accepted_turns:0}]);
    });
  });
  test('a valid zero is a grade; empty completed output is supported without fabricated evidence',async()=>{
    await f.run(async()=>{f.reply({...valid,score:0});expect((await score()).score).toBe(0);
      f.reply({...valid,score:0,evidence_quote:null});expect(await score(trajectory({final_text:''}))).toMatchObject({score:0,judge_evidence_quote:null});
    });
  });
  test.each([{refusal:true},{missingCompletion:true}])('refusal and absent completion remain unresolved failures',async value=>{
    f.reply(value);await f.run(async id=>{await expect(score()).rejects.toMatchObject({reason:value.refusal?'refusal':'missing_completion'});
      expect(await f.engine().executeRaw('SELECT state FROM codex_subscription_attempts WHERE run_id=$1',[id])).toEqual([{state:'unresolved'}]);
      await expect(score()).rejects.toMatchObject({code:'subscription_lane_busy'});
    });
  });
  test('explicit task pins cannot hide conflicting command pins, and DB reasoning pins apply',async()=>{
    const before=f.calls().length;await f.run(async()=>{
      await expect(scoreTrajectory(trajectory(),{...judge,model:'codex-cli:gpt-test'},{judgeModel:'anthropic:fixture'})).rejects.toMatchObject({code:'private_route_conflict'});
      await expect(scoreTrajectory(trajectory(),{...judge,model:'openai:fixture'})).rejects.toMatchObject({code:'private_route_conflict'});
      await f.engine().setConfig('models.tier.reasoning','anthropic:fixture');
      try{await expect(score()).rejects.toMatchObject({code:'private_route_conflict'});}finally{await f.engine().setConfig('models.tier.reasoning','');}
    });expect(f.calls().length).toBe(before);
  });
  test('incomplete trajectories, injected transport and oversized input fail before native dispatch',async()=>{
    const before=f.calls().length;await f.run(async()=>{
      for(const stop_reason of ['length','max_turns','refusal','content_filter','aborted','unrecoverable'] as const)await expect(score(trajectory({stop_reason}))).rejects.toMatchObject({reason:'invalid_input'});
      await expect(score(trajectory({final_text:'x'.repeat(64001)}))).rejects.toMatchObject({reason:'invalid_input'});
      await expect(score(trajectory(),{chatFn:async()=>{throw new Error('forbidden injected chat');}})).rejects.toMatchObject({reason:'invalid_input'});
    });expect(f.calls().length).toBe(before);
  });
  test('rule and qrels scoring stay deterministic without a grant or provider',async()=>{
    const before=f.calls().length;
    expect((await scoreTrajectory(trajectory(),{kind:'rule',checks:[{op:'contains',arg:'Grounded'}]})).score).toBe(1);
    expect((await scoreTrajectory(trajectory(),{kind:'qrels',expected_slugs:[],k:5})).score).toBe(0);
    expect(f.calls().length).toBe(before);
  });
  test('missing grants, exhausted turns and cancellation never produce fallback grades',async()=>{
    await expect(score()).rejects.toMatchObject({code:'subscription_required'});f.reply(valid);
    await f.run(async()=>{await score();await expect(score(trajectory({task_id:'different'}))).rejects.toMatchObject({code:'subscription_exhausted'});},{},1);
    const abort=new AbortController();abort.abort();const before=f.calls().length;
    await f.run(async()=>{await expect(score(trajectory(),{abortSignal:abort.signal})).rejects.toMatchObject({reason:'aborted'});});expect(f.calls().length).toBe(before);
  });
  test('input is captured before caller mutation and changed trajectories use different cache identities',async()=>{
    f.reply(valid);await f.run(async()=>{const input=trajectory(),pending=score(input);input.final_text='MUTATED';
      expect((await pending).trajectory.final_text).toBe(trajectory().final_text);
      const before=f.calls().length;await score(trajectory({task_id:'different'}));expect(f.calls().length).toBe(before+1);
    });
  });
  const tasks:BenchmarkTask[]=[1,2,3].map(n=>({task_id:`task-${n}`,task:`Synthetic task ${n}`,judge}));
  test('real validation gate stops after the first failed judge and returns no acceptance decision',async()=>{
    const before=f.calls().length;let rollouts=0;f.reply({raw:'bad'});
    await f.run(async()=>{await expect(runValidationGate({engine:f.engine(),candidateSkillText:'Synthetic skill',selSet:tasks,bestScore:0.2,targetModel:'codex-cli:gpt-test',
      runsPerTask:1,concurrency:4,rolloutFn:async opts=>{rollouts++;return trajectory({task_id:opts.task.task_id,task:opts.task.task});}})).rejects.toMatchObject({reason:'invalid_output'});});
    expect(rollouts).toBe(1);expect(f.calls().length-before).toBe(1);
  });
  test('private settled failures retain safe stage and executor diagnostics without preserving provider text',async()=>{
    let failure:unknown;
    await f.run(async()=>{
      try {
        await runValidationGate({engine:f.engine(),candidateSkillText:'Synthetic skill',selSet:tasks,bestScore:0.2,targetModel:'codex-cli:gpt-test',
          runsPerTask:1,phase:'train_forward',rolloutFn:async()=>{throw new Error('SYNTHETIC_PRIVATE_PROMPT_SECRET');}});
      } catch(error) { failure=error; }
    });
    expect(failure).toMatchObject({reason:'invalid_output',message:'codex-cli proposal failed: invalid_output'});
    expect(getPrivateGateFailureDiagnostic(failure)).toEqual({
      stage:'train_forward',executor:'direct_rollout',cause:{kind:'runtime_error',type:'Error'},failedTasks:3,totalTasks:3,
    });
    expect(JSON.stringify(failure)).not.toContain('SYNTHETIC_PRIVATE_PROMPT_SECRET');
  });
  test('successful native judgments feed actual host medians and the epsilon gate',async()=>{
    f.reply(valid);await f.run(async()=>{const result=await runValidationGate({engine:f.engine(),candidateSkillText:'Synthetic skill',selSet:tasks,bestScore:0.7,targetModel:'codex-cli:gpt-test',
      runsPerTask:1,rolloutFn:async opts=>trajectory({task_id:opts.task.task_id,task:opts.task.task})});
      expect(result.accepted).toBe(true);expect(result.selScore).toBeCloseTo(0.8);expect(result.scoredRollouts).toHaveLength(3);
    });
  });
  test('gate preflights every task pin before any rollout and rejects partial rollout failure',async()=>{
    let rollouts=0;await f.run(async()=>{
      const options={engine:f.engine(),candidateSkillText:'Synthetic skill',selSet:[tasks[0]!,{...tasks[1]!,judge:{...judge,model:'anthropic:forbidden'}}],bestScore:0,targetModel:'codex-cli:gpt-test',runsPerTask:1,
        rolloutFn:async()=>{rollouts++;throw new Error('private provider detail');}};
      await expect(runValidationGate(options)).rejects.toMatchObject({code:'private_route_conflict'});expect(rollouts).toBe(0);
      await f.engine().setConfig('models.tier.reasoning','anthropic:forbidden');
      try{await expect(runValidationGate({...options,selSet:tasks})).rejects.toMatchObject({code:'private_route_conflict'});expect(rollouts).toBe(0);}
      finally{await f.engine().setConfig('models.tier.reasoning','');}
      await expect(runValidationGate({...options,selSet:tasks})).rejects.toMatchObject({reason:'invalid_output'});expect(rollouts).toBe(1);
    });
  });
  test('incomplete rollouts cannot pass a deterministic rule judge inside the private gate',async()=>{
    await f.run(async()=>{await expect(runValidationGate({engine:f.engine(),candidateSkillText:'Synthetic skill',selSet:[{...tasks[0]!,judge:{kind:'rule',checks:[{op:'contains',arg:'Grounded'}]}}],
      bestScore:0,targetModel:'codex-cli:gpt-test',runsPerTask:1,rolloutFn:async()=>trajectory({stop_reason:'length'})})).rejects.toMatchObject({reason:'invalid_output'});});
  });
  test('cancelling the real gate stops its active native judge and prevents later rollouts',async()=>{
    f.reply({wait:true});const abort=new AbortController(),before=f.calls().length;let rollouts=0;
    await f.run(async id=>{
      const pending=runValidationGate({engine:f.engine(),candidateSkillText:'Synthetic skill',selSet:tasks,bestScore:0,targetModel:'codex-cli:gpt-test',runsPerTask:1,abortSignal:abort.signal,
        rolloutFn:async opts=>{rollouts++;return trajectory({task_id:opts.task.task_id});}}).then(()=>null,error=>error);
      try{for(let i=0;i<200&&f.calls().length===before;i++)await Bun.sleep(10);expect(f.calls().length).toBe(before+1);}finally{abort.abort();}
      expect(await pending).toMatchObject({reason:'aborted'});expect(rollouts).toBe(1);
      expect(await f.engine().executeRaw("SELECT attempt_id FROM codex_subscription_attempts WHERE run_id=$1 AND state='active'",[id])).toHaveLength(0);
    });
  });
  test('native errors are must-abort across optimizer, held-out and bootstrap catch boundaries',async()=>{
    f.reply({raw:'bad'});await f.run(async()=>{try{await score();throw new Error('expected failure');}catch(error){expect(isSkilloptMustAbort(error)).toBe(true);}});
  });
});}
