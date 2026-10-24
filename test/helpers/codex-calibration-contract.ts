import { withCodexRoleFixture } from './codex-role-fixture.ts';
import { beforeAll, beforeEach, afterAll, test, expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription, type CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { runPhaseCalibrationProfile, type CalibrationProfileOpts } from '../../src/core/cycle/calibration-profile.ts';
import { runCalibration } from '../../src/commands/calibration.ts';
import { regenerateCalibration } from '../../src/commands/calibration-subscription.ts';

export function codexCalibrationContract(createEngine: () => Promise<{ engine: BrainEngine; cleanup?: () => Promise<void> }>) {
  const root = mkdtempSync(join(tmpdir(), 'codex-calibration-')), bin = join(root, 'fixture.mjs');
  const capture = join(root, 'calls.jsonl'), control = join(root, 'response.json');
  const keys = ['HOME', 'GBRAIN_HOME', 'CODEX_HOME'] as const;
  const saved = keys.map(k => [k, process.env[k]] as const), originalFetch = globalThis.fetch;
  let cleanup: (() => Promise<void>) | undefined, engine: BrainEngine, unregister: () => void, seq = 0;
  const sourceId = 'calibration-fixture', holder = 'self';
  const patterns = [
    { fact_id: 'metric-1', statement: 'Overall, 1 of 5 resolved calls were correct for you.', bias_tag: null },
    { fact_id: 'metric-2', statement: 'Overall, 4 of 5 resolved calls were incorrect for you.', bias_tag: null },
  ];
  const bundle = { patterns }, pass = { verdict: 'conversational', reason: 'Clear and grounded.' };
  const reply = (value: unknown) => writeFileSync(control, JSON.stringify(value));
  const calls = () => readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const ctx = () => ({ engine, config: { engine: 'pglite', embedding_disabled: true }, sourceId, remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as OperationContext);
  const phase = (opts: CalibrationProfileOpts = {}, overrides: Partial<OperationContext> = {}) => runPhaseCalibrationProfile({ ...ctx(), ...overrides }, {
    patternsGenerator: async () => { throw new Error('legacy generation bypass'); }, biasTagsGenerator: async () => { throw new Error('legacy tags bypass'); },
    voiceGateJudge: async () => { throw new Error('legacy judge bypass'); }, ...opts,
  });
  const run = async <T>(fn: (id: string) => Promise<T>, hooks: Partial<CodexSubscriptionContext> = {}, maxAttempts = 8) => {
    const runId = `calibration-${seq++}`;
    await createSubscriptionRun(engine, { runId, accountLane: runId, maxAttempts, maxTurns: maxAttempts, deadline: new Date(Date.now() + 600000) });
    return withCodexSubscription({ engine, runId, ...hooks }, () => fn(runId));
  };
  const rows = () => engine.executeRaw<Record<string, any>>('SELECT * FROM calibration_profiles ORDER BY id');
  async function seed(source: string, who: string, count: number, correct: number, slug: string) {
    const page = await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Synthetic calibration source.' }, { sourceId: source });
    for (let index=0;index<count;index++) await engine.executeRaw(`INSERT INTO takes(page_id,row_num,claim,kind,holder,weight,resolved_at,resolved_quality,resolved_outcome)
      VALUES($1,$2,$3,'bet',$4,0.9,now(),$5,$6)`, [page.id,index+1,`Synthetic forecast ${index}`,who,index<correct?'correct':'incorrect',index<correct]);
  }
  beforeAll(async () => {
    for (const key of keys) process.env[key] = root;
    globalThis.fetch = (() => { throw new Error('forbidden network'); }) as unknown as typeof fetch;
    mkdirSync(join(root, '.gbrain'));
    writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ private_codex: { mode: 'strict', model: 'codex-cli:gpt-test', bin } }));
    writeFileSync(capture, '');
    const script = `#!${Bun.which('node')}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1];
const schema=JSON.parse(readFileSync(arg('--output-schema'),'utf8')),prompt=readFileSync(0,'utf8');
appendFileSync(${JSON.stringify(capture)},JSON.stringify({args,schema,prompt})+'\\n');
const responses=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8')),value=responses.shift();
writeFileSync(${JSON.stringify(control)},JSON.stringify(responses));
const bound=schema.properties.snapshot_hash?{snapshot_hash:schema.properties.snapshot_hash.enum[0]}:
{mode:schema.properties.mode.enum[0],candidate_hash:schema.properties.candidate_hash.enum[0]};
const text=value.raw??JSON.stringify({...bound,...value});writeFileSync(arg('--output-last-message'),text);
for(const event of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},
{type:'item.completed',item:{type:value.refusal?'refusal':'agent_message',text}},
...(value.missingCompletion?[]:[{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:4}}])])console.log(JSON.stringify(event));
`;
    writeFileSync(bin, script, { mode: 0o700 }); unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(script).digest('hex'));
    ({ engine, cleanup } = await createEngine()); await engine.initSchema(); configureGateway({ env: {} });
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)', [sourceId,'Synthetic calibration source']);
  });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM calibration_profiles'); await engine.executeRaw('DELETE FROM takes');
    await engine.executeRaw('DELETE FROM pages'); await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=NULL');
    await engine.executeRaw('UPDATE sources SET archived=false');
    for (const key of ['models.chat','models.tier.utility',`schema_pack.source.${sourceId}`]) await engine.setConfig(key,'');
    await seed(sourceId,holder,5,1,'notes/selected'); await seed('default',holder,12,12,'notes/other-source');
    await seed(sourceId,'other-holder',8,8,'notes/other-holder'); reply([bundle,pass]);
  });
  afterAll(async () => {
    await engine?.disconnect(); await cleanup?.(); unregister?.(); resetGateway(); globalThis.fetch = originalFetch;
    for (const [key,value] of saved) if (value === undefined) delete process.env[key]; else process.env[key]=value;
    rmSync(root,{recursive:true,force:true});
  });
  withCodexRoleFixture(root, ['take-calibration', 'calibration-voice-judge'], () => {
  test('native profile is source/holder scoped, retains metrics and reuses its receipt', async () => {
    await run(async id => {
      expect(await phase({ gradeCompletion: 0.6 })).toMatchObject({ status: 'ok', details: { profiles_completed: 1, cost_usd: null, billing: 'subscription' } });
      const [profile] = await rows();
      expect(profile).toMatchObject({ source_id: sourceId, holder, total_resolved: 5, published: false, voice_gate_passed: true,
        model_id: 'codex-cli:gpt-test', cost_usd: null, codex_evidence: { subscription_run_id: id, scorecard: { correct: 1, incorrect: 4 } } });
      expect(Number(profile!.grade_completion)).toBeCloseTo(0.6);
      expect(profile!.codex_evidence.snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
      const before = calls().length;
      expect(await phase({ gradeCompletion: 0.6 })).toMatchObject({ status: 'ok', details: { profile_written: false, profiles: [{ cache_hit: true }] } });
      expect(calls().length).toBe(before); expect(await rows()).toHaveLength(1);
      expect(await phase({ gradeCompletion: 0.8 })).toMatchObject({ status: 'fail', details: { error_code: 'idempotency_conflict' } });
    });
    const wire = calls().at(-2)!; expect(wire.args).toContain('--output-schema');
    expect(wire.schema.properties.patterns.items.required).toContain('fact_id');
    expect(wire.prompt).toContain('1 of 5 resolved calls were correct'); expect(wire.prompt).not.toContain('12 of 12');
  });
  test.each([
    { patterns: [patterns[0],patterns[0]] }, { patterns: [{ ...patterns[0], statement: 'Overall, 99 of 100 calls were right.' },patterns[1]] },
    { patterns: [{ ...patterns[0], bias_tag: 'early-geography' },patterns[1]] }, { patterns: [] }, { raw: 'malformed' },
    { patterns: [{ ...patterns[0], fact_id: 'unknown' },patterns[1]] }, { ...bundle, operation_id: String('forged') },
  ])('invalid metric proposals never produce a profile or a fallback', async value => {
    reply([value]);
    await run(async () => { expect(await phase()).toMatchObject({ status: 'fail', details: { error_code: 'invalid_output' } }); });
    expect(await rows()).toHaveLength(0);
  });
  test('voice repair is bounded and two style rejections never publish a template', async () => {
    reply([bundle,{verdict:'academic',reason:'Shorten it.'},bundle,pass]);
    await run(async id => {
      expect(await phase()).toMatchObject({ status:'ok' });
      const [budget] = await engine.executeRaw<{ attempts:number; repairs:number }>('SELECT attempts,repairs FROM codex_subscription_runs WHERE run_id=$1',[id]);
      expect(Number(budget!.attempts)).toBe(4); expect(Number(budget!.repairs)).toBe(1);
    });
    await engine.executeRaw('DELETE FROM calibration_profiles'); reply([bundle,{verdict:'academic',reason:'Clinical.'},bundle,{verdict:'academic',reason:'Still clinical.'}]);
    await run(async () => { expect(await phase()).toMatchObject({ status:'fail',details:{error_code:'voice_gate_rejected'} }); });
    expect(await rows()).toHaveLength(0);
  });
  test('changed evidence cannot publish a stale profile', async () => {
    const before=calls().length; let changed=false;
    await run(async () => { expect(await phase()).toMatchObject({ status:'fail',details:{error_code:'revision_conflict'} }); }, { checkAuthority: async () => {
      if (!changed && calls().length>before) { changed=true; await engine.executeRaw("UPDATE takes SET weight=0.2 WHERE holder='self' AND page_id IN (SELECT id FROM pages WHERE source_id=$1)",[sourceId]); }
    } });
    expect(changed).toBe(true); expect(await rows()).toHaveLength(0);
  });
  test('revocation after generation prevents the judge and persistence', async () => {
    const before=calls().length; let changed=false;
    await run(async () => { expect(await phase()).toMatchObject({status:'fail',details:{error_code:'permission_denied'}}); }, { checkAuthority: async () => {
      if (!changed && calls().length>before) { changed=true; await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now()'); }
    } });
    expect(calls().length-before).toBe(1); expect(await rows()).toHaveLength(0);
  });
  test('cold profiles skip without inference or success rows', async () => {
    await engine.executeRaw("DELETE FROM takes WHERE holder='self' AND row_num>2 AND page_id IN (SELECT id FROM pages WHERE source_id=$1)",[sourceId]);
    const before=calls().length;
    await run(async () => { expect(await phase()).toMatchObject({status:'ok',details:{profiles:[{skipped:'insufficient_data',total_resolved:2}]}}); });
    expect(calls().length).toBe(before); expect(await rows()).toHaveLength(0);
  });
  test('USD-only, remote, conflicting pins and dry-run do not dispatch', async () => {
    const before=calls().length;
    expect(await phase({budgetUsd:100})).toMatchObject({status:'fail',details:{error_code:'subscription_required'}});
    expect(await phase({dryRun:true})).toMatchObject({status:'skipped'});
    await run(async () => {
      expect(await phase({}, {remote:true})).toMatchObject({status:'fail',details:{error_code:'permission_denied'}});
      expect(await phase({model:'anthropic:claude-test'})).toMatchObject({status:'fail',details:{error_code:'private_route_conflict'}});
    });
    expect(calls().length).toBe(before); expect(await rows()).toHaveLength(0);
  });
  test('host-computed confidence evidence permits only its matching bias tag', async () => {
    reply([{ patterns: [patterns[0], { fact_id:'metric-5', statement:'Overall, you had 90% average confidence versus 20% correct.', bias_tag:'over-confident-overall' }] },pass]);
    await run(async () => { expect(await phase()).toMatchObject({status:'ok'}); });
    expect((await rows())[0]!.active_bias_tags).toEqual(['over-confident-overall']);
  });
  test('source-selected domain aggregation excludes deleted-page takes', async () => {
    await engine.setConfig(`schema_pack.source.${sourceId}`,'gbrain-investor');
    await engine.executeRaw("UPDATE pages SET type='deal' WHERE source_id=$1 AND slug='notes/selected'",[sourceId]);
    await seed(sourceId,holder,5,5,'notes/deleted');
    await engine.executeRaw("UPDATE pages SET type='deal',deleted_at=now() WHERE source_id=$1 AND slug='notes/deleted'",[sourceId]);
    await engine.executeRaw(`INSERT INTO take_domain_assignments(take_id,domain,pack)
      SELECT t.id,'deal_success','gbrain-investor' FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND t.holder=$2`,[sourceId,holder]);
    await run(async () => { expect(await phase()).toMatchObject({status:'ok'}); });
    const [profile]=await rows(); expect(profile!.total_resolved).toBe(5);
    expect(profile!.domain_scorecards.deal_success.n).toBe(5);
    expect(Number(profile!.domain_scorecards.deal_success.accuracy)).toBeCloseTo(0.2);
    expect(profile!.codex_evidence.pack_identity).toStartWith('gbrain-investor@');
  });
  test('a failed profile insert is atomic and a separately admitted retry can succeed', async () => {
    await engine.executeRaw("CREATE FUNCTION fail_calibration_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic insertion failure'; END $$");
    await engine.executeRaw('CREATE TRIGGER fail_calibration_insert BEFORE INSERT ON calibration_profiles FOR EACH ROW EXECUTE FUNCTION fail_calibration_insert()');
    try { await run(async () => { expect(await phase()).toMatchObject({status:'fail',details:{error_code:'storage_error'}}); }); }
    finally { await engine.executeRaw('DROP TRIGGER fail_calibration_insert ON calibration_profiles'); }
    expect(await rows()).toHaveLength(0); reply([bundle,pass]);
    await run(async () => { expect(await phase()).toMatchObject({status:'ok'}); }); expect(await rows()).toHaveLength(1);
  });
  test('source replacement after generation refuses further inference and storage', async () => {
    const before=calls().length; let changed=false;
    await run(async () => { expect(await phase()).toMatchObject({status:'fail',details:{error_code:'source_changed'}}); }, {checkAuthority: async () => {
      if (!changed && calls().length>before) { changed=true; await engine.executeRaw('DELETE FROM sources WHERE id=$1',[sourceId]); await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)',[sourceId,'Replacement fixture']); }
    }});
    expect(changed).toBe(true); expect(calls().length-before).toBe(1); expect(await rows()).toHaveLength(0);
  });
  test.each([{refusal:true},{missingCompletion:true},{raw:'malformed judge'}])('a failed voice judgment never writes a profile', async value => {
    reply([bundle,value]);
    await run(async () => { expect((await phase()).status).toBe('fail'); }); expect(await rows()).toHaveLength(0);
  });
  test('quota exhaustion after generation preserves the failed outcome without a profile', async () => {
    const before=calls().length;
    await run(async () => { expect(await phase()).toMatchObject({status:'fail',details:{error_code:'subscription_exhausted'}}); },{},1);
    expect(calls().length-before).toBe(1); expect(await rows()).toHaveLength(0);
  });
  test('completed earlier source profiles survive a later source failure', async () => {
    const defaultBundle={patterns:[
      {fact_id:'metric-1',statement:'Overall, 12 of 12 resolved calls were correct for you.',bias_tag:null},
      {fact_id:'metric-2',statement:'Overall, 0 of 12 resolved calls were incorrect for you.',bias_tag:null},
    ]};
    // IDs are processed in lexical order: selected source first, default second.
    reply([bundle,pass,{...defaultBundle,patterns:[]}]);
    await run(async () => { expect(await phase({}, {sourceId:undefined})).toMatchObject({status:'warn',details:{profiles_completed:1,profile_written:true}}); });
    expect(await rows()).toHaveLength(1); expect((await rows())[0]!.source_id).toBe(sourceId);
  });
  test('lost acknowledgement after commit reconciles the saved profile without inference', async () => {
    let lost=false;
    const uncertain=new Proxy(engine,{get(target,key){
      if(key==='transaction') return async (fn:(tx:BrainEngine)=>Promise<unknown>)=>{
        let inserted=false;
        const result=await target.transaction(tx=>fn(new Proxy(tx,{get(inner,property){
          if(property==='executeRaw') return async (sql:string,params?:unknown[],options?:{signal?:AbortSignal})=>{
            const rows=await inner.executeRaw(sql,params,options);
            if(sql.startsWith('INSERT INTO calibration_profiles')) inserted=true;
            return rows;
          };
          const value=Reflect.get(inner,property,inner);return typeof value==='function'?value.bind(inner):value;
        }})));
        if(inserted&&!lost){lost=true;throw new Error('synthetic acknowledgement loss');}return result;
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await run(async()=>{
      expect(await phase({}, {engine:uncertain})).toMatchObject({status:'fail',details:{error_code:'storage_error'}});
      expect(lost).toBe(true); expect(await rows()).toHaveLength(1);
      const before=calls().length;
      expect(await phase()).toMatchObject({status:'ok',details:{profiles:[{cache_hit:true}]}});
      expect(calls().length).toBe(before);expect(await rows()).toHaveLength(1);
    });
  });
  test('pack drift and stale host ownership refuse profile publication', async () => {
    const before = calls().length;
    let changed = false;
    await run(async () => { expect(await phase()).toMatchObject({status:'fail',details:{error_code:'revision_conflict'}}); }, {
      checkAuthority: async () => { if (!changed && calls().length > before) { changed=true; await engine.setConfig(`schema_pack.source.${sourceId}`,'gbrain-investor'); } },
    });
    expect(await rows()).toHaveLength(0);
    await engine.setConfig(`schema_pack.source.${sourceId}`,''); reply([bundle,pass]);
    const fenceStart=calls().length;
    await run(async () => { expect((await phase()).status).toBe('fail'); }, {
      checkAuthorityInTransaction: async () => { if (calls().length >= fenceStart+2) throw new Error('synthetic stale host fence'); },
    });
    expect(await rows()).toHaveLength(0);
  });
  test('simultaneous CLI reuse with changed inputs creates one bound allowance', async () => {
    const requestId=randomUUID(), args=['--codex-max-attempts','4','--codex-max-turns','4',
      '--codex-deadline',new Date(Date.now()+600000).toISOString(),'--codex-request-id',requestId];
    const results=await Promise.allSettled([regenerateCalibration(ctx(),args,holder),regenerateCalibration(ctx(),args,'other-holder')]);
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
    expect(rejected.reason.code).toBe('subscription_identity_conflict');
    const allowances=await engine.executeRaw('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1',[`codex-calibration:${requestId}:%`]);
    expect(allowances).toHaveLength(1);
  });
  test('the real CLI requires explicit allowances and reuses its bound request', async () => {
    const deadline=new Date(Date.now()+600000).toISOString(), requestId=randomUUID();
    const args=['--regenerate','--json','--source',sourceId,'--codex-max-attempts','4','--codex-max-turns','4',
      '--codex-deadline',deadline,'--codex-request-id',requestId];
    const stdout=process.stdout.write,stderr=process.stderr.write,exit=process.exit,output:string[]=[],errors:string[]=[];
    process.exit=((code?:number)=>{throw new Error(`synthetic CLI exit ${code}`);}) as typeof process.exit;
    process.stdout.write=((chunk:unknown)=>{output.push(String(chunk));return true;}) as typeof process.stdout.write;
    process.stderr.write=((chunk:unknown)=>{errors.push(String(chunk));return true;}) as typeof process.stderr.write;
    try {
      await expect(regenerateCalibration(ctx(),['--regenerate'],holder)).rejects.toThrow('all three Codex allowance flags');
      await runCalibration(engine,args,ctx().config);
      expect(JSON.parse(output.join(''))).toMatchObject({source_id:sourceId,total_resolved:5});
      expect(errors.join('')).toContain(requestId); expect(errors.join('')).toContain('"monetary_cost_usd":null');
      const before=calls().length; output.length=0;
      await runCalibration(engine,args,ctx().config); expect(calls().length).toBe(before);
      await expect(regenerateCalibration(ctx(),args,'other-holder')).rejects.toMatchObject({code:'subscription_identity_conflict'});
      output.length=0; await runCalibration(engine,['--json','--source',sourceId],ctx().config);
      expect(calls().length).toBe(before);
    } finally { process.stdout.write=stdout;process.stderr.write=stderr;process.exit=exit; }
    const [admission]=await engine.executeRaw<{account_lane:string}>("SELECT account_lane FROM codex_subscription_runs WHERE run_id LIKE $1",[`codex-calibration:${requestId}:%`]);
    expect(admission!.account_lane).toBe('codex-subscription'); expect(await rows()).toHaveLength(1);
  });
  });
}
