import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';

const repo=resolve(import.meta.dir,'../..'),root=mkdtempSync(join(tmpdir(),'codex-eval-cli-'));
const db=join(root,'brain'),bin=join(root,'fake-codex.mjs'),preload=join(root,'preload.ts'),capture=join(root,'calls'),tripwire=join(root,'forbidden');
const dataset=join(root,'input.jsonl'),output=join(root,'output.jsonl'),config=join(root,'.gbrain','config.json');
const requestId=randomUUID(),deadline=new Date(Date.now()+600000).toISOString();
const flags=['--codex-request-id',requestId,'--codex-max-attempts','2','--codex-max-turns','2','--codex-deadline',deadline];
const args=['eval','longmemeval',dataset,'--keyword-only','--no-trajectory','--no-embed-cache','--output',output];
beforeAll(async()=>{
  mkdirSync(join(root,'.gbrain'));writeFileSync(capture,'');
  const body='Aster moved to the coast.';
  writeFileSync(dataset,JSON.stringify({question_id:'cli-fixture',question_type:'single-session-user',question:'Where did Aster move?',answer:'The coast',
    answer_session_ids:['s1'],haystack_dates:['2026-06-02'],haystack_sessions:[{session_id:'s1',turns:[{role:'user',content:body}]}]}));
  writeFileSync(config,JSON.stringify({engine:'pglite',database_path:db,embedding_disabled:true,embedding_dimensions:1536,
    private_codex:{mode:'strict',model:'codex-cli:gpt-test',bin}}));
  writeFileSync(bin,`#!${Bun.which('node')}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1],schema=JSON.parse(readFileSync(arg('--output-schema'),'utf8'));
const prompt=JSON.parse(readFileSync(0,'utf8')),sid=prompt.messages[0].content.match(/<chat_session id="([^"]+)"/)[1];
appendFileSync(${JSON.stringify(capture)},JSON.stringify({args,envKeys:Object.keys(process.env)})+'\\n');
const text=JSON.stringify({evidence_hash:schema.properties.evidence_hash.enum[0],answer:${JSON.stringify(body)},status:'answered',citations:[{session_id:sid,quote:${JSON.stringify(body)}}]});
writeFileSync(arg('--output-last-message'),text);
for(const event of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},
{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed',usage:{input_tokens:21,cached_input_tokens:0,output_tokens:9}}])console.log(JSON.stringify(event));
`,{mode:0o700});
  writeFileSync(preload,`
import {readFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {__registerCodexFixtureForTests} from ${JSON.stringify(join(repo,'src/core/ai/providers/codex-qualification.ts'))};
import {PGLiteEngine} from ${JSON.stringify(join(repo,'src/core/pglite-engine.ts'))};
__registerCodexFixtureForTests(${JSON.stringify(bin)},createHash('sha256').update(readFileSync(${JSON.stringify(bin)})).digest('hex'));
const deny=kind=>{appendFileSync(${JSON.stringify(tripwire)},kind+'\\n');throw new Error('fixture forbids '+kind);};
globalThis.fetch=()=>deny('network');
for(const key of ['spawn','spawnSync']){const original=Bun[key];Bun[key]=(...args)=>{
const argv=Array.isArray(args[0])?args[0]:args[0]?.cmd;
if(argv?.[0]!==${JSON.stringify(bin)})return deny('subprocess');return original(...args);};}
const owners=new WeakSet(),connect=PGLiteEngine.prototype.connect,init=PGLiteEngine.prototype.initSchema;
PGLiteEngine.prototype.connect=async function(c){if(c.database_path===${JSON.stringify(db)})owners.add(this);return connect.call(this,c);};
PGLiteEngine.prototype.initSchema=async function(...args){if(owners.has(this))return deny('owner migration');return init.apply(this,args);};
`);
  configureGateway({env:{},embedding_dimensions:1536});
  const engine=new PGLiteEngine();await engine.connect({database_path:db});await engine.initSchema();
  await engine.putPage('notes/owner-sentinel',{type:'note',title:'Owner sentinel',compiled_truth:'Preserve this synthetic owner page.'});await engine.disconnect();
},60000);
afterAll(()=>{resetGateway();rmSync(root,{recursive:true,force:true});});
function run(extra:string[]){return spawnSync(process.execPath,['--preload',preload,join(repo,'src/cli.ts'),...extra],{
  cwd:root,encoding:'utf8',timeout:60000,env:{PATH:process.env.PATH,HOME:root,GBRAIN_HOME:root,CODEX_HOME:root,LANG:'C.UTF-8',TMPDIR:tmpdir(),
    GBRAIN_MODEL_DISCOVERY:'0',GBRAIN_CI_DISABLE_TEST_ENV_FILE:'1',GBRAIN_SKIP_STARTUP_HOOKS:'1',GBRAIN_QUIET:'1',GBRAIN_NO_RETRY_CONNECT:'1'},
});}
test('real dispatcher parses allowances, uses the selected owner without migrations, and recovers in another process',async()=>{
  for(let i=0;i<2;i++){const child=run([...args,...flags]);expect(child.status,child.stderr).toBe(0);}
  const calls=readFileSync(capture,'utf8').trim().split('\n').map(s=>JSON.parse(s));expect(calls).toHaveLength(1);
  expect(calls[0].args).toContain('--output-schema');expect(calls[0].envKeys.some((k:string)=>/KEY|TOKEN|DATABASE_URL/.test(k))).toBe(false);
  expect(existsSync(tripwire)).toBe(false);
  const engine=new PGLiteEngine();await engine.connect({database_path:db});
  try{expect(await engine.executeRaw('SELECT slug FROM pages')).toEqual([{slug:'notes/owner-sentinel'}]);
    expect(await engine.executeRaw('SELECT state,owner_token FROM codex_eval_runs')).toEqual([{state:'complete',owner_token:null}]);
    expect(await engine.executeRaw('SELECT attempts,accepted_turns,account_lane FROM codex_subscription_runs')).toEqual([{attempts:1,accepted_turns:1,account_lane:'codex-subscription'}]);
  }finally{await engine.disconnect();}
},120000);
