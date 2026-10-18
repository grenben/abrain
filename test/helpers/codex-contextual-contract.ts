import { v285 } from '../../src/core/schema-migrations/v285-precise-auxiliary-spend.ts';
import { reserveGroup, settle } from '../../src/core/minions/budget-meter.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { runWithJobSpend, jobSpendAuthorization } from '../../src/core/minions/spend-authorization.ts';
import { makeContextualReindexHandler } from '../../src/core/minions/handlers/contextual-reindex-per-chunk.ts';
import type { MinionJob, MinionJobContext } from '../../src/core/minions/types.ts';
import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { reembedPageWithContextualRetrieval, type ReembedPageArgs } from '../../src/core/contextual-retrieval-service.ts';
import { generatePerChunkSynopsis } from '../../src/core/page-summary.ts';
import { configureGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { withSubscriptionAuxiliaryBudget } from '../../src/core/ai/subscription-auxiliary.ts';
import type { CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { installFixtureChunks } from './page-projection.ts';
interface Fixture { engine():BrainEngine;sourceId:string;run<T>(fn:(id:string)=>Promise<T>,hooks?:Partial<CodexSubscriptionContext>,maxAttempts?:number):Promise<T>;reply(value:unknown):void;calls():any[]; }
export function codexContextualContract(f:Fixture){describe('native contextual summaries',()=>{
  let slug:string,embedded:string[][],intervene:(()=>Promise<void>)|undefined,unknownUsage:boolean;
  const chunk='Nebula launched in June. The launch succeeded.',valid={synopsis:'Nebula launched in June.',source_quote:'Nebula launched in June.'};
  const opts=(extra:Partial<ReembedPageArgs>={}):ReembedPageArgs=>({engine:f.engine(),sourceId:f.sourceId,pageSlug:slug,globalMode:'per_chunk_synopsis',...extra});
  const paid=<T>(run:()=>Promise<T>,cap:number|undefined=0.1,key=`contextual-${randomUUID()}`)=>withSubscriptionAuxiliaryBudget(f.engine(),key,cap,run);
  const run=(extra:Partial<ReembedPageArgs>={})=>paid(()=>reembedPageWithContextualRetrieval(opts(extra)));
  const state=async()=>{const page=await f.engine().getPage(slug,{sourceId:f.sourceId});const chunks=await f.engine().getChunks(slug,{sourceId:f.sourceId,includeEmbedding:true});return {page,chunks};};
  const context=(job:MinionJob)=>({id:job.id,name:job.name,data:job.data,signal:new AbortController().signal,shutdownSignal:new AbortController().signal}) as MinionJobContext;
  const submit=async(data={page_slug:slug,expected_source_id:f.sourceId})=>{
    const queue=new MinionQueue(f.engine()),queueName=`contextual-${randomUUID()}`;
    await queue.add('contextual_reindex_per_chunk',data,{queue:queueName},{allowProtectedSubmit:true,codexSubscription:{maxAttempts:2,maxTurns:2,deadline:new Date(Date.now()+600000)},spendAuthorization:jobSpendAuthorization({consented_effects:['paid'],cap_usd:0.1,cap_source:'user',via:'yes'},{command:'reindex'})});
    const job=await queue.claim('contextual-worker',60000,queueName,['contextual_reindex_per_chunk']);if(!job)throw new Error('fixture claim missing');return job;
  };
  const handle=(job:MinionJob)=>{const ctx=context(job);return runWithJobSpend(f.engine(),job,ctx,()=>makeContextualReindexHandler({engine:f.engine()})(ctx));};
  beforeEach(async()=>{
    slug=`notes/contextual-${randomUUID()}`;embedded=[];intervene=undefined;unknownUsage=false;f.reply(valid);
    configureGateway({embedding_model:'openai:text-embedding-3-small',embedding_dimensions:1536,env:{OPENAI_API_KEY:'sk-fixture-not-a-credential'}});
    __setEmbedTransportForTests(async({values}:{values:string[]})=>{embedded.push(values);await intervene?.();return {embeddings:values.map(()=>[1,...Array(1535).fill(0)]),...unknownUsage?{}:{usage:{tokens:17}}} as never;});
    for(const key of ['models.contextual_synopsis','contextual_retrieval.haiku_model','models.tier.utility'])await f.engine().setConfig(key,'');
    await f.engine().putPage(slug,{type:'note',title:'Nebula launch',compiled_truth:chunk},{sourceId:f.sourceId});
    await installFixtureChunks(f.engine(),slug,[{chunk_index:0,chunk_text:chunk,chunk_source:'compiled_truth'}],{sourceId:f.sourceId});
  });
  afterEach(()=>{__setEmbedTransportForTests(null);configureGateway({embedding_dimensions:1536,env:{}});});
  test('direct service defaults to native Codex and atomically installs separately metered embeddings',async()=>{
    const before=await state(),count=f.calls().length,key=`contextual-${randomUUID()}`;
    await f.run(async id=>{
      const result=await paid(()=>reembedPageWithContextualRetrieval(opts()),0.1,key);expect(result.kind).toBe('success');
      const [row]=await f.engine().executeRaw<{attempts:number;accepted_turns:number}>('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[id]);expect(Number(row!.attempts)).toBe(1);expect(Number(row!.accepted_turns)).toBe(1);
    });
    expect(f.calls().length-count).toBe(1);const wire=f.calls().at(-1)!;expect(wire.schema.required).toContain('source_quote');expect(wire.schema.required).toContain('evidence_hash');expect(wire.mode).toBe(0o600);
    const after=await state();expect(after.page!.knowledge_revision).toBe(before.page!.knowledge_revision);expect(after.page!.contextual_retrieval_mode).toBe('per_chunk_synopsis');expect(after.chunks[0]!.embedding![0]).toBe(1);expect(after.chunks[0]!.model).toBe('openai:text-embedding-3-small');
    expect(embedded).toHaveLength(1);expect(embedded[0]![0]).toContain(valid.synopsis);
    const [hold]=await f.engine().executeRaw<{status:string;actual_cents:number}>('SELECT status,actual_cents FROM mcp_spend_reservations WHERE budget_key=$1',[key]);expect(hold!.status).toBe('settled');expect(Number(hold!.actual_cents)).toBeCloseTo(0.000034,12);
  });
  test.each([{raw:'malformed'},{refusal:true},{missingCompletion:true},{...valid,source_quote:'Invented quote'},{...valid,synopsis:''},{...valid,evidence_hash:'forged'}])('failed summaries never fall back to title mode or publish vectors',async reply=>{
    f.reply(reply);await f.run(async()=>{await expect(run()).rejects.toThrow();});expect(embedded).toHaveLength(0);expect((await state()).page!.contextual_retrieval_mode).toBeNull();expect((await state()).chunks[0]!.embedding).toBeNull();
  });
  test('multiple chunks use sequential bounded native turns before one embedding batch',async()=>{
    await installFixtureChunks(f.engine(),slug,[0,1].map(chunk_index=>({chunk_index,chunk_text:chunk,chunk_source:'compiled_truth' as const})),{sourceId:f.sourceId});
    const count=f.calls().length;await f.run(async()=>{expect((await run({chunkConcurrency:16})).kind).toBe('success');});expect(f.calls().length-count).toBe(2);expect(embedded).toHaveLength(1);expect(embedded[0]).toHaveLength(2);
  });
  test('exhausted summary allowance cannot publish a partially summarized page',async()=>{
    await installFixtureChunks(f.engine(),slug,[0,1].map(chunk_index=>({chunk_index,chunk_text:chunk,chunk_source:'compiled_truth' as const})),{sourceId:f.sourceId});
    await f.run(async()=>{await expect(run()).rejects.toMatchObject({code:'subscription_exhausted'});},{},1);expect(embedded).toHaveLength(0);expect((await state()).page!.contextual_retrieval_mode).toBeNull();
  });
  test('precision migration preserves old amounts, is replayable, and retains small new charges',async()=>{
    const engine=f.engine(),key=`migration-${randomUUID()}`;
    const hold=await reserveGroup(engine,{budgetKey:key,capCents:1,estimatedCents:0.25,model:'fixture',provider:'fixture',estimateKnown:true});await settle(engine,hold.reservationId,0.1255,'fixture');
    await engine.transaction(async tx=>{
      await tx.executeRaw('ALTER TABLE mcp_spend_reservations ALTER COLUMN estimated_cents TYPE NUMERIC(12,4), ALTER COLUMN actual_cents TYPE NUMERIC(12,4)');
      await tx.executeRaw('ALTER TABLE mcp_spend_log ALTER COLUMN spend_cents TYPE NUMERIC(12,4)');
      for(let replay=0;replay<2;replay++)for(const statement of v285.sql!.split(';').filter(part=>part.trim()))await tx.executeRaw(statement);
      const [row]=await tx.executeRaw<{actual_cents:number;estimated_cents:number}>('SELECT actual_cents,estimated_cents FROM mcp_spend_reservations WHERE reservation_id=$1',[hold.reservationId]);expect(Number(row!.actual_cents)).toBe(0.1255);expect(Number(row!.estimated_cents)).toBe(0.25);
      const columns=await tx.executeRaw<{numeric_scale:number}>("SELECT numeric_scale FROM information_schema.columns WHERE table_schema='public' AND ((table_name='mcp_spend_reservations' AND column_name IN ('actual_cents','estimated_cents')) OR (table_name='mcp_spend_log' AND column_name='spend_cents'))");expect(columns.map(row=>Number(row.numeric_scale))).toEqual([12,12,12]);
    });
    const small=await reserveGroup(engine,{budgetKey:key,capCents:1,estimatedCents:0.0000001,model:'fixture',provider:'fixture',estimateKnown:true});await settle(engine,small.reservationId,0.0000001,'fixture');
    const [row]=await engine.executeRaw<{spend_cents:number}>('SELECT spend_cents FROM mcp_spend_log WHERE budget_key=$1 AND operation=$2 ORDER BY id DESC LIMIT 1',[key,'fixture']);expect(Number(row!.spend_cents)).toBe(0.0000001);
  });
  test('subscription consent alone cannot reach paid embedding or spend a summary attempt',async()=>{
    const count=f.calls().length;
    await f.run(async()=>{await expect(reembedPageWithContextualRetrieval(opts())).rejects.toMatchObject({code:'subscription_auxiliary_budget_required'});});
    expect(embedded).toHaveLength(0);expect(f.calls().length).toBe(count);
  });
  test('a USD allowance alone cannot authorize native inference',async()=>{
    const count=f.calls().length;await expect(run()).rejects.toMatchObject({code:'subscription_required'});expect(f.calls().length).toBe(count);expect(embedded).toHaveLength(0);
  });
  test('exhausted independent auxiliary budget prevents embedding and publication',async()=>{
    await f.run(async()=>{await expect(paid(()=>reembedPageWithContextualRetrieval(opts()),1e-12)).rejects.toThrow();});expect(embedded).toHaveLength(0);expect((await state()).page!.contextual_retrieval_mode).toBeNull();
  });
  test('unknown embedding usage keeps its reservation rather than inventing zero cost',async()=>{
    unknownUsage=true;const key=`contextual-${randomUUID()}`;
    await f.run(async()=>{expect((await paid(()=>reembedPageWithContextualRetrieval(opts()),0.1,key)).kind).toBe('success');});
    const [hold]=await f.engine().executeRaw<{status:string;usage_unknown_reason:string;actual_cents:number|null}>('SELECT status,usage_unknown_reason,actual_cents FROM mcp_spend_reservations WHERE budget_key=$1',[key]);expect(hold!.status).toBe('pending');expect(hold!.usage_unknown_reason).toBe('provider_usage_unknown');expect(hold!.actual_cents).toBeNull();
  });
  test.each([{synopsisModel:'anthropic:fixture'},{haikuModel:'anthropic:fixture',synopsisModel:'codex-cli:gpt-test'}])('explicit and shadowed legacy model pins refuse before dispatch',async extra=>{
    const count=f.calls().length;await f.run(async()=>{await expect(run(extra)).rejects.toMatchObject({code:'private_route_conflict'});});expect(f.calls().length).toBe(count);expect(embedded).toHaveLength(0);
  });
  test('database pins and injected synopsis generators cannot bypass private routing',async()=>{
    const count=f.calls().length;await f.engine().setConfig('contextual_retrieval.haiku_model','anthropic:fixture');
    await f.run(async()=>{await expect(run()).rejects.toMatchObject({code:'private_route_conflict'});});await f.engine().setConfig('contextual_retrieval.haiku_model','');
    await f.run(async()=>{await expect(run({generateSynopsis:async()=>({kind:'success',synopsis:'Forged'})})).rejects.toMatchObject({reason:'invalid_input'});});expect(f.calls().length).toBe(count);
  });
  test('publication rechecks worker authority inside the transaction after embedding finishes',async()=>{
    let checked=false;await f.run(async()=>{expect((await run()).kind).toBe('transient_error');},{checkAuthorityInTransaction:async()=>{checked=true;throw new Error('synthetic stale worker');}});
    expect(checked).toBe(true);expect(embedded).toHaveLength(1);expect((await state()).page!.contextual_retrieval_mode).toBeNull();expect((await state()).chunks[0]!.embedding).toBeNull();
  });
  test('cancellation after embedding cannot publish a successful completion',async()=>{
    const controller=new AbortController();intervene=async()=>{controller.abort();};
    await f.run(async()=>{expect((await run()).kind).toBe('transient_error');},{signal:controller.signal});expect((await state()).page!.contextual_retrieval_mode).toBeNull();
  });
  test('revision drift during inference preserves the new page and rejects stale vectors',async()=>{
    intervene=async()=>{await f.engine().putPage(slug,{type:'note',title:'Changed',compiled_truth:'Changed evidence.'},{sourceId:f.sourceId});};
    await f.run(async()=>{expect((await run()).kind).toBe('transient_error');});const after=await state();expect(after.page!.compiled_truth).toBe('Changed evidence.');expect(after.page!.contextual_retrieval_mode).not.toBe('per_chunk_synopsis');
  });
  test('real queued handler resolves the source, meters both providers, and releases its rate lease',async()=>{
    await f.engine().setConfig('search.mode','tokenmax');const job=await submit();
    expect(await handle(job)).toMatchObject({ok:true,mode_applied:'per_chunk_synopsis',chunks_embedded:1});
    const [run]=await f.engine().executeRaw<{run_id:string}>('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1',[`codex-job:${job.id}:%`]);expect(run!.run_id).toContain(':v2:');
    expect(await f.engine().executeRaw('SELECT id FROM subagent_rate_leases WHERE owner_job_id=$1',[job.id])).toHaveLength(0);
  });
  test('replacement worker cannot publish prepared vectors under an old claim',async()=>{
    await f.engine().setConfig('search.mode','tokenmax');const job=await submit();
    intervene=async()=>{await f.engine().executeRaw("UPDATE minion_jobs SET lock_token='replacement',codex_claim_token=claim_generation+1,claim_generation=claim_generation+1 WHERE id=$1",[job.id]);};
    await expect(handle(job)).rejects.toThrow();expect((await state()).page!.contextual_retrieval_mode).toBeNull();expect((await state()).chunks[0]!.embedding).toBeNull();
  });
  test('archived source and old contextual identity refuse before further inference',async()=>{
    const job=await submit(),count=f.calls().length;
    await f.engine().executeRaw('UPDATE sources SET archived=true WHERE id=$1',[f.sourceId]);
    try{await expect(handle(job)).rejects.toMatchObject({code:'subscription_identity_conflict'});}finally{await f.engine().executeRaw('UPDATE sources SET archived=false WHERE id=$1',[f.sourceId]);}
    await f.engine().executeRaw("UPDATE codex_subscription_runs SET run_id=replace(run_id,':v2:',':v1:') WHERE run_id LIKE $1",[`codex-job:${job.id}:%`]);
    await expect(handle(job)).rejects.toMatchObject({code:'subscription_identity_conflict'});expect(f.calls().length).toBe(count);
  });
  test('unscoped private jobs and handler injection cannot select an arbitrary source',async()=>{
    const count=f.calls().length,queue=new MinionQueue(f.engine());
    await expect(queue.add('contextual_reindex_per_chunk',{page_slug:slug},{},{allowProtectedSubmit:true,codexSubscription:{maxAttempts:2,maxTurns:2,deadline:new Date(Date.now()+600000)}})).rejects.toMatchObject({code:'subscription_identity_conflict'});
    const job=await submit();await expect(makeContextualReindexHandler({engine:f.engine(),reembedPage:async()=>({kind:'skipped',reason:'page_missing'})})(context(job))).rejects.toMatchObject({reason:'invalid_input'});expect(f.calls().length).toBe(count);
  });
  test('none mode stays deterministic without a subscription or auxiliary grant',async()=>{
    const count=f.calls().length;expect(await reembedPageWithContextualRetrieval(opts({globalMode:'none'}))).toMatchObject({kind:'skipped',reason:'mode_none'});expect(f.calls().length).toBe(count);expect(embedded).toHaveLength(0);
  });
  test('direct synopsis bounds fail before dispatch',async()=>{
    const count=f.calls().length;await expect(generatePerChunkSynopsis({documentText:chunk,chunkText:'x'.repeat(65537),pageTitle:'Synthetic',pageSlug:slug,sourceId:f.sourceId,chunkIndex:0,model:'codex-cli:gpt-test'})).rejects.toMatchObject({reason:'invalid_input'});expect(f.calls().length).toBe(count);
  });
});}
