import { beforeAll, beforeEach, afterAll, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runThink, type RunThinkOpts } from '../../src/core/think/index.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { invokeAI, withAIInvocationGuard } from '../../src/core/ai/invocation-guard.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription, type CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';

export function codexThinkContract(createEngine: () => Promise<{ engine: BrainEngine; cleanup?: () => Promise<void> }>) {
  const root=mkdtempSync(join(tmpdir(),'codex-think-')),bin=join(root,'fixture.mjs'),capture=join(root,'calls.jsonl'),control=join(root,'reply.json');
  const keys=['HOME','GBRAIN_HOME','CODEX_HOME'] as const,saved=keys.map(k=>[k,process.env[k]] as const),fetch=globalThis.fetch;
  let engine:BrainEngine,cleanup:(()=>Promise<void>)|undefined,unregister:()=>void,seq=0;
  const sourceId='think-fixture',slug='notes/orbit';
  const valid={answer:'Orbit launched in March. [notes/orbit#1]',citations:[{page_slug:slug,row_num:1,citation_index:1}],gaps:[]};
  const reply=(value:unknown)=>writeFileSync(control,JSON.stringify(value));
  const calls=()=>readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const think=(opts:Partial<RunThinkOpts>={},target=engine)=>runThink(target,{question:'Orbit',anchor:slug,sourceId,remote:false,...opts});
  const run=async<T>(fn:(id:string)=>Promise<T>,hooks:Partial<CodexSubscriptionContext>={},maxAttempts=4)=>{
    const runId=`think-${seq++}`;await createSubscriptionRun(engine,{runId,accountLane:runId,maxAttempts,maxTurns:maxAttempts,deadline:new Date(Date.now()+600000)});
    return withCodexSubscription({engine,runId,...hooks},()=>fn(runId));
  };
  beforeAll(async()=>{
    for(const key of keys)process.env[key]=root;
    globalThis.fetch=(()=>{throw new Error('forbidden network');}) as unknown as typeof fetch;
    mkdirSync(join(root,'.gbrain'));writeFileSync(join(root,'.gbrain','config.json'),JSON.stringify({embedding_disabled:true,private_codex:{mode:'strict',model:'codex-cli:gpt-test',bin}}));
    writeFileSync(capture,'');
    const script=`#!${Bun.which('node')}
import {readFileSync,writeFileSync,appendFileSync,statSync} from 'node:fs';
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1],schema=JSON.parse(readFileSync(arg('--output-schema'),'utf8'));
appendFileSync(${JSON.stringify(capture)},JSON.stringify({args,schema,prompt:readFileSync(0,'utf8'),mode:statSync(arg('--output-schema')).mode&511,envKeys:Object.keys(process.env)})+'\\n');
const value=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
const text=value.raw??JSON.stringify({evidence_hash:schema.properties.evidence_hash.enum[0],...value});
writeFileSync(arg('--output-last-message'),text);
for(const event of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},
{type:'item.completed',item:{type:value.refusal?'refusal':'agent_message',text}},
...(value.missingCompletion?[]:[{type:'turn.completed',usage:{input_tokens:21,cached_input_tokens:0,output_tokens:9}}])]) console.log(JSON.stringify(event));
`;
    writeFileSync(bin,script,{mode:0o700});unregister=__registerCodexFixtureForTests(bin,createHash('sha256').update(script).digest('hex'));
    ({engine,cleanup}=await createEngine());await engine.initSchema();configureGateway({env:{}});
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)',[sourceId,'Synthetic think source']);
    const page=await engine.putPage(slug,{type:'note',title:'Orbit',compiled_truth:'Orbit launched in March. The launch was successful.'},{sourceId});
    await engine.addTakesBatch([{page_id:page.id,row_num:1,claim:'Orbit launched in March',kind:'fact',holder:'world',weight:1}]);
    await engine.putPage('notes/foreign',{type:'note',title:'Foreign',compiled_truth:'Foreign private reference.'});
  });
  beforeEach(async()=>{reply(valid);await engine.executeRaw('DELETE FROM calibration_profiles');for(const key of ['models.think','models.tier.deep','decide.slots.intent.mode'])await engine.setConfig(key,'');});
  afterAll(async()=>{await engine?.disconnect();await cleanup?.();unregister?.();resetGateway();globalThis.fetch=fetch;for(const [key,value]of saved)if(value===undefined)delete process.env[key];else process.env[key]=value;rmSync(root,{recursive:true,force:true});});
  test('real think transports the native schema and preserves grounded citations and measured tokens',async()=>{
    await run(async id=>{
      expect(await think()).toMatchObject({synthesisOk:true,synthesis_status:'ok',answer:valid.answer,citations:valid.citations,modelUsed:'codex-cli:gpt-test',usage:{input_tokens:21,output_tokens:9}});
      const [row]=await engine.executeRaw<{attempts:number;accepted_turns:number}>('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[id]);
      expect(Number(row!.attempts)).toBe(1);expect(Number(row!.accepted_turns)).toBe(1);
    });
    const wire=calls().at(-1)!;expect(wire.args).toContain('--output-schema');expect(wire.mode).toBe(0o600);
    expect(wire.schema.required).toContain('citations');expect(wire.prompt).toContain('Orbit launched in March');
    expect(wire.prompt).not.toContain('Foreign private reference');expect(wire.envKeys.some((key:string)=>/API_KEY|TOKEN|DATABASE_URL/.test(key))).toBe(false);
  });
  test.each([
    {raw:'malformed'}, {...valid,evidence_hash:'wrong'}, {...valid,operation_id:'forged'},
    {...valid,citations:[]}, {...valid,citations:[{page_slug:'notes/foreign',row_num:null,citation_index:1}],answer:'Foreign [notes/foreign]'},
    {...valid,citations:[{page_slug:slug,row_num:99,citation_index:1}],answer:'Orbit [notes/orbit#99]'},
    {...valid,citations:[{page_slug:slug,row_num:1,citation_index:2}]}, {...valid,citations:[...valid.citations,...valid.citations]},
    {...valid,gaps:['   ']}, {...valid,answer:'Uncited claims'},
  ])('invalid output is a failure, never salvaged or accepted',async value=>{
    reply(value);await run(async id=>{await expect(think()).rejects.toMatchObject({reason:'invalid_output'});
      const [row]=await engine.executeRaw<{accepted_turns:number}>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[id]);expect(Number(row!.accepted_turns)).toBe(0);
    });
  });
  test.each([{refusal:true},{missingCompletion:true}])('provider refusal and missing completion stay explicit failures',async value=>{
    reply(value);await run(async id=>{await expect(think()).rejects.toMatchObject({reason:value.refusal?'refusal':'missing_completion'});
      const [attempt]=await engine.executeRaw<{state:string}>('SELECT state FROM codex_subscription_attempts WHERE run_id=$1',[id]);expect(attempt!.state).toBe('unresolved');
    });
  });
  test('valid empty output is distinct from parsing failure and cannot be saved as success',async()=>{
    reply({answer:'',citations:[],gaps:['No supported conclusion.']});
    await run(async()=>{expect(await think()).toMatchObject({synthesisOk:false,synthesis_status:'empty_answer',answer:'',gaps:['No supported conclusion.']});});
  });
  test('missing allowance, injected clients, conflicting pins and oversized input never invoke Codex',async()=>{
    const before=calls().length;await expect(think()).rejects.toMatchObject({code:'subscription_required'});
    await run(async()=>{
      await expect(think({stubResponse:valid})).rejects.toMatchObject({reason:'invalid_input'});
      await expect(think({question:'a'.repeat(16001)})).rejects.toMatchObject({reason:'invalid_input'});
      await expect(think({allowedSources:[]})).rejects.toMatchObject({reason:'invalid_input'});
      await engine.setConfig('models.think','anthropic:forbidden');await expect(think()).rejects.toMatchObject({code:'private_route_conflict'});
    });expect(calls().length).toBe(before);
  });
  test('quota exhaustion and cancellation prevent additional inference',async()=>{
    await run(async()=>{await think();const before=calls().length;await expect(think()).rejects.toMatchObject({code:'subscription_exhausted'});expect(calls().length).toBe(before);},{},1);
    const abort=new AbortController();abort.abort();const before=calls().length;
    await run(async()=>{await expect(think()).rejects.toMatchObject({reason:'aborted'});},{signal:abort.signal});expect(calls().length).toBe(before);
  });
  test('required retrieval failures are redacted and cannot produce a completed answer',async()=>{
    const broken=new Proxy(engine,{get(target,key){if(key==='searchTakes')return async()=>{throw new Error('synthetic private error detail');};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    const before=calls().length;await run(async()=>{await expect(think({},broken)).rejects.toMatchObject({code:'retrieval_failed'});});expect(calls().length).toBe(before);
  });
  test('trajectory query failure cannot become a successful empty history',async()=>{
    const company='companies/orbit',page=await engine.putPage(company,{type:'company',title:'Orbit',compiled_truth:'Orbit launched in March.'},{sourceId});
    let queried=0;
    const broken=new Proxy(engine,{get(target,key){if(key==='findTrajectory')return async()=>{queried++;throw new Error('synthetic trajectory failure');};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    try{
      const before=calls().length;
      await run(async()=>{await expect(think({question:'When did Orbit launch?',anchor:company},broken)).rejects.toMatchObject({code:'retrieval_failed'});});
      expect(queried).toBeGreaterThan(0);expect(calls().length).toBe(before);
    }finally{await engine.executeRaw('DELETE FROM pages WHERE id=$1',[page.id]);}
  });
  test('an enabled generative decision proxy fails before dispatch',async()=>{
    const before=calls().length;await engine.setConfig('decide.slots.intent.mode','on');
    await run(async()=>{await expect(think()).rejects.toMatchObject({code:'private_route_conflict',source:'think:decide.slots'});});expect(calls().length).toBe(before);
  });
  test('calibration lookup is source scoped and hides unpublished profiles from remote callers',async()=>{
    async function profile(source:string,text:string){await engine.executeRaw(`INSERT INTO calibration_profiles(source_id,holder,published,total_resolved,pattern_statements,active_bias_tags,model_id,domain_scorecards,voice_gate_passed,voice_gate_attempts) VALUES($1,'self',false,5,$2::text[],ARRAY[]::text[],'fixture','{}'::jsonb,true,1)`,[source,[text]]);}
    await profile('default','FOREIGN CALIBRATION DETAIL');
    await run(async()=>{expect((await think({withCalibration:true})).warnings).toContain('NO_CALIBRATION_PROFILE');});expect(calls().at(-1)!.prompt).not.toContain('FOREIGN CALIBRATION DETAIL');
    await profile(sourceId,'LOCAL CALIBRATION DETAIL');await run(async()=>{await think({withCalibration:true});});expect(calls().at(-1)!.prompt).toContain('LOCAL CALIBRATION DETAIL');
    await run(async()=>{await think({withCalibration:true,remote:true});});expect(calls().at(-1)!.prompt).not.toContain('LOCAL CALIBRATION DETAIL');
  });
  test('mixed retrieval requires and respects the independent auxiliary guard',async()=>{
    const path=join(root,'.gbrain','config.json'),original=readFileSync(path,'utf8');
    const config=JSON.parse(original);config.embedding_disabled=false;writeFileSync(path,JSON.stringify(config));
    let dispatched=0,settled=0,remaining=1;
    const embedQuestion=()=>invokeAI({operation:'synthetic.embedding',kind:'embedding',model:'synthetic:embedding'},async()=>{dispatched++;return null;},()=>({inputTokens:2,outputTokens:0}));
    try{
      const before=calls().length;
      await run(async()=>{await expect(think({embedQuestion})).rejects.toMatchObject({code:'subscription_auxiliary_budget_required'});});
      expect(dispatched).toBe(0);expect(calls().length).toBe(before);
      await withAIInvocationGuard(async call=>{
        if(call.kind==='embedding'){if(!remaining--)throw new Error('synthetic auxiliary budget exhausted');return {settle:async()=>{settled++;}};}
        return {settle:async()=>{}};
      },()=>run(async()=>{
        expect((await think({embedQuestion})).synthesisOk).toBe(true);
        const count=calls().length;await expect(think({embedQuestion})).rejects.toThrow('synthetic auxiliary budget exhausted');expect(calls().length).toBe(count);
      }));
      expect(dispatched).toBe(1);expect(settled).toBe(1);
    }finally{writeFileSync(path,original);}
  });
  test('same-slug takes in different sources cannot be silently conflated',async()=>{
    const duplicate=await engine.putPage(slug,{type:'note',title:'Orbit other source',compiled_truth:'Orbit alternative account.'});
    await engine.addTakesBatch([{page_id:duplicate.id,row_num:1,claim:'Orbit alternative account',kind:'fact',holder:'world',weight:1}]);
    try{await run(async()=>{await expect(think({allowedSources:[sourceId,'default']})).rejects.toMatchObject({reason:'invalid_output'});});}
    finally{await engine.executeRaw('DELETE FROM takes WHERE page_id=$1',[duplicate.id]);await engine.executeRaw('DELETE FROM pages WHERE id=$1',[duplicate.id]);}
  });
  test('canonical Unicode page slugs remain valid citations',async()=>{
    const unicodeSlug='notes/轨道';
    const page=await engine.putPage(unicodeSlug,{type:'note',title:'Orbit',compiled_truth:'Orbit launched in March.'},{sourceId});
    reply({answer:`Orbit launched in March. [${unicodeSlug}]`,citations:[{page_slug:unicodeSlug,row_num:null,citation_index:1}],gaps:[]});
    try{await run(async()=>{expect(await think({anchor:unicodeSlug})).toMatchObject({synthesisOk:true,citations:[{page_slug:unicodeSlug,row_num:null,citation_index:1}]});});}
    finally{await engine.executeRaw('DELETE FROM pages WHERE id=$1',[page.id]);}
  });
  test('quoted text in the question alone cannot ground a generated quote',async()=>{
    reply({...valid,answer:'"Fictional orbital certainty" [notes/orbit]',citations:[{page_slug:slug,row_num:null,citation_index:1}]});
    await run(async()=>{const result=await think({question:'Orbit: "Fictional orbital certainty"'});expect(result.quote_check?.unverified).toBe(1);expect(result.answer).toContain('[unverified]');});
  });
}
