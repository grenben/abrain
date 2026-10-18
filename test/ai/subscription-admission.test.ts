import { beforeAll, afterAll, test, expect } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { v258 } from '../../src/core/schema-migrations/v258-codex-subscription-admission.ts';
import { createSubscriptionRun, reserveSubscriptionAttempt, settleSubscriptionAttempt, acceptSubscriptionTurn } from '../../src/core/ai/subscription-admission.ts';
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({database_url:''}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
const hash = 'a'.repeat(64);
const envelope = (runId:string, accountLane=runId, maxAttempts=3, maxTurns=maxAttempts) => ({runId,accountLane,maxAttempts,maxTurns,deadline:new Date(Date.now()+60_000)});
const reserve = (runId:string, attemptId:string, repair=false) => reserveSubscriptionAttempt(engine,{runId,attemptId,requestHash:hash,timeoutMs:1000,repair});
test('migration is idempotent and missing subscription admission fails closed', async () => {
  await engine.transaction(tx => tx.runMigration(v258.version, v258.sql));
  await expect(reserve('absent','attempt-absent')).rejects.toMatchObject({code:'subscription_required'});
});
test('immutable run envelopes cannot be reused with a larger allowance', async () => {
  const e=envelope('immutable'); await createSubscriptionRun(engine,e); await createSubscriptionRun(engine,e);
  await expect(createSubscriptionRun(engine,{...e,maxAttempts:4})).rejects.toMatchObject({code:'subscription_identity_conflict'});
});
test('two workers and distinct runs share one account lane', async () => {
  await createSubscriptionRun(engine,envelope('worker-a','shared'));
  await createSubscriptionRun(engine,envelope('worker-b','shared'));
  const results=await Promise.allSettled([reserve('worker-a','worker-a-1'),reserve('worker-b','worker-b-1')]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  const winner=results.find(r=>r.status==='fulfilled'); if(winner?.status!=='fulfilled') throw new Error('no winner');
  await settleSubscriptionAttempt(engine,winner.value,{state:'succeeded',usage:{inputTokens:12,cachedInputTokens:4,outputTokens:3}});
  const next=await reserve('worker-b','worker-b-2');
  await settleSubscriptionAttempt(engine,next,{state:'failed',failureCode:'spawn'});
});
test('crash and unresolved termination hold the lane without TTL pruning or refund', async () => {
  await createSubscriptionRun(engine,envelope('crash','held'));
  const attempt=await reserve('crash','crash-1');
  await engine.executeRaw("UPDATE codex_subscription_attempts SET created_at=now()-interval '2 days' WHERE attempt_id=$1",[attempt.attemptId]);
  await expect(reserve('crash','crash-2')).rejects.toMatchObject({code:'subscription_lane_busy'});
  await settleSubscriptionAttempt(engine,attempt,{state:'unresolved',failureCode:'termination_unconfirmed'});
  await expect(reserve('crash','crash-3')).rejects.toMatchObject({code:'subscription_lane_busy'});
  const [row]=await engine.executeRaw<{attempts:number}>('SELECT attempts FROM codex_subscription_runs WHERE run_id=$1',['crash']);
  expect(row?.attempts).toBe(1);
});
test('stale owner cannot settle, repeated/changed requests never dispatch again', async () => {
  await createSubscriptionRun(engine,envelope('fenced'));
  const attempt=await reserve('fenced','fenced-1');
  await expect(settleSubscriptionAttempt(engine,{...attempt,ownerId:'stale'},{state:'failed',failureCode:'spawn'})).rejects.toMatchObject({code:'subscription_owner_lost'});
  await expect(reserve('fenced','fenced-1')).rejects.toMatchObject({code:'subscription_identity_conflict'});
  await expect(reserveSubscriptionAttempt(engine,{runId:'fenced',attemptId:'fenced-1',requestHash:'b'.repeat(64),timeoutMs:1000})).rejects.toMatchObject({code:'subscription_identity_conflict'});
  await settleSubscriptionAttempt(engine,attempt,{state:'succeeded',usage:null});
  await expect(settleSubscriptionAttempt(engine,attempt,{state:'failed',failureCode:'spawn'})).rejects.toMatchObject({code:'subscription_owner_lost'});
});
test('attempt cap consumes failed calls and refuses further admission', async () => {
  await createSubscriptionRun(engine,envelope('bounded','bounded',1));
  const attempt=await reserve('bounded','bounded-1'); await settleSubscriptionAttempt(engine,attempt,{state:'failed',failureCode:'spawn'});
  await expect(reserve('bounded','bounded-2')).rejects.toMatchObject({code:'subscription_exhausted'});
});
test('semantic acceptance is explicit, idempotent and bounded separately', async () => {
  await createSubscriptionRun(engine,envelope('accepted','accepted',3,1));
  const attempt=await reserve('accepted','accepted-1'); await settleSubscriptionAttempt(engine,attempt,{state:'succeeded',usage:null});
  await acceptSubscriptionTurn(engine,attempt); await acceptSubscriptionTurn(engine,attempt);
  await expect(reserve('accepted','accepted-2')).rejects.toMatchObject({code:'subscription_exhausted'});
  const [row]=await engine.executeRaw<{accepted_turns:number}>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1',['accepted']);
  expect(row?.accepted_turns).toBe(1);
});
test('one repair across layers and the complete call timeout must fit the deadline', async () => {
  await createSubscriptionRun(engine,envelope('repair'));
  const attempt=await reserve('repair','repair-1',true); await settleSubscriptionAttempt(engine,attempt,{state:'succeeded',usage:null});
  await expect(reserve('repair','repair-2',true)).rejects.toMatchObject({code:'subscription_exhausted'});
  await createSubscriptionRun(engine,{...envelope('deadline'),deadline:new Date(Date.now()+100)});
  await expect(reserve('deadline','deadline-1')).rejects.toMatchObject({code:'subscription_exhausted'});
});
