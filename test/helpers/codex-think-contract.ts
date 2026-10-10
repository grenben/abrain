import { codexSkilloptScoreContract } from './codex-skillopt-score-contract.ts';
import { codexSkilloptReflectContract } from './codex-skillopt-reflect-contract.ts';
import { codexBrainstormEvalContract } from './codex-brainstorm-eval-contract.ts';
import { codexBrainstormRunContract } from './codex-brainstorm-run-contract.ts';
import { codexBrainstormJudgeContract } from './codex-brainstorm-judge-contract.ts';
import { codexEvalAllowanceContract } from './codex-eval-allowance-contract.ts';
import { codexEvalRunContract } from './codex-eval-run-contract.ts';
import { codexFactKeysContract } from './codex-fact-keys-contract.ts';
import { codexSynopsisTierContract } from './codex-synopsis-tier-contract.ts';
import { codexScratchContract } from './codex-scratch-contract.ts';
import { codexContextualContract } from './codex-contextual-contract.ts';
import { codexProposalCacheContract } from './codex-proposal-cache-contract.ts';
import { codexEvalContract } from './codex-eval-contract.ts';
import { codexParserContract } from './codex-parser-contract.ts';
import { codexThinkAbContract } from './codex-think-ab-contract.ts';
import { codexThinkAutomationContract } from './codex-think-automation-contract.ts';
import { beforeAll, beforeEach, afterAll, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runThink, persistSynthesis, type RunThinkOpts } from '../../src/core/think/index.ts';
import { persistTakeFromSynthesis } from '../../src/core/think/persist-take.ts';
import { digest } from '../../src/core/persistence/digest.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
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
    mkdirSync(join(root,'.gbrain'));writeFileSync(join(root,'.gbrain','config.json'),JSON.stringify({embedding_disabled:true,embedding_dimensions:1536,private_codex:{mode:'strict',model:'codex-cli:gpt-test',bin}}));
    writeFileSync(capture,'');
    const script=`#!${Bun.which('node')}
import {readFileSync,writeFileSync,appendFileSync,statSync} from 'node:fs';
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1],schema=JSON.parse(readFileSync(arg('--output-schema'),'utf8'));
const prompt=readFileSync(0,'utf8');
appendFileSync(${JSON.stringify(capture)},JSON.stringify({args,schema,prompt,mode:statSync(arg('--output-schema')).mode&511,envKeys:Object.keys(process.env)})+'\\n');
const configured=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
let value=configured.byRole?configured.byRole[schema.properties.claims?'extractor':schema.properties.citations?'reader':'judge']:configured;
if(value.autoReflect)value=value[JSON.parse(JSON.parse(prompt).messages[0].content).mode];
if(value.autoBrainstorm){if(schema.properties.ideas.items.properties.far_quote){const data=JSON.parse(JSON.parse(prompt).messages[0].content);value=value.badCross||(value.failCrossQuestion&&data.question.includes(value.failCrossQuestion))?{raw:'{}'}:value.emptyCross?{ideas:[]}:{ideas:[{text:'Connect the two domains through a testable constraint.',close_quote:data.close?.content??null,far_quote:data.far.content}]};}else value=value.badJudge?{raw:'{}'}:{autoJudge:true};}
if(value.autoJudge){const ids=schema.properties.ideas.items.properties.id.enum;value=ids.includes(value.failId)?{raw:'{}'}:{ideas:ids.map(id=>({id,scores:{originality:4,resistance:4,thesis_density:4,concrete_grounding:4,cognitive_load:4},note:'Synthetic grounded idea.'}))};}
if(value?.citations?.[0]?.session_id==='__first_session__')value.citations[0].session_id=JSON.parse(prompt).messages[0].content.match(/<chat_session id="([^"]+)"/)[1];
if(value.wait) await new Promise(()=>setInterval(()=>{},1000));
const text=value.raw??JSON.stringify({...(schema.properties.evidence_hash?{evidence_hash:schema.properties.evidence_hash.enum[0]}:{}),...value});
writeFileSync(arg('--output-last-message'),text);
for(const event of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},
{type:'item.completed',item:{type:value.refusal?'refusal':'agent_message',text}},
...(value.missingCompletion?[]:[{type:'turn.completed',usage:{input_tokens:21,cached_input_tokens:0,output_tokens:9}}])]) console.log(JSON.stringify(event));
`;
    writeFileSync(bin,script,{mode:0o700});unregister=__registerCodexFixtureForTests(bin,createHash('sha256').update(script).digest('hex'));
    ({engine,cleanup}=await createEngine());await engine.initSchema();configureGateway({env:{},embedding_dimensions:1536});
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)',[sourceId,'Synthetic think source']);
    const page=await engine.putPage(slug,{type:'note',title:'Orbit',compiled_truth:'Orbit launched in March. The launch was successful.'},{sourceId});
    await engine.addTakesBatch([{page_id:page.id,row_num:1,claim:'Orbit launched in March',kind:'fact',holder:'world',weight:1}]);
    await engine.putPage('notes/foreign',{type:'note',title:'Foreign',compiled_truth:'Foreign private reference.'});
  });
  beforeEach(async()=>{reply(valid);await engine.executeRaw('DELETE FROM calibration_profiles');for(const key of ['models.think','models.tier.deep','decide.slots.intent.mode'])await engine.setConfig(key,'');});
  afterAll(async()=>{await disposePersistenceConsumer(engine);await engine?.disconnect();await cleanup?.();unregister?.();resetGateway();globalThis.fetch=fetch;for(const [key,value]of saved)if(value===undefined)delete process.env[key];else process.env[key]=value;rmSync(root,{recursive:true,force:true});});
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
  test('save retains the validated plan before effects and replays committed receipts without inference',async()=>{
    await run(async id=>{
      const result=await think({save:true});expect(result.codex_publication).toBeDefined();
      const [plan]=await engine.executeRaw<{state:string;admitted:number[]}>('SELECT state,admitted FROM codex_think_publications WHERE run_id=$1',[id]);
      expect(plan).toMatchObject({state:'accepted',admitted:[]});
      const count=calls().length;
      const [saved,concurrent]=await Promise.all([persistSynthesis(engine,result,{sourceId}),persistSynthesis(engine,result,{sourceId})]);expect(concurrent).toEqual(saved);expect(saved!.evidenceInserted).toBe(1);
      const page=await engine.getPage(saved.slug,{sourceId});expect(page?.compiled_truth).toContain('Orbit launched in March');
      expect(await engine.executeRaw('SELECT * FROM synthesis_evidence WHERE synthesis_page_id=$1',[page!.id])).toHaveLength(1);
      const retry=await think({save:true});expect(retry.codex_publication).toEqual(result.codex_publication);
      expect(await persistSynthesis(engine,retry,{sourceId})).toEqual(saved);expect(calls().length).toBe(count);
      expect((await engine.executeRaw<{state:string}>('SELECT state FROM codex_think_publications WHERE run_id=$1',[id]))[0]!.state).toBe('complete');
      await expect(think({save:true,excludePrivate:true})).rejects.toMatchObject({code:'idempotency_conflict'});
    });
  });
  test('publication rejects changed content and cross-source replay before effects',async()=>{
    await run(async()=>{
      const result=await think({save:true});
      await expect(persistSynthesis(engine,{...result,answer:'Changed'}, {sourceId})).rejects.toMatchObject({code:'idempotency_conflict'});
      await expect(persistSynthesis(engine,result,{sourceId:'default'})).rejects.toMatchObject({code:'idempotency_conflict'});
    });
  });
  test('a missing receipt for an admitted plan blocks replay instead of minting a new request',async()=>{
    await run(async()=>{
      const result=await think({save:true});
      await engine.executeRaw("UPDATE codex_think_publications SET admitted=ARRAY[0] WHERE plan_id=$1::uuid",[result.codex_publication!.plan_id]);
      await expect(persistSynthesis(engine,result,{sourceId})).rejects.toMatchObject({code:'write_pending'});
      expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE intent->>'codex_think_plan'=$1",[result.codex_publication!.plan_id])).toHaveLength(0);
    });
  });
  test('changed evidence refuses publication and leaves its retained answer available',async()=>{
    await run(async()=>{
      const result=await think({save:true});
      const [take]=await engine.executeRaw<{id:number}>('SELECT t.id FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug=$2 AND t.row_num=1',[sourceId,slug]);
      await engine.executeRaw('UPDATE takes SET weight=0.25 WHERE id=$1',[take!.id]);
      try{await expect(persistSynthesis(engine,result,{sourceId})).rejects.toMatchObject({code:'revision_conflict'});
        expect((await think({save:true})).answer).toBe(result.answer);
      }finally{await engine.executeRaw('UPDATE takes SET weight=1 WHERE id=$1',[take!.id]);}
    });
  });
  test('cancellation before admission writes nothing and does not hide a previously committed receipt',async()=>{
    const abort=new AbortController();
    await run(async()=>{
      const result=await think({save:true});abort.abort();
      await expect(persistSynthesis(engine,result,{sourceId})).rejects.toThrow();
      expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE intent->>'codex_think_plan'=$1",[result.codex_publication!.plan_id])).toHaveLength(0);
    },{signal:abort.signal});
    const after=new AbortController();
    await run(async()=>{const result=await think({save:true});const saved=await persistSynthesis(engine,result,{sourceId});after.abort();
      expect(await persistSynthesis(engine,result,{sourceId})).toEqual(saved);
    },{signal:after.signal});
  });
  test('expired allowance refuses new effects but a committed receipt remains replayable',async()=>{
    await run(async id=>{const result=await think({save:true});
      await engine.executeRaw("UPDATE codex_subscription_runs SET deadline=now()-interval '1 second' WHERE run_id=$1",[id]);
      await expect(persistSynthesis(engine,result,{sourceId})).rejects.toMatchObject({code:'write_pending'});
    });
    await run(async id=>{const result=await think({save:true});const saved=await persistSynthesis(engine,result,{sourceId});
      await engine.executeRaw("UPDATE codex_subscription_runs SET deadline=now()-interval '1 second' WHERE run_id=$1",[id]);
      expect(await persistSynthesis(engine,result,{sourceId})).toEqual(saved);
    });
  });
  test('citation failure rolls back the page and refuses a successful publication',async()=>{
    await run(async()=>{const result=await think({save:true});
      await engine.executeRaw("CREATE FUNCTION fail_think_citations() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic citation failure'; END $$");
      await engine.executeRaw('CREATE TRIGGER fail_think_citations BEFORE INSERT ON synthesis_evidence FOR EACH ROW EXECUTE FUNCTION fail_think_citations()');
      try{await expect(persistSynthesis(engine,result,{sourceId})).rejects.toThrow();
        const [plan]=await engine.executeRaw<{payload:{actions:Array<{admission:{slug:string}}>};state:string}>('SELECT payload,state FROM codex_think_publications WHERE plan_id=$1::uuid',[result.codex_publication!.plan_id]);
        expect(plan!.state).toBe('accepted');expect(await engine.getPage(plan!.payload.actions[0]!.admission.slug,{sourceId})).toBeNull();
      }finally{await engine.executeRaw('DROP TRIGGER fail_think_citations ON synthesis_evidence');await engine.executeRaw('DROP FUNCTION fail_think_citations()');}
    });
  });
  test.each(['before admission','after preparation'])('a superseded worker cannot publish (%s)',async phase=>{
    const data={source_id:sourceId},authority={kind:'application',version:1};
    const [job]=await engine.executeRaw<{id:number}>("INSERT INTO minion_jobs(name,status,lock_token,lock_until,data,submission_authority) VALUES('fixture','active','worker-a',now()+interval '10 minutes',$1::text::jsonb,$2::text::jsonb) RETURNING id",[JSON.stringify(data),JSON.stringify(authority)]);
    const steal=()=>engine.executeRaw("UPDATE minion_jobs SET lock_token='worker-b',claim_generation=claim_generation+1 WHERE id=$1",[job!.id]);
    await run(async()=>{
      const result=await think({save:true});
      if(phase==='before admission')await steal();
      else installFaultHook(async point=>{if(point==='consumer:prepared')await steal();});
      try{await expect(persistSynthesis(engine,result,{sourceId})).rejects.toMatchObject({code:'write_claim_lost'});}
      finally{installFaultHook(undefined);}
      const [plan]=await engine.executeRaw<{payload:{actions:Array<{admission:{slug:string}}>};state:string}>('SELECT payload,state FROM codex_think_publications WHERE plan_id=$1::uuid',[result.codex_publication!.plan_id]);
      expect(plan!.state).toBe('accepted');expect(await engine.getPage(plan!.payload.actions[0]!.admission.slug,{sourceId})).toBeNull();
      if(phase==='before admission')expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE intent->>'codex_think_plan'=$1",[result.codex_publication!.plan_id])).toHaveLength(0);
    },{publicationFence:{jobId:job!.id,lockToken:'worker-a',jobDigest:digest({data,authority})}});
  });
  test('disabling private mode cannot turn a Codex result into an unjournaled write',async()=>{
    await run(async()=>{
      const result=await think({save:true}),path=join(root,'.gbrain','config.json'),original=readFileSync(path,'utf8');
      const config=JSON.parse(original);delete config.private_codex;writeFileSync(path,JSON.stringify(config));
      try{const {codex_publication:_plan,...unbound}=result;
        await expect(persistSynthesis(engine,unbound,{sourceId})).rejects.toMatchObject({code:'invalid_params'});
        await expect(persistTakeFromSynthesis(engine,unbound,{anchor:slug,sourceId})).rejects.toMatchObject({code:'invalid_params'});
      }finally{writeFileSync(path,original);}
    });
  });
  test('managed save plus take recovers after the page commit without regenerating or duplicating effects',async()=>{
    await disposePersistenceConsumer(engine);
    const destination='think-managed',dir=join(root,'managed');mkdirSync(dir);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)',[destination,dir]);
    await claimWorktree(engine,destination,dir);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await submitPageMutation({engine,sourceId:destination,remote:false,dryRun:false,config:{engine:engine.kind,embedding_disabled:true},logger:{info(){},warn(){},error(){}}},
      {operation:'put_page',params:{source_id:destination,slug:'notes/anchor',content:'---\ntype: note\ntitle: Anchor\n---\nOrbit is under review.'}});
    try{await run(async()=>{
      const opts={save:true,take:true,anchor:'notes/anchor',sourceId:destination,allowedSources:[sourceId,destination]};
      const anchorPath=join(dir,'notes/anchor.md');renameSync(anchorPath,anchorPath+'.held');
      try{await expect(think(opts)).rejects.toMatchObject({code:'source_changed'});
        expect(await engine.executeRaw('SELECT plan_id FROM codex_think_publications WHERE source_id=$1',[destination])).toHaveLength(0);
        expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 AND protocol_version=4',[destination])).toHaveLength(0);
      }finally{renameSync(anchorPath+'.held',anchorPath);}
      const result=await think(opts),count=calls().length;
      const saved=await persistSynthesis(engine,result,{sourceId:destination});
      expect(readFileSync(join(dir,saved.slug+'.md'),'utf8')).toContain('Orbit launched in March');
      expect((await engine.executeRaw<{state:string}>('SELECT state FROM codex_think_publications WHERE plan_id=$1::uuid',[result.codex_publication!.plan_id]))[0]!.state).toBe('accepted');
      reply({raw:'invalid after retained plan'});
      const recovered=await think(opts);expect(calls().length).toBe(count);
      const taken=await persistTakeFromSynthesis(engine,recovered,{anchor:'notes/anchor',sourceId:destination});expect(taken.take_row).toBe(1);
      expect(readFileSync(join(dir,'notes/anchor.md'),'utf8')).toContain('Orbit launched in March');
      expect(await persistTakeFromSynthesis(engine,recovered,{anchor:'notes/anchor',sourceId:destination})).toEqual(taken);
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 AND protocol_version=4',[destination])).toHaveLength(2);
      expect((await engine.executeRaw<{state:string}>('SELECT state FROM codex_think_publications WHERE plan_id=$1::uuid',[result.codex_publication!.plan_id]))[0]!.state).toBe('complete');
    });}finally{await disposePersistenceConsumer(engine);await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');}
  });
  test('quoted text in the question alone cannot ground a generated quote',async()=>{
    reply({...valid,answer:'"Fictional orbital certainty" [notes/orbit]',citations:[{page_slug:slug,row_num:null,citation_index:1}]});
    await run(async()=>{const result=await think({question:'Orbit: "Fictional orbital certainty"'});expect(result.quote_check?.unverified).toBe(1);expect(result.answer).toContain('[unverified]');});
  });
  codexBrainstormRunContract({root,engine:()=>engine,sourceId,run,reply,calls});
  codexBrainstormEvalContract({root,engine:()=>engine,run,reply,calls});
  codexSkilloptScoreContract({engine:()=>engine,run,reply,calls});
  codexSkilloptReflectContract({engine:()=>engine,run,reply,calls});
  codexBrainstormJudgeContract({engine:()=>engine,run,reply,calls});
  codexContextualContract({engine:()=>engine,sourceId,run,reply,calls});
  codexProposalCacheContract({engine:()=>engine,run,reply,calls});
  codexFactKeysContract({root,engine:()=>engine,run,reply,calls});
  codexSynopsisTierContract({root,engine:()=>engine,run,reply,calls});
  codexScratchContract({engine:()=>engine,run,reply,calls});
  codexEvalAllowanceContract({root,engine:()=>engine,reply,calls});
  codexEvalRunContract({engine:()=>engine,run,reply,calls});
  codexEvalContract({engine:()=>engine,sourceId,run,reply,calls});
  codexParserContract({engine:()=>engine,sourceId,run,reply,calls});
  codexThinkAbContract({engine:()=>engine,sourceId,run,reply,valid,calls});
  codexThinkAutomationContract({engine:()=>engine,sourceId,root,run,reply,valid,calls});

}
