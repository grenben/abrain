import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSubscriptionRun, reserveSubscriptionAttempt, settleSubscriptionAttempt, acceptSubscriptionTurn, type SubscriptionEnvelope } from '../../src/core/ai/subscription-admission.ts';
import { codexSubscriptionContext, withCodexSubscription, type CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { runReflect } from '../../src/core/skillopt/reflect.ts';
interface Fixture {engine():BrainEngine;reply(value:unknown):void;calls():Array<any>;
  run<T>(fn:(id:string)=>Promise<T>,hooks?:Partial<CodexSubscriptionContext>,maxAttempts?:number):Promise<T>}
export function codexSubscriptionGroupContract(f:Fixture){describe('aggregate Codex subscription admission',()=>{
  async function envelope(parentRunId:string,extra:Partial<SubscriptionEnvelope>={}):Promise<SubscriptionEnvelope>{
    const [row]=await f.engine().executeRaw<{account_lane:string;max_attempts:number;max_turns:number;deadline:string|Date}>('SELECT * FROM codex_subscription_runs WHERE run_id=$1',[parentRunId]);
    return {runId:randomUUID(),parentRunId,accountLane:row!.account_lane,maxAttempts:row!.max_attempts,maxTurns:row!.max_turns,deadline:new Date(row!.deadline),...extra};
  }
  const reserve=(runId:string,repair=false)=>reserveSubscriptionAttempt(f.engine(),{runId,attemptId:randomUUID(),requestHash:'a'.repeat(64),timeoutMs:1000,repair});
  const counts=(id:string)=>f.engine().executeRaw('SELECT attempts,accepted_turns,repairs FROM codex_subscription_runs WHERE run_id=$1',[id]);
  const propose=()=>runReflect({skillBodyText:'## Method\nUse evidence.',optimizerModel:'codex-cli:gpt-test',successes:[],failures:[{score:0.2,trajectory:{task_id:'aggregate-fixture',task:'Use evidence.',final_text:'Evidence.',tool_calls:[],usage:{input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_creation_tokens:0},turns:1,stop_reason:'end',duration_ms:1}}],rejected:[]});
  test('real native calls across root and child identities consume one aggregate allowance',async()=>{
    f.reply({edits:[]});const before=f.calls().length;
    await f.run(async root=>{const host=codexSubscriptionContext()!,first=await envelope(root),second=await envelope(root);
      await createSubscriptionRun(f.engine(),first);await createSubscriptionRun(f.engine(),second);
      expect((await propose()).billing).toMatchObject({costUsd:null,remainingQuota:null});
      await withCodexSubscription({...host,runId:first.runId},propose);
      await withCodexSubscription({...host,runId:second.runId},propose);
      expect(await counts(root)).toEqual([{attempts:3,accepted_turns:3,repairs:0}]);expect(await counts(first.runId)).toEqual([{attempts:1,accepted_turns:1,repairs:0}]);
      const third=await envelope(root);await createSubscriptionRun(f.engine(),third);
      await expect(withCodexSubscription({...host,runId:third.runId},propose)).rejects.toMatchObject({code:'subscription_exhausted'});
      expect(await f.engine().executeRaw('SELECT count(*)::int AS n,sum(input_tokens)::int AS tokens FROM codex_subscription_attempts WHERE account_lane=$1',[root])).toEqual([{n:3,tokens:63}]);
    },{},3);expect(f.calls().length-before).toBe(3);
  });
  test('failed attempts remain charged and semantic acceptance updates both levels exactly once',async()=>{
    await f.run(async root=>{const child=await envelope(root);await createSubscriptionRun(f.engine(),child);
      const failed=await reserve(child.runId);await settleSubscriptionAttempt(f.engine(),failed,{state:'failed',failureCode:'invalid_output'});
      const good=await reserve(child.runId);await settleSubscriptionAttempt(f.engine(),good,{state:'succeeded',usage:{inputTokens:7,cachedInputTokens:1,outputTokens:3}});
      await acceptSubscriptionTurn(f.engine(),good);await acceptSubscriptionTurn(f.engine(),good);
      for(const id of [root,child.runId])expect(await counts(id)).toEqual([{attempts:2,accepted_turns:1,repairs:0}]);
      await expect(reserve(root)).rejects.toMatchObject({code:'subscription_exhausted'});
    },{},2);
  });
  test('children cannot multiply the single allowed content repair',async()=>{
    await f.run(async root=>{const one=await envelope(root),two=await envelope(root);await createSubscriptionRun(f.engine(),one);await createSubscriptionRun(f.engine(),two);
      const attempt=await reserve(one.runId,true);await settleSubscriptionAttempt(f.engine(),attempt,{state:'failed',failureCode:'invalid_output'});
      await expect(reserve(two.runId,true)).rejects.toMatchObject({code:'subscription_exhausted'});await expect(reserve(root,true)).rejects.toMatchObject({code:'subscription_exhausted'});
      expect(await counts(root)).toEqual([{attempts:1,accepted_turns:0,repairs:1}]);expect(await counts(two.runId)).toEqual([{attempts:0,accepted_turns:0,repairs:0}]);
    });
  });
  test('concurrent children serialize on the parent and an unresolved attempt blocks siblings and root',async()=>{
    await f.run(async root=>{const one=await envelope(root),two=await envelope(root);await createSubscriptionRun(f.engine(),one);await createSubscriptionRun(f.engine(),two);
      const results=await Promise.allSettled([reserve(one.runId),reserve(two.runId)]),good=results.filter(r=>r.status==='fulfilled'),bad=results.filter(r=>r.status==='rejected');
      expect(good).toHaveLength(1);expect(bad).toHaveLength(1);expect(bad[0]!.reason).toMatchObject({code:'subscription_lane_busy'});
      const attempt=good[0]!.value;await settleSubscriptionAttempt(f.engine(),attempt,{state:'unresolved',failureCode:'timeout'});
      await expect(reserve(root)).rejects.toMatchObject({code:'subscription_lane_busy'});await expect(reserve(attempt.runId===one.runId?two.runId:one.runId)).rejects.toMatchObject({code:'subscription_lane_busy'});
      expect(await counts(root)).toEqual([{attempts:1,accepted_turns:0,repairs:0}]);
    });
  });
  test('child attempts respect their own smaller envelope as well as the aggregate envelope',async()=>{
    await f.run(async root=>{const child=await envelope(root,{maxAttempts:1,maxTurns:1});await createSubscriptionRun(f.engine(),child);
      const attempt=await reserve(child.runId);await settleSubscriptionAttempt(f.engine(),attempt,{state:'failed',failureCode:'invalid_output'});
      await expect(reserve(child.runId)).rejects.toMatchObject({code:'subscription_exhausted'});
      const rootAttempt=await reserve(root);await settleSubscriptionAttempt(f.engine(),rootAttempt,{state:'failed',failureCode:'invalid_output'});
      expect(await counts(root)).toEqual([{attempts:2,accepted_turns:0,repairs:0}]);
    });
  });
  test('the aggregate accepted-turn limit can stop siblings before attempts are exhausted',async()=>{
    await f.run(async root=>{
      await f.engine().executeRaw('UPDATE codex_subscription_runs SET max_turns=1 WHERE run_id=$1',[root]);
      const one=await envelope(root),two=await envelope(root);await createSubscriptionRun(f.engine(),one);await createSubscriptionRun(f.engine(),two);
      const attempt=await reserve(one.runId);await settleSubscriptionAttempt(f.engine(),attempt,{state:'succeeded',usage:null});await acceptSubscriptionTurn(f.engine(),attempt);
      await expect(f.engine().executeRaw('UPDATE codex_subscription_runs SET attempts=attempts+1 WHERE run_id=$1',[two.runId])).rejects.toThrow('subscription_exhausted');
      await expect(reserve(two.runId)).rejects.toMatchObject({code:'subscription_exhausted'});expect(await counts(root)).toEqual([{attempts:1,accepted_turns:1,repairs:0}]);
    });
  });
  test('envelope identity, lane, deadline and one-level ownership are immutable',async()=>{
    await f.run(async root=>{
      const child=await envelope(root);await createSubscriptionRun(f.engine(),child);await createSubscriptionRun(f.engine(),child);
      for(const change of [{accountLane:'other-lane'},{maxAttempts:child.maxAttempts+1},{deadline:new Date(child.deadline.getTime()+1)},{parentRunId:undefined}])
        await expect(createSubscriptionRun(f.engine(),{...child,...change})).rejects.toMatchObject({code:'subscription_identity_conflict'});
      await expect(createSubscriptionRun(f.engine(),await envelope(child.runId))).rejects.toMatchObject({code:'subscription_identity_conflict'});
      await expect(createSubscriptionRun(f.engine(),{...child,runId:root})).rejects.toMatchObject({code:'subscription_invalid'});
      await expect(createSubscriptionRun(f.engine(),{...child,runId:randomUUID(),parentRunId:'missing-root'})).rejects.toMatchObject({code:'subscription_identity_conflict'});
      await expect(f.engine().executeRaw('UPDATE codex_subscription_runs SET parent_run_id=$2 WHERE run_id=$1',[child.runId,'missing-root'])).rejects.toThrow('subscription_identity_conflict');
      await expect(f.engine().executeRaw('UPDATE codex_subscription_runs SET max_attempts=max_attempts+1 WHERE run_id=$1',[root])).rejects.toThrow('subscription_identity_conflict');
    });
  });
  test('database guard charges older counter writers too and refuses refunds or budget overruns atomically',async()=>{
    await f.run(async root=>{const one=await envelope(root),two=await envelope(root);await createSubscriptionRun(f.engine(),one);await createSubscriptionRun(f.engine(),two);
      await f.engine().executeRaw('UPDATE codex_subscription_runs SET attempts=attempts+1,accepted_turns=accepted_turns+1 WHERE run_id=$1',[one.runId]);
      expect(await counts(root)).toEqual([{attempts:1,accepted_turns:1,repairs:0}]);
      await expect(f.engine().executeRaw('UPDATE codex_subscription_runs SET attempts=0 WHERE run_id=$1',[one.runId])).rejects.toThrow('subscription_invalid');
      await expect(f.engine().executeRaw('UPDATE codex_subscription_runs SET attempts=attempts+1 WHERE run_id=$1',[two.runId])).rejects.toThrow('subscription_exhausted');
      expect(await counts(two.runId)).toEqual([{attempts:0,accepted_turns:0,repairs:0}]);
    },{},1);
  });
});}
