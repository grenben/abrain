import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { runBootstrap, runBootstrapFromSkill } from '../../src/core/skillopt/bootstrap-benchmark.ts';
import { runGuardedBootstrap } from '../../src/core/skillopt/bootstrap-run.ts';
import { loadBenchmark } from '../../src/core/skillopt/benchmark.ts';
import { boundedBootstrapRegex } from '../../src/core/skillopt/codex-bootstrap-proposal.ts';
import { BOOTSTRAP_PENDING_REVIEW } from '../../src/core/skillopt/types.ts';
interface Fixture {engine():BrainEngine;reply(value:unknown):void;calls():Array<any>;
  run<T>(fn:(id:string)=>Promise<T>,hooks?:Partial<CodexSubscriptionContext>,maxAttempts?:number):Promise<T>}
const skillName='synthetic-skill', skillText='---\nname: synthetic-skill\ntools: [search]\n---\n## Method\nUse grounded evidence.\n';
const checks=[{op:'contains',arg:'Grounded'},{op:'max_chars',arg:4096}];
async function fixture<T>(fn:(v:{skillsDir:string;directory:string;skill:string;routing:string;output:string;opts:{skillsDir:string;skillName:string;optimizerModel:string;taskCount:number}})=>Promise<T>):Promise<T>{
  const skillsDir=mkdtempSync(join(tmpdir(),'codex-bootstrap-')),directory=join(skillsDir,skillName);mkdirSync(directory);
  const skill=join(directory,'SKILL.md'),routing=join(directory,'routing-eval.jsonl'),output=join(directory,'skillopt-benchmark.jsonl');
  writeFileSync(skill,skillText);writeFileSync(routing,[{intent:'Grounded first task',expected_skill:skillName},{intent:'Unrelated skill',expected_skill:'another-skill'},{intent:'Grounded second task',expected_skill:skillName}].map(v=>JSON.stringify(v)).join('\n'));
  try{return await fn({skillsDir,directory,skill,routing,output,opts:{skillsDir,skillName,optimizerModel:'codex-cli:gpt-test',taskCount:2}});}finally{rmSync(skillsDir,{recursive:true,force:true});}
}
export function codexSkilloptBootstrapContract(f:Fixture){describe('native skill benchmark generation',()=>{
  test('actual skill bootstrap transports native schema, assigns IDs and preserves mandatory review',async()=>fixture(async v=>{
    f.reply({autoBootstrap:true});const before=f.calls().length;await f.run(async id=>{
      expect(await runBootstrapFromSkill(v.opts)).toMatchObject({rowsGenerated:2,rowsSkipped:0,cacheHit:false,billing:{kind:'subscription',costUsd:null,remainingQuota:null},usage:{input_tokens:21,output_tokens:9}});
      const output=readFileSync(v.output,'utf8');expect(output).toContain(BOOTSTRAP_PENDING_REVIEW);expect(()=>loadBenchmark(v.output)).toThrow();
      expect(loadBenchmark(v.output,{bootstrapReviewed:true}).tasks.map(t=>t.task_id)).toEqual(['synthetic-skill-001','synthetic-skill-002']);expect(statSync(v.output).mode&0o777).toBe(0o600);
      await expect(runBootstrapFromSkill(v.opts)).rejects.toMatchObject({code:'benchmark_exists'});
      expect(await runBootstrapFromSkill({...v.opts,force:true})).toMatchObject({cacheHit:true,rowsGenerated:2});expect(readFileSync(v.output,'utf8')).toBe(output);
      expect(await f.engine().executeRaw('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[id])).toEqual([{attempts:1,accepted_turns:1}]);
    });expect(f.calls().length-before).toBe(1);const wire=f.calls().at(-1)!;expect(wire.args).toContain('--output-schema');expect(wire.mode).toBe(0o600);
    expect(wire.schema.properties.tasks.minItems).toBe(2);expect(JSON.parse(JSON.parse(wire.prompt).messages[0].content).skillText).toBe(skillText);
  }));
  test('routing bootstrap validates all rows and emits the exact selected intents in one bounded call',async()=>fixture(async v=>{
    f.reply({autoBootstrap:true});const before=f.calls().length;await f.run(async()=>{expect(await runBootstrap(v.opts)).toMatchObject({rowsGenerated:2,rowsSkipped:0});});
    expect(loadBenchmark(v.output,{bootstrapReviewed:true}).tasks.map(t=>t.task)).toEqual(['Grounded first task','Grounded second task']);expect(f.calls().length-before).toBe(1);
  }));
  test.each([{raw:'not JSON'},{tasks:[]},{tasks:[{task:'One',checks}]},{tasks:[{task:'Same',checks},{task:'Same',checks}]},
    {tasks:[{task:'One',checks:[checks[0],{op:'max_chars',arg:'4000'}]},{task:'Two',checks}]},
    {tasks:[{task:'One',checks:[checks[0],checks[0]]},{task:'Two',checks}]},
    {tasks:[{task:'One',checks:[checks[0],{op:'tool_called',arg:'shell'}]},{task:'Two',checks}]},
    {tasks:[{task:'One',checks:[{op:'tool_called',arg:'search'},{op:'tool_not_called',arg:'search'}]},{task:'Two',checks}]},
    {tasks:[{task:'One',checks:[checks[0],{op:'regex',arg:'^(a+)+$'}]},{task:'Two',checks}]},
    {tasks:[{task:'One',checks:[checks[0],{op:'section_present',arg:'###'}]},{task:'Two',checks}]},
    {tasks:[{task:'One',checks:[checks[0],{op:'contains',arg:' '} ]},{task:'Two',checks}]},
    {tasks:[{task:'One',checks,task_id:'forged'},{task:'Two',checks}]},
    {tasks:[{task:'One',checks},{task:'Two',checks}],operation_id:'forged'}])('invalid proposals produce neither partial drafts nor accepted cached turns',async value=>fixture(async v=>{
      f.reply(value);await f.run(async id=>{await expect(runBootstrapFromSkill(v.opts)).rejects.toMatchObject({reason:'invalid_output'});
        expect(existsSync(v.output)).toBe(false);expect(await f.engine().executeRaw('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[id])).toEqual([{accepted_turns:0}]);
      });
    }));
  test('all generated rule kinds have typed arguments and declared-tool checks remain data',async()=>fixture(async v=>{
    const rows=[{task:'Grounded one',checks:[{op:'regex',arg:'^[A-Za-z ]{1,64}$'},{op:'section_present',arg:'Evidence'},{op:'min_citations',arg:1},{op:'tool_called',arg:'search'}]},
      {task:'Grounded two',checks:[{op:'tool_not_called',arg:'search'},{op:'max_chars',arg:4000}]}];
    f.reply({tasks:rows});await f.run(async()=>{await runBootstrapFromSkill(v.opts);});expect(loadBenchmark(v.output,{bootstrapReviewed:true}).tasks[0]!.judge).toMatchObject({checks:rows[0]!.checks});
    for(const pattern of ['^(a+)+$','^a.*$','^a{0,64}$','^a{1,65}$','^a{1,3}b{1,3}$','^(a)\\1$','^a|b$','['])expect(boundedBootstrapRegex(pattern)).toBe(false);
  }));
  test('routing task substitution is refused and leaves the prior draft untouched',async()=>fixture(async v=>{
    writeFileSync(v.output,'Existing draft');f.reply({tasks:[{task:'Changed first task',checks},{task:'Grounded second task',checks}]});
    await f.run(async()=>{await expect(runBootstrap({...v.opts,force:true})).rejects.toMatchObject({reason:'invalid_output'});});expect(readFileSync(v.output,'utf8')).toBe('Existing draft');
  }));
  test('malformed routing rows, oversized files, symlinks and invalid counts fail before dispatch',async()=>fixture(async v=>{
    const before=f.calls().length;await f.run(async()=>{
      writeFileSync(v.routing,'broken JSON');await expect(runBootstrap(v.opts)).rejects.toMatchObject({reason:'invalid_input'});
      await expect(runBootstrapFromSkill({...v.opts,taskCount:51})).rejects.toMatchObject({reason:'invalid_input'});
      await expect(runBootstrapFromSkill({...v.opts,skillName:'../escape'})).rejects.toMatchObject({reason:'invalid_input'});
      writeFileSync(v.skill,'x'.repeat(1048577));await expect(runBootstrapFromSkill(v.opts)).rejects.toMatchObject({reason:'invalid_input'});
      rmSync(v.skill);symlinkSync(v.routing,v.skill);await expect(runBootstrapFromSkill(v.opts)).rejects.toMatchObject({reason:'invalid_input'});
    });expect(f.calls().length).toBe(before);
  }));
  test('no selected routing intents is an input outcome, never a model parse failure',async()=>fixture(async v=>{
    writeFileSync(v.routing,JSON.stringify({intent:'Other',expected_skill:'other'}));const before=f.calls().length;
    await f.run(async()=>{await expect(runBootstrap(v.opts)).rejects.toMatchObject({code:'bootstrap_empty'});});expect(f.calls().length).toBe(before);
  }));
  test('source or output drift during inference refuses publication and preserves concurrent work',async()=>{
    for(const target of ['skill','output'] as const)await fixture(async v=>{
      f.reply({autoBootstrap:true});const before=f.calls().length;let changed=false;
      await f.run(async()=>{await expect(runBootstrapFromSkill(v.opts)).rejects.toMatchObject({reason:'invalid_input'});},
        {checkAuthority:async()=>{if(!changed&&f.calls().length>before){changed=true;writeFileSync(v[target],'Concurrent user change');}}});
      expect(readFileSync(v[target],'utf8')).toBe('Concurrent user change');if(target==='skill')expect(existsSync(v.output)).toBe(false);
      expect(readdirSync(v.directory).some(s=>s.endsWith('.tmp'))).toBe(false);
    });
  });
  test('guarded bootstrap requires a host allowance independently of USD and reports unknown subscription cost',async()=>fixture(async v=>{
    const options={...v.opts,engine:f.engine(),mode:'skill' as const,optimizer:{model:'codex-cli:gpt-test',source:'cli_flag' as const,origin:'optimizer-model flag'},dryRun:false,maxCostUsd:10,modelsStrict:false};
    await expect(runGuardedBootstrap(options)).rejects.toMatchObject({code:'subscription_required'});f.reply({autoBootstrap:true});
    await f.run(async()=>{expect(await runGuardedBootstrap(options)).toMatchObject({dry_run:false,cost_usd:null,result:{billing:{costUsd:null}}});});
  }));
  test('conflicting explicit or database pins and injected chat cannot dispatch',async()=>fixture(async v=>{
    const before=f.calls().length;await f.run(async()=>{
      await expect(runBootstrapFromSkill({...v.opts,optimizerModel:'anthropic:forbidden'})).rejects.toMatchObject({code:'private_route_conflict'});
      await expect(runBootstrapFromSkill({...v.opts,chatFn:async()=>{throw new Error('forbidden transport');}})).rejects.toMatchObject({reason:'invalid_input'});
      await f.engine().setConfig('models.tier.deep','openai:forbidden');
      try{await expect(runBootstrapFromSkill(v.opts)).rejects.toMatchObject({code:'private_route_conflict'});}finally{await f.engine().setConfig('models.tier.deep','');}
    });expect(f.calls().length).toBe(before);
  }));
  test.each([{refusal:true},{missingCompletion:true}])('unsettled attempts cannot become reviewed drafts or be immediately retried',async value=>fixture(async v=>{
    f.reply(value);await f.run(async()=>{await expect(runBootstrapFromSkill(v.opts)).rejects.toMatchObject({reason:value.refusal?'refusal':'missing_completion'});
      expect(existsSync(v.output)).toBe(false);await expect(runBootstrapFromSkill(v.opts)).rejects.toMatchObject({code:'subscription_lane_busy'});
    });
  }));
  test('active cancellation stops native generation before any draft write',async()=>fixture(async v=>{
    f.reply({wait:true});const abort=new AbortController(),before=f.calls().length;
    await f.run(async id=>{const pending=runBootstrapFromSkill({...v.opts,abortSignal:abort.signal}).then(()=>null,error=>error);
      try{for(let i=0;i<200&&f.calls().length===before;i++)await Bun.sleep(10);expect(f.calls().length-before).toBe(1);}finally{abort.abort();}
      expect(await pending).toMatchObject({reason:'aborted'});expect(existsSync(v.output)).toBe(false);
      expect(await f.engine().executeRaw("SELECT attempt_id FROM codex_subscription_attempts WHERE run_id=$1 AND state='active'",[id])).toHaveLength(0);
    });
  }));
  test('a lost acknowledgement after the draft write recovers exact content from the retained proposal',async()=>fixture(async v=>{
    const engine=f.engine(),original=engine.transaction;let injected=false;f.reply({autoBootstrap:true});
    engine.transaction=(async function(this:BrainEngine,fn:Parameters<BrainEngine['transaction']>[0]){
      const result=await original.call(this,fn);
      if(this===engine&&!injected&&existsSync(v.output)){injected=true;throw new Error('synthetic lost draft acknowledgement');}
      return result;
    }) as typeof engine.transaction;
    try{await f.run(async()=>{
      await expect(runBootstrapFromSkill(v.opts)).rejects.toThrow('synthetic lost draft acknowledgement');
      const output=readFileSync(v.output,'utf8'),before=f.calls().length;
      expect(await runBootstrapFromSkill({...v.opts,force:true})).toMatchObject({cacheHit:true,rowsGenerated:2});
      expect(f.calls().length).toBe(before);expect(readFileSync(v.output,'utf8')).toBe(output);
    });}finally{engine.transaction=original;}
  }));
  test('exhaustion preserves the existing draft and never falls back to paid inference',async()=>fixture(async v=>{
    f.reply({autoBootstrap:true});await f.run(async()=>{
      await runBootstrapFromSkill(v.opts);const output=readFileSync(v.output,'utf8'),before=f.calls().length;
      await expect(runBootstrapFromSkill({...v.opts,force:true,taskCount:3})).rejects.toMatchObject({code:'subscription_exhausted'});
      expect(readFileSync(v.output,'utf8')).toBe(output);expect(f.calls().length).toBe(before);
    },{},1);
  }));
});}
