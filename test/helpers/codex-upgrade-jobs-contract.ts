/** Actual storage/queue/CLI upgrade contract. Removing durable parking or receipt
 * coupling must fail. Existing subscription tests never migrate legacy rows. */
import { beforeAll, beforeEach, afterAll, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { previewJobUpgrade } from '../../src/core/minions/codex-upgrade-snapshot.ts';
import { inventoryQueuedJobs, missingJobUpgradeRelations } from '../../src/core/minions/codex-upgrade-inventory.ts';
import { parkUpgradeJobs, restoreParkedJobs } from '../../src/core/minions/codex-upgrade-park.ts';
import { previewUpgradeSubmission, resubmitUpgradeJob, type UpgradeSubmission } from '../../src/core/minions/codex-upgrade-resubmit.ts';
import { run } from '../../src/cli/commands/private-codex.ts';
import type { CliDispatchContext } from '../../src/cli/command-table.ts';
import * as output from '../../src/core/cli-force-exit.ts';

export function codexUpgradeJobsContract(factory: () => Promise<{ engine: BrainEngine; cleanup?: () => Promise<void> }>) {
  const root = mkdtempSync(join(tmpdir(),'codex-job-upgrade-')), priorHome = process.env.GBRAIN_HOME, fetch = globalThis.fetch;
  let engine: BrainEngine, queue: MinionQueue, cleanup: (() => Promise<void>) | undefined;
  const config = (strict = true) => writeFileSync(join(root,'.gbrain','config.json'), JSON.stringify(strict ? { private_codex: { mode:'strict', model:'codex-cli:fixture', bin:'/nonexistent/fake-codex-never-invoked' } } : {}));
  const spec = (id: number): UpgradeSubmission => ({ version:1,job_id:id, data: { action_protocol:'codex-host-read-v1',prompt:'Read the synthetic note.',source_id:'default',allowed_tools:['get_page'],allowed_slug_prefixes:['notes/*'],max_turns:2,no_self_fix:true }, max_attempts:3,max_turns:2,deadline:new Date(Date.now()+600000).toISOString() });
  async function old(extra: Record<string,unknown> = {}) {
    const [r] = await engine.executeRaw<{id:number}>("INSERT INTO minion_jobs(name,status,data,submission_authority) VALUES('subagent','waiting',$1::text::jsonb,$2::text::jsonb) RETURNING id", [JSON.stringify({prompt:'SYNTHETIC_PRIVATE_PROMPT',source_id:'default',model:'anthropic:fixture',...extra}),JSON.stringify({version:1,kind:'application'})]);
    return r!.id;
  }
  const park = async (id: number) => { const p=await previewJobUpgrade(engine,[id]); return parkUpgradeJobs(engine,[id],p.plan_hash); };
  beforeAll(async () => {
    process.env.GBRAIN_HOME=root; mkdirSync(join(root,'.gbrain')); config();
    globalThis.fetch=(()=>{throw new Error('forbidden network');}) as unknown as typeof fetch;
    ({engine,cleanup}=await factory()); await engine.initSchema(); queue=new MinionQueue(engine);
  });
  beforeEach(async () => {
    config(); await engine.executeRaw("DELETE FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-supervisor:%'"); await engine.executeRaw('DELETE FROM codex_parked_jobs'); await engine.executeRaw('DELETE FROM codex_upgrade_receipts');
    await engine.executeRaw('DELETE FROM codex_subscription_attempts'); await engine.executeRaw('DELETE FROM codex_subscription_runs'); await engine.executeRaw('DELETE FROM minion_jobs');
  });
  afterAll(async () => {
    await engine?.disconnect(); await cleanup?.(); globalThis.fetch=fetch;
    if (priorHome===undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME=priorHome;
    rmSync(root,{recursive:true,force:true});
  });
  test('global queue inventory sees every live job, exposes no payload, and refuses partial coverage', async () => {
    const waiting=await old(), active=await old(), parked=await old();
    await engine.executeRaw("UPDATE minion_jobs SET status='active',claim_generation=claim_generation+1 WHERE id=$1",[active]);
    await park(parked);
    const inventory=await inventoryQueuedJobs(engine);
    expect(inventory.jobs.map(j=>j.id)).toEqual([waiting,active,parked]);
    expect(inventory.jobs.map(j=>j.disposition)).toEqual(['park','drain','parked']);
    expect(inventory.jobs.map(j=>j.model_pin_keys)).toEqual([['model'],['model'],['model']]);
    expect(inventory).toMatchObject({ live_count:3, queue_snapshot_complete:true, workers:'uninspected', cutover_ready:false });
    expect(JSON.stringify(inventory)).not.toContain('SYNTHETIC_PRIVATE_PROMPT');
    expect(JSON.stringify(inventory)).not.toContain('anthropic:fixture');
    await expect(inventoryQueuedJobs(engine,2)).rejects.toThrow('inventory_too_large');
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(3);
  });
  test('inventory CLI uses probe-only connection and does not require preselected IDs', async () => {
    const id=await old(), written:string[]=[], connections:unknown[]=[];
    const print=spyOn(output,'writeStdoutFinal').mockImplementation(async text=>{written.push(text);}),disconnect=spyOn(engine,'disconnect').mockResolvedValue();
    const ctx={connectEngine:async (opts:unknown)=>{connections.push(opts);return engine;}} as unknown as CliDispatchContext;
    try {
      await run(['jobs','inventory','--json'],ctx);
      expect(JSON.parse(written.join('')).jobs[0].id).toBe(id);
      expect(connections).toEqual([{probeOnly:true}]);
      expect(await engine.executeRaw('SELECT id FROM codex_upgrade_receipts')).toHaveLength(0);
    } finally {print.mockRestore();disconnect.mockRestore();}
  });
  test('preflight CLI reports queue blockers through a probe-only connection and stays nonready', async () => {
    const id=await old(), written:string[]=[], connections:unknown[]=[];
    expect(await missingJobUpgradeRelations(engine)).toEqual([]);
    const print=spyOn(output,'writeStdoutFinal').mockImplementation(async value=>{written.push(value);}),disconnect=spyOn(engine,'disconnect').mockResolvedValue();
    const ctx={connectEngine:async (opts:unknown)=>{connections.push(opts);return engine;}} as unknown as CliDispatchContext;
    try {
      await run(['jobs','preflight','--json'],ctx);
      const report=JSON.parse(written.join(''));
      expect(report).toMatchObject({kind:'cutover_preflight',status:'blocked',cutover_ready:false,snapshots_atomic:false});
      expect(report.blockers).toContainEqual({code:'pending_jobs_require_disposition',count:1,ids_sample:[id]});
      expect(report.external_requirements).toContain('all_worker_hosts_and_pid_namespaces_quiesced');
      expect(connections).toEqual([{probeOnly:true}]);
      expect(output.currentExitCode()).toBe(1);
      expect(await engine.executeRaw('SELECT id FROM codex_upgrade_receipts')).toHaveLength(0);
      expect(written.join('')).not.toContain('SYNTHETIC_PRIVATE_PROMPT');
    } finally {print.mockRestore();disconnect.mockRestore();output._resetCliExitVerdictForTests();process.exitCode=0;}
  });
  test('inventory crosses its 128-row page boundary without omitting live jobs', async () => {
    const ids:number[]=[];
    for (let i=0;i<130;i++) ids.push(await old());
    const terminal=await old();
    await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1",[terminal]);
    const inventory=await inventoryQueuedJobs(engine);
    expect(inventory.live_count).toBe(130);
    expect(inventory.jobs.map(j=>j.id)).toEqual(ids);
    expect(inventory.jobs.some(j=>j.id===terminal)).toBe(false);
    await expect(inventoryQueuedJobs(engine,129)).rejects.toThrow('inventory_too_large');
  });
  test('inventory hides arbitrary job and queue names even when their characters look harmless', async () => {
    await engine.executeRaw("INSERT INTO minion_jobs(name,queue,status,data,submission_authority) VALUES('PRIVATECUSTOMERNAME','PRIVATECUSTOMERQUEUE','waiting','{}'::jsonb,'{\"version\":1,\"kind\":\"application\"}'::jsonb)");
    const inventory=await inventoryQueuedJobs(engine), serialized=JSON.stringify(inventory);
    expect(inventory.jobs[0]).toMatchObject({name:'unclassified',queue:'non_default',generation:'unclassified'});
    expect(serialized).not.toContain('PRIVATECUSTOMERNAME');
    expect(serialized).not.toContain('PRIVATECUSTOMERQUEUE');
  });
  test('inventory reports active claim leases and supervisor lock signals without tokens or host names', async () => {
    const id=await old();
    await engine.executeRaw("UPDATE minion_jobs SET queue='PRIVATE_QUEUE',status='active',claim_generation=claim_generation+1,lock_token='PRIVATE_TOKEN',lock_until=now()+interval '5 minutes' WHERE id=$1",[id]);
    await engine.executeRaw("INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,ttl_expires_at,last_refreshed_at) VALUES('gbrain-supervisor:PRIVATE_QUEUE',4321,'PRIVATE_HOST',now()+interval '5 minutes',now())");
    const inventory=await inventoryQueuedJobs(engine), serialized=JSON.stringify(inventory);
    expect(inventory.jobs[0]).toMatchObject({id,queue:'non_default',claim_lease:'unexpired'});
    expect(inventory.supervisor_locks).toMatchObject([{queue:'non_default',holder_pid:4321,ttl_signal:'unexpired'}]);
    expect(inventory).toMatchObject({queue_snapshot_complete:true,supervisor_lock_snapshot_complete:true,workers:'uninspected',cutover_ready:false});
    for (const secret of ['PRIVATE_QUEUE','PRIVATE_TOKEN','PRIVATE_HOST']) expect(serialized).not.toContain(secret);
    await engine.executeRaw("UPDATE minion_jobs SET lock_until=now()-interval '1 minute' WHERE id=$1",[id]);
    await engine.executeRaw("UPDATE gbrain_cycle_locks SET ttl_expires_at=now()-interval '1 minute' WHERE id='gbrain-supervisor:PRIVATE_QUEUE'");
    const expired=await inventoryQueuedJobs(engine);
    expect(expired.jobs[0]?.claim_lease).toBe('expired');
    expect(expired.supervisor_locks[0]?.ttl_signal).toBe('expired');
  });
  test('supervisor lock inventory refuses a partial snapshot', async () => {
    await engine.executeRaw("INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,ttl_expires_at) VALUES('gbrain-supervisor:one',1,'host-a',now()+interval '1 minute'),('gbrain-supervisor:two',2,'host-b',now()+interval '1 minute')");
    await expect(inventoryQueuedJobs(engine,10000,1)).rejects.toThrow('lock_inventory_too_large');
  });
  test('oversized supervisor metadata refuses instead of emitting a partial lock snapshot', async () => {
    await engine.executeRaw("INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,ttl_expires_at) VALUES($1,1,'host-a',now()+interval '1 minute')",['gbrain-supervisor:'+ 'Q'.repeat(5000)]);
    await expect(inventoryQueuedJobs(engine)).rejects.toThrow('lock_snapshot_too_large');
  });
  test('preview is bounded, sanitized, read-only and reports active work must drain', async () => {
    const id=await old(); await engine.executeRaw("UPDATE minion_jobs SET status='active',claim_generation=claim_generation+1 WHERE id=$1",[id]);
    const p=await previewJobUpgrade(engine,[id]); expect(p.ready).toBe(false); expect(p.jobs[0]!.disposition).toBe('drain');
    expect(JSON.stringify(p)).not.toContain('SYNTHETIC_PRIVATE_PROMPT');
    expect(await engine.executeRaw('SELECT id FROM codex_upgrade_receipts')).toHaveLength(0);
    await expect(parkUpgradeJobs(engine,[id],p.plan_hash)).rejects.toThrow('drain_or_select_dependencies');
    expect((await queue.getJob(id))?.status).toBe('active');
    await expect(previewJobUpgrade(engine,Array.from({length:129},(_,i)=>i+1))).rejects.toThrow('invalid_ids');
  });
  test('parking is durable, idempotent, and rejects old-worker claims, resume, edits and deletion', async () => {
    const id=await old(), p=await previewJobUpgrade(engine,[id]), a=await parkUpgradeJobs(engine,[id],p.plan_hash);
    expect(await parkUpgradeJobs(engine,[id],p.plan_hash)).toEqual(a);
    expect((await queue.getJob(id))?.status).toBe('paused');
    for (const sql of ["UPDATE minion_jobs SET status='active' WHERE id=$1","UPDATE minion_jobs SET status='waiting' WHERE id=$1","UPDATE minion_jobs SET data='{}'::jsonb WHERE id=$1",'DELETE FROM minion_jobs WHERE id=$1']) {
      await expect(engine.executeRaw(sql,[id])).rejects.toThrow('codex_job_parked');
    }
    expect(await queue.claim('synthetic-worker',60000,'default',['subagent'])).toBeNull();
  });
  test('changed job or connected graph refuses stale preview; a full pending graph parks together', async () => {
    const parent=await old(), p=await previewJobUpgrade(engine,[parent]);
    const child=await old(); await engine.executeRaw('UPDATE minion_jobs SET parent_job_id=$2 WHERE id=$1',[child,parent]);
    await expect(parkUpgradeJobs(engine,[parent],p.plan_hash)).rejects.toThrow('preview_changed');
    const partial=await previewJobUpgrade(engine,[parent]); expect(partial.ready).toBe(false);
    const all=await previewJobUpgrade(engine,[parent,child]); expect(all.ready).toBe(true);
    await parkUpgradeJobs(engine,[parent,child],all.plan_hash);
    await expect(engine.executeRaw("INSERT INTO minion_jobs(name,parent_job_id,submission_authority) VALUES('subagent',$1,$2::text::jsonb)",[parent,JSON.stringify({version:1,kind:'application'})])).rejects.toThrow('codex_parent_parked');
    await expect(previewUpgradeSubmission(engine,spec(parent))).rejects.toThrow('graph_requires_new_workflow');
  });
  test('parking receipt failure rolls back all status and fence effects', async () => {
    const id=await old(), p=await previewJobUpgrade(engine,[id]), nestedTransaction=engine.transaction, transaction=nestedTransaction.bind(engine);
    const fail=spyOn(engine,'transaction').mockImplementation(run=>transaction(async tx=>{
      Object.defineProperty(tx,'transaction',{value:nestedTransaction});
      const execute=tx.executeRaw.bind(tx), fault=spyOn(tx,'executeRaw').mockImplementation((sql,...args)=>{
        if(sql.startsWith('UPDATE codex_upgrade_receipts SET receipt=')) throw new Error('synthetic park crash'); return execute(sql,...args);
      }); try{return await run(tx);}finally{fault.mockRestore();}
    }));
    try { await expect(parkUpgradeJobs(engine,[id],p.plan_hash)).rejects.toThrow('synthetic park crash'); } finally {fail.mockRestore();}
    expect((await queue.getJob(id))?.status).toBe('waiting'); expect(await engine.executeRaw('SELECT * FROM codex_parked_jobs')).toHaveLength(0);
    expect(await engine.executeRaw('SELECT id FROM codex_upgrade_receipts')).toHaveLength(0);
  });
  test('rollback is explicit, blocked in private mode and restores original pending statuses', async () => {
    const id=await old(); await engine.executeRaw("UPDATE minion_jobs SET status='delayed' WHERE id=$1",[id]); const r=await park(id);
    await expect(restoreParkedJobs(engine,r.id,r.plan.plan_hash)).rejects.toThrow('private_mode_active'); config(false);
    const restored=await restoreParkedJobs(engine,r.id,r.plan.plan_hash); expect(restored.state).toBe('rolled_back');
    expect(await restoreParkedJobs(engine,r.id,r.plan.plan_hash)).toEqual(restored);
    expect((await queue.getJob(id))?.status).toBe('delayed'); expect(await engine.executeRaw('SELECT * FROM codex_parked_jobs')).toHaveLength(0);
  });
  test('resubmit binds new explicit payload and allowance through the queue, retaining the old identity', async () => {
    const id=await old(); const parked=await park(id), s=spec(id), p=await previewUpgradeSubmission(engine,s);
    expect(JSON.stringify(p)).not.toContain(s.data.prompt as string);
    const r=await resubmitUpgradeJob(engine,s,p.plan_hash), next=await queue.getJob(r.receipt.replacement_job_id);
    expect(next!.id).not.toBe(id); expect(next!.data).toEqual(s.data); expect(next!.submission_authority?.kind).toBe('application');
    expect((await queue.getJob(id))?.status).toBe('paused');
    expect(await engine.executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(1);
    expect((await resubmitUpgradeJob(engine,s,p.plan_hash)).id).toBe(r.id);
    expect((await queue.claim('new-worker',60000,'default',['subagent']))?.id).toBe(next!.id);
    config(false); await expect(restoreParkedJobs(engine,parked.id,parked.plan.plan_hash)).rejects.toThrow('replacement_or_fence_changed');
  });
  test('changed resubmission, forbidden pins and native-loop protocols cannot acquire a grant', async () => {
    const id=await old(); await park(id); const s=spec(id), p=await previewUpgradeSubmission(engine,s);
    await expect(resubmitUpgradeJob(engine,{...s,max_attempts:4},p.plan_hash)).rejects.toThrow('preview_changed');
    await expect(previewUpgradeSubmission(engine,{...s,data:{...s.data,model:'anthropic:fixture'}})).rejects.toThrow('job:model');
    await expect(previewUpgradeSubmission(engine,{...s,data:{prompt:'Old native loop',source_id:'default'}})).rejects.toThrow('private_native_loop_unsupported');
    expect(await engine.executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(0);
  });
  test('prior execution or retained messages requires reconciliation, never blind replay', async () => {
    const id=await old(); await engine.executeRaw('UPDATE minion_jobs SET attempts_made=1,attempts_started=1 WHERE id=$1',[id]); await park(id);
    await expect(previewUpgradeSubmission(engine,spec(id))).rejects.toThrow('previous_execution_requires_reconciliation');
    const other=await old(); await engine.executeRaw("INSERT INTO subagent_messages(job_id,message_idx,role,content_blocks) VALUES($1,0,'user','[]'::jsonb)",[other]); await park(other);
    await expect(previewUpgradeSubmission(engine,spec(other))).rejects.toThrow('retained_execution_requires_reconciliation');
    const started=await old(); await engine.executeRaw('UPDATE minion_jobs SET attempts_started=1 WHERE id=$1',[started]); await park(started);
    await expect(previewUpgradeSubmission(engine,spec(started))).rejects.toThrow('previous_execution_requires_reconciliation');
  });
  test('mixed replacement has explicit auxiliary USD consent; changed replay cannot enqueue again', async () => {
    const id=await old(); await park(id); const s={...spec(id),max_usd:1},p=await previewUpgradeSubmission(engine,s),r=await resubmitUpgradeJob(engine,s,p.plan_hash);
    const next=await queue.getJob(r.receipt.replacement_job_id); expect(next!.spend_authorization).toMatchObject({cap_usd:1});
    await expect(resubmitUpgradeJob(engine,{...s,data:{...s.data,prompt:'Changed request'}},p.plan_hash)).rejects.toThrow('submission_changed');
    await expect(previewUpgradeSubmission(engine,{...s,submission_authority:{kind:'application'}})).rejects.toThrow('invalid_submission');
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(2);
  });
  test('canonical job identities are preserved and out-of-range IDs refuse', async () => {
    await expect(previewJobUpgrade(engine,[3000000000])).rejects.toThrow('invalid_ids');
    const id=2147483000;
    await engine.executeRaw("INSERT INTO minion_jobs(id,name,status,data,submission_authority) VALUES($1,'subagent','waiting','{}'::jsonb,$2::text::jsonb)",[id,JSON.stringify({version:1,kind:'application'})]);
    const p=await previewJobUpgrade(engine,[id]); expect(p.ids).toEqual([id]);
    const r=await parkUpgradeJobs(engine,[id],p.plan_hash); expect(r.plan.ids).toEqual([id]);
  });
  test('source incarnation changes refuse resubmission and rollback', async () => {
    const id=await old(), r=await park(id); await engine.executeRaw("UPDATE sources SET incarnation=gen_random_uuid() WHERE id='default'");
    await expect(previewUpgradeSubmission(engine,spec(id))).rejects.toThrow('source_incarnation_changed'); config(false);
    await expect(restoreParkedJobs(engine,r.id,r.plan.plan_hash)).rejects.toThrow('source_or_dependencies_changed');
  });
  test('receipt failure after replacement insertion rolls back queue, subscription grant and link', async () => {
    const id=await old(); await park(id); const s=spec(id),p=await previewUpgradeSubmission(engine,s),nestedTransaction=engine.transaction,transaction=nestedTransaction.bind(engine);
    const fail=spyOn(engine,'transaction').mockImplementation(run=>transaction(async tx=>{
      Object.defineProperty(tx,'transaction',{value:nestedTransaction});
      const execute=tx.executeRaw.bind(tx),fault=spyOn(tx,'executeRaw').mockImplementation((sql,...args)=>{
        if(sql.startsWith('INSERT INTO codex_upgrade_receipts')) throw new Error('synthetic resubmit crash'); return execute(sql,...args);
      }); try{return await run(tx);}finally{fault.mockRestore();}
    }));
    try {await expect(resubmitUpgradeJob(engine,s,p.plan_hash)).rejects.toThrow('synthetic resubmit crash');} finally {fail.mockRestore();}
    expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(1);
    expect(await engine.executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(0);
    const [fence]=await engine.executeRaw('SELECT replacement_job_id FROM codex_parked_jobs WHERE job_id=$1',[id]); expect(fence!.replacement_job_id).toBeNull();
    expect((await resubmitUpgradeJob(engine,s,p.plan_hash)).receipt.replacement_job_id).not.toBe(id);
  });
  test('two concurrent migration callers get one replacement and one grant', async () => {
    const id=await old(); await park(id); const s=spec(id),p=await previewUpgradeSubmission(engine,s);
    const [a,b]=await Promise.all([resubmitUpgradeJob(engine,s,p.plan_hash),resubmitUpgradeJob(engine,s,p.plan_hash)]);
    expect(a.id).toBe(b.id); expect(await engine.executeRaw('SELECT id FROM minion_jobs')).toHaveLength(2);
    expect(await engine.executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(1);
  });
  test('real CLI preview uses read-only connection intent and refuses invalid mutations before connection', async () => {
    const id=await old(), written:string[]=[], connections:unknown[]=[];
    const print=spyOn(output,'writeStdoutFinal').mockImplementation(async text=>{written.push(text);}), disconnect=spyOn(engine,'disconnect').mockResolvedValue();
    const ctx={connectEngine:async (opts:unknown)=>{connections.push(opts);return engine;}} as unknown as CliDispatchContext;
    try {
      await run(['jobs','preview','--ids',String(id),'--json'],ctx);
      expect(JSON.parse(written.join('')).jobs[0].disposition).toBe('park'); expect(connections).toEqual([{probeOnly:true}]);
      for (const args of [['jobs','park','--ids',String(id)],['jobs','restore','--id','bad','--expect','a'.repeat(64),'--yes'],['jobs','receipts','--yes'],['jobs','__proto__']]) await expect(run(args,ctx)).rejects.toThrow('Codex job upgrade refused');
      expect(connections).toHaveLength(1);
    } finally {print.mockRestore();disconnect.mockRestore();}
  });
  test('actual CLI reads an explicit bounded replacement file and applies its reviewed hash', async () => {
    const id=await old(),p=await previewJobUpgrade(engine,[id]),written:string[]=[];
    const print=spyOn(output,'writeStdoutFinal').mockImplementation(async text=>{written.push(text);}),disconnect=spyOn(engine,'disconnect').mockResolvedValue();
    const ctx={connectEngine:async ()=>engine} as unknown as CliDispatchContext;
    try {
      await run(['jobs','park','--ids',String(id),'--expect',p.plan_hash,'--yes'],ctx);
      const file=join(root,'replacement.json'),s=spec(id); writeFileSync(file,JSON.stringify(s),{mode:0o600});
      await run(['jobs','resubmit-preview','--file',file],ctx); const preview=JSON.parse(written[1]!);
      await run(['jobs','resubmit','--file',file,'--expect',preview.plan_hash,'--yes'],ctx);
      expect(JSON.parse(written[2]!).receipt.replacement_job_id).not.toBe(id);
      expect(written.join('')).not.toContain(s.data.prompt as string); expect((await queue.getJob(id))?.status).toBe('paused');
    } finally {print.mockRestore();disconnect.mockRestore();}
  });
}
