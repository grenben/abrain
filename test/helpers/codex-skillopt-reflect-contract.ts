import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { runReflect, runOneShotRewrite, type ReflectOpts } from '../../src/core/skillopt/reflect.ts';
interface Fixture {engine():BrainEngine;reply(value:unknown):void;calls():Array<any>;
  run<T>(fn:(id:string)=>Promise<T>,hooks?:Partial<CodexSubscriptionContext>,maxAttempts?:number):Promise<T>}
const body='## Method\nUse grounded evidence.\n';
const replacement={op:'replace' as const,target:'Use grounded evidence.',replacement:'Check grounded evidence.',reason:'Require explicit checking.'};
function options(extra:Partial<ReflectOpts>={}):ReflectOpts{return {skillBodyText:body,optimizerModel:'codex-cli:gpt-test',successes:[],failures:[{
  trajectory:{task_id:'synthetic-reflect',task:'Explain evidence.',final_text:'Grounded evidence.',tool_calls:[],usage:{input_tokens:1,output_tokens:1,cache_read_tokens:0,cache_creation_tokens:0},turns:1,stop_reason:'end',duration_ms:1},score:0.2,
}],rejected:[],criteria:'Use grounded evidence.',...extra};}
export function codexSkilloptReflectContract(f:Fixture){describe('native skill optimization proposals',()=>{
  test('real reflection transports operation-specific schemas and retains proposals without double accounting',async()=>{
    f.reply({edits:[replacement]});const before=f.calls().length;
    await f.run(async id=>{const result=await runReflect(options());expect(result).toMatchObject({failureEdits:[replacement],successEdits:[],calls:1,usableReplies:1,invalidEditsDropped:0,cacheHits:0,
      billing:{kind:'subscription',costUsd:null,remainingQuota:null},usage:{input_tokens:21,output_tokens:9}});
      expect(await runReflect(options())).toMatchObject({failureEdits:[replacement],cacheHits:1,usage:{input_tokens:0,output_tokens:0}});
      expect(await f.engine().executeRaw('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[id])).toEqual([{attempts:1,accepted_turns:1}]);
    });expect(f.calls().length-before).toBe(1);const call=f.calls().at(-1)!;
    expect(call.args).toContain('--output-schema');expect(call.mode).toBe(0o600);expect(call.schema.properties.edits.items.anyOf).toHaveLength(3);
    expect(JSON.parse(JSON.parse(call.prompt).messages[0].content).skillBodyText).toBe(body);
  });
  test('two calls validate the complete sequential edit batch and retain both replies',async()=>{
    const second={op:'replace',target:'Check grounded evidence.',replacement:'Verify grounded evidence.',reason:'Clarify verification.'};
    f.reply({autoReflect:true,failure:{edits:[replacement]},success:{edits:[second]}});
    await f.run(async()=>{const opts=options({successes:options().failures.map(r=>({...r,score:0.9}))});
      expect(await runReflect(opts)).toMatchObject({failureEdits:[replacement],successEdits:[second],calls:2,usage:{input_tokens:42,output_tokens:18}});
      expect(await runReflect(opts)).toMatchObject({cacheHits:2,usage:{input_tokens:0,output_tokens:0}});
    });
  });
  test('failed success proposal returns no partial candidate; retry reuses accepted failure proposal',async()=>{
    const opts=options({successes:options().failures.map(r=>({...r,score:0.9}))});
    await f.run(async()=>{f.reply({autoReflect:true,failure:{edits:[replacement]},success:{edits:[replacement]}});
      await expect(runReflect(opts)).rejects.toMatchObject({reason:'invalid_output'});
      const before=f.calls().length;f.reply({autoReflect:true,failure:{raw:'must not regenerate'},success:{edits:[]}});
      expect(await runReflect(opts)).toMatchObject({failureEdits:[replacement],successEdits:[],cacheHits:1});expect(f.calls().length-before).toBe(1);
    });
  });
  test('deliberate empty proposals and empty evidence batches are distinct from failure',async()=>{
    f.reply({edits:[]});await f.run(async()=>{expect(await runReflect(options())).toMatchObject({failureEdits:[],errors:[],usableReplies:1});
      const before=f.calls().length;expect(await runReflect(options({failures:[]}))).toMatchObject({calls:0,usableReplies:0});expect(f.calls().length).toBe(before);
    });
  });
  test.each([{raw:'bad'}, {edits:[replacement,{op:'shell',command:'forbidden'}]}, {edits:[{...replacement,target:'missing'}]},
    {edits:[{...replacement,replacement:'Use grounded evidence.'}]}, {edits:[{...replacement,reason:' '}]},
    {edits:[{...replacement,replacement:'bad\u0000text'}]}, {edits:[],operation_id:'forged'}, {edits:[],evidence_hash:'forged'},
    {edits:Array.from({length:21},()=>replacement)}])('whole malformed or unsafe proposal fails without dropping edits or caching it',async value=>{
    f.reply(value);await f.run(async id=>{await expect(runReflect(options())).rejects.toMatchObject({reason:'invalid_output'});
      expect(await f.engine().executeRaw('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[id])).toEqual([{accepted_turns:0}]);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_proposal_cache WHERE run_id=$1',[id])).toHaveLength(0);
    });
  });
  test('ambiguous anchors, code-fence edits and frontmatter creation are refused',async()=>{
    await f.run(async()=>{for(const [skillBodyText,edit] of [
      ['## Method\nSame\nSame\n',{...replacement,target:'Same'}],
      ['## Method\n```\nUse grounded evidence.\n```\n',replacement],
      [body,{...replacement,target:body,replacement:'---\nname: forged\n---\nBody'}],
    ] as const){f.reply({edits:[edit]});await expect(runReflect(options({skillBodyText}))).rejects.toMatchObject({reason:'invalid_output'});}});
  });
  test('body rewrites transport complete native proposals and retain measured usage',async()=>{
    f.reply({newBody:'## Method\nVerify grounded evidence.\n'});await f.run(async()=>{
      expect(await runOneShotRewrite(options())).toMatchObject({newBody:'## Method\nVerify grounded evidence.\n',cacheHit:false,billing:{costUsd:null}});
      expect(await runOneShotRewrite(options())).toMatchObject({cacheHit:true,usage:{input_tokens:0,output_tokens:0}});
    });expect(f.calls().at(-1)!.schema.required).toEqual(['evidence_hash','newBody']);
  });
  test.each([{newBody:''},{newBody:' '},{newBody:'---\nname: forged\n---\nBody'},{newBody:'---\r\nname: forged\r\n---\r\nBody'},
    {newBody:'x'.repeat(64001)},{newBody:'bad\u0000body'},{raw:'## Unstructured body'}])('invalid rewrites never become no-change results',async value=>{
    f.reply(value);await f.run(async()=>{await expect(runOneShotRewrite(options())).rejects.toMatchObject({reason:'invalid_output'});});
  });
  test.each([{refusal:true},{missingCompletion:true}])('refused/incomplete reflection stays unresolved and blocks duplicate admission',async value=>{
    f.reply(value);await f.run(async id=>{await expect(runReflect(options())).rejects.toMatchObject({reason:value.refusal?'refusal':'missing_completion'});
      expect(await f.engine().executeRaw('SELECT state FROM codex_subscription_attempts WHERE run_id=$1',[id])).toEqual([{state:'unresolved'}]);
      await expect(runReflect(options())).rejects.toMatchObject({code:'subscription_lane_busy'});
    });
  });
  test('strict explicit and deep-tier pins fail before any dispatch',async()=>{
    const before=f.calls().length;await f.run(async()=>{
      await expect(runReflect(options({optimizerModel:'anthropic:forbidden'}))).rejects.toMatchObject({code:'private_route_conflict'});
      await f.engine().setConfig('models.tier.deep','openai:forbidden');
      try{await expect(runOneShotRewrite(options())).rejects.toMatchObject({code:'private_route_conflict'});}finally{await f.engine().setConfig('models.tier.deep','');}
    });expect(f.calls().length).toBe(before);
  });
  test('invalid inputs, failed judgments and injected transports cannot reach inference',async()=>{
    const before=f.calls().length;await f.run(async()=>{
      for(const opts of [options({skillBodyText:'x'.repeat(64001)}),options({maxTokens:8193}),options({skillBodyText:'---\nname: fixture\n---\nBody'}),
        options({chatFn:async()=>{throw new Error('forbidden transport');}}),options({failures:options().failures.map(r=>({...r,judge_error:'failed'}))}),
        options({failures:options().failures.map(r=>({...r,trajectory:{...r.trajectory,stop_reason:'length'}}))})])await expect(runReflect(opts)).rejects.toMatchObject({reason:'invalid_input'});
      await expect(runOneShotRewrite(options({skillBodyText:'x'.repeat(30000)}))).rejects.toMatchObject({reason:'invalid_input'});
    });expect(f.calls().length).toBe(before);
  });
  test('snapshot and versioned cache bind the original full inputs before asynchronous caller mutation',async()=>{
    f.reply({edits:[replacement]});await f.run(async()=>{const input=options(),pending=runReflect(input);input.skillBodyText='MUTATED';input.failures[0]!.score=0.3;
      expect((await pending).failureEdits).toEqual([replacement]);expect(JSON.parse(JSON.parse(f.calls().at(-1)!.prompt).messages[0].content).failures[0].score).toBe(0.2);
      const before=f.calls().length;await runReflect(options({criteria:'Different grounded criteria.'}));expect(f.calls().length-before).toBe(1);
    });
  });
  test('missing allowance, exhausted attempts and cancellation never produce empty success',async()=>{
    await expect(runReflect(options())).rejects.toMatchObject({code:'subscription_required'});f.reply({edits:[]});
    await f.run(async()=>{await runReflect(options());await expect(runReflect(options({criteria:'Changed'}))).rejects.toMatchObject({code:'subscription_exhausted'});},{},1);
    const abort=new AbortController();abort.abort();const before=f.calls().length;
    await f.run(async()=>{await expect(runReflect(options({abortSignal:abort.signal}))).rejects.toMatchObject({reason:'aborted'});});expect(f.calls().length).toBe(before);
  });
  test('cancellation settles the active process and prevents success reflection',async()=>{
    f.reply({wait:true});const abort=new AbortController(),before=f.calls().length;
    await f.run(async id=>{const pending=runReflect(options({successes:options().failures,abortSignal:abort.signal})).then(()=>null,error=>error);
      try{for(let i=0;i<200&&f.calls().length===before;i++)await Bun.sleep(10);expect(f.calls().length-before).toBe(1);}finally{abort.abort();}
      expect(await pending).toMatchObject({reason:'aborted'});expect(f.calls().length-before).toBe(1);
      expect(await f.engine().executeRaw("SELECT attempt_id FROM codex_subscription_attempts WHERE run_id=$1 AND state='active'",[id])).toHaveLength(0);
    });
  });
});}
