import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { codexSubscriptionContext, type CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { reserveSubscriptionAttempt, settleSubscriptionAttempt } from '../../src/core/ai/subscription-admission.ts';
import { digest } from '../../src/core/persistence/digest.ts';
import { runEvalLongMemEval } from '../../src/commands/eval-longmemeval.ts';
import { claimEvalRun, fenceEvalRun, readEvalResult, retainEvalResult, releaseEvalRun } from '../../src/eval/longmemeval/codex-run-store.ts';
import { withPrivateEvalLifecycle, bindPrivateEval, privateEvalAnswer, settlePrivateEvalQuestion, privateEvalReplayText } from '../../src/eval/longmemeval/codex-run.ts';
import { loadExpansionReplay } from '../../src/eval/longmemeval/resume.ts';

interface Fixture {
  engine(): BrainEngine;
  run<T>(fn: (id: string) => Promise<T>, hooks?: Partial<CodexSubscriptionContext>, maxAttempts?: number): Promise<T>;
  reply(value: unknown): void; calls(): unknown[];
}
export function codexEvalRunContract(f: Fixture) { describe('durable native evaluation runs', () => {
  const body = 'Aster moved to the coast.';
  const responses = (judge: unknown = { answer: 'yes' }) => f.reply({ byRole: {
    reader: { answer: body, status: 'answered', citations: [{ session_id: '__first_session__', quote: body }] }, judge,
  } });
  const fixture = (count = 2, judge = true) => {
    const root = mkdtempSync(join(tmpdir(), 'codex-run-')), dataset = join(root, 'input.jsonl'), output = join(root, 'output.jsonl');
    const questions = Array.from({ length: count }, (_, i) => ({ question_id: `retained-${i}`, question_type: 'single-session-user',
      question: 'Where did Aster move?', answer: 'The coast', question_date: '2026-06-03', answer_session_ids: ['s1'],
      haystack_dates: ['2026-06-02'], haystack_sessions: [{ session_id: 's1', turns: [{ role: 'user', content: body }] }] }));
    writeFileSync(dataset, questions.map(q => JSON.stringify(q)).join('\n')); responses();
    const args = [dataset, '--keyword-only', '--no-trajectory', '--no-embed-cache', '--by-type', ...judge ? ['--judge'] : []];
    const run = (extra: string[] = []) => runEvalLongMemEval([...args,'--output',output,...extra], { exitOnError: false });
    const rows = () => readFileSync(output,'utf8').trim().split('\n').map(line => JSON.parse(line));
    return { root,dataset,output,questions,run,rows };
  };
  const state = async (id: string) => (await f.engine().executeRaw<{ state: string; owner_token: string | null }>('SELECT state,owner_token FROM codex_eval_runs WHERE run_id=$1',[id]))[0]!;
  test('actual CLI replays retained answers and judgments after grant expiry without new inference', async () => {
    const t = fixture(), before = f.calls().length;
    try { await f.run(async id => {
      await t.run(); const first = t.rows().slice(0,2);
      expect(await state(id)).toEqual({state:'complete',owner_token:null});
      expect(await f.engine().executeRaw('SELECT stage FROM codex_eval_results WHERE run_id=$1',[id])).toHaveLength(4);
      await f.engine().executeRaw("UPDATE codex_subscription_runs SET deadline=now()-interval '1 second' WHERE run_id=$1",[id]);
      f.reply({raw:'must never be invoked on receipt replay'}); await t.run();
      expect(t.rows().slice(0,2)).toEqual(first); expect(f.calls().length-before).toBe(4);
    }); } finally { rmSync(t.root,{recursive:true,force:true}); }
  });
  test('a settled failed judge retains its reader answer and retries only the judge', async () => {
    const t = fixture(1), before = f.calls().length; responses({ answer:'maybe' });
    try { await f.run(async id => {
      await expect(t.run()).rejects.toThrow('exit 1');
      expect(await f.engine().executeRaw('SELECT stage FROM codex_eval_results WHERE run_id=$1',[id])).toEqual([{stage:'answer'}]);
      expect((await state(id)).state).toBe('idle'); responses(); await t.run();
      expect(t.rows()[0].judge_correct).toBe(true); expect(f.calls().length-before).toBe(3);
    }); } finally { rmSync(t.root,{recursive:true,force:true}); }
  });
  test('ambiguous judge completion remains unresolved and blocks restart', async () => {
    const t = fixture(1), before = f.calls().length; responses({ missingCompletion:true });
    try { await f.run(async id => {
      await expect(t.run()).rejects.toThrow(); expect((await state(id)).state).toBe('needs_reconciliation');
      responses(); await expect(t.run()).rejects.toMatchObject({code:'subscription_lane_busy'});
      expect(f.calls().length-before).toBe(2);
    }); } finally { rmSync(t.root,{recursive:true,force:true}); }
  });
  test('JSONL resume requires unchanged canonical receipts even with matching model hashes', async () => {
    const t = fixture(1), before = f.calls().length;
    try { await f.run(async () => {
      await t.run(); const saved = readFileSync(t.output,'utf8'), forged = t.rows(); forged[0].hypothesis='Forged answer';
      writeFileSync(t.output,forged.map(row=>JSON.stringify(row)).join('\n'));
      await expect(t.run(['--resume-from',t.output])).rejects.toMatchObject({code:'subscription_identity_conflict'});
      writeFileSync(t.output,saved); await t.run(['--resume-from',t.output]); expect(f.calls().length-before).toBe(2);
    }); } finally { rmSync(t.root,{recursive:true,force:true}); }
  });
  test('changed dataset and material options refuse identity reuse before another call', async () => {
    const t = fixture(1,false), before = f.calls().length;
    try { await f.run(async () => {
      await t.run(); await expect(t.run(['--top-k','3'])).rejects.toMatchObject({code:'subscription_identity_conflict'});
      t.questions[0]!.answer='Another reference'; writeFileSync(t.dataset,JSON.stringify(t.questions[0]));
      await expect(t.run()).rejects.toMatchObject({code:'subscription_identity_conflict'}); expect(f.calls().length-before).toBe(1);
    }); } finally { rmSync(t.root,{recursive:true,force:true}); }
  });
  test('failure after answer commit recovers the committed receipt before file emission', async () => {
    const t = fixture(1,false), before = f.calls().length, engine = f.engine(), original = engine.transaction;
    try { await f.run(async id => {
      let fired = false;
      engine.transaction = (async (fn: Parameters<BrainEngine['transaction']>[0]) => {
        const value = await original.call(engine,fn);
        if (!fired && (await engine.executeRaw('SELECT stage FROM codex_eval_results WHERE run_id=$1',[id])).length) { fired=true; throw new Error('fixture_after_answer_commit'); }
        return value;
      }) as BrainEngine['transaction'];
      await expect(t.run()).rejects.toThrow(); engine.transaction=original; expect(fired).toBe(true);
      await t.run(); expect(t.rows()[0].hypothesis).toBe(body); expect(f.calls().length-before).toBe(1);
    }); } finally { engine.transaction=original; rmSync(t.root,{recursive:true,force:true}); }
  });
  test('exhaustion stops the batch after one failed question without processing the tail', async () => {
    const t = fixture(5,false), before = f.calls().length;
    try { await f.run(async () => { await expect(t.run()).rejects.toThrow('exit 1'); expect(t.rows()).toHaveLength(2); },{},1);
      expect(f.calls().length-before).toBe(1);
    } finally { rmSync(t.root,{recursive:true,force:true}); }
  });
  test('the bound expansion replay consumes its captured bytes despite a later file change', async () => {
    const t = fixture(1,false), replay=join(t.root,'expansion.jsonl'), question=t.questions[0]!;
    writeFileSync(replay,JSON.stringify({question_id:question.question_id,expansion_variants:['original']}));
    try { await f.run(()=>withPrivateEvalLifecycle(async()=>{
      await bindPrivateEval({datasetSha256:digest('dataset'),questions:[question],options:{expansionReplayPath:replay},
        retrievalHash:digest('retrieval'),readerHash:digest('reader'),judgeHash:digest('judge'),extractorModel:'',requiresResources:true});
      writeFileSync(replay,JSON.stringify({question_id:question.question_id,expansion_variants:['changed']}));
      expect(loadExpansionReplay(replay,privateEvalReplayText()).get(question.question_id)).toEqual(['original']);
      const outcome=await privateEvalAnswer(question,async()=>({row:{question_id:question.question_id,hypothesis:'retained'},rerankerSkipped:false,vectorDegraded:false,expansionFailed:false}));
      await settlePrivateEvalQuestion(question,outcome);
    })); } finally {rmSync(t.root,{recursive:true,force:true});}
  });
  test('a corrupted durable answer is refused rather than regenerated', async () => {
    const t=fixture(1,false),before=f.calls().length;
    try {await f.run(async id=>{
      await t.run();
      await f.engine().executeRaw("UPDATE codex_eval_results SET payload=jsonb_set(payload,'{row,hypothesis}','\"corrupted\"'::jsonb) WHERE run_id=$1",[id]);
      await expect(t.run()).rejects.toThrow();expect(f.calls().length-before).toBe(1);
    });}finally{rmSync(t.root,{recursive:true,force:true});}
  });
  test('two owners, expired leases and unsettled attempts preserve the fencing boundary', async () => {
    await f.run(async id => {
      const host = codexSubscriptionContext()!, binding=digest('fixture'), first=await claimEvalRun(host,binding,1,'answer');
      await expect(claimEvalRun(host,binding,1,'answer')).rejects.toMatchObject({code:'subscription_owner_lost'});
      await f.engine().executeRaw("UPDATE codex_eval_runs SET lease_until=now()-interval '1 second' WHERE run_id=$1",[id]);
      const attempt=await reserveSubscriptionAttempt(f.engine(),{runId:id,attemptId:randomUUID(),requestHash:digest('attempt'),timeoutMs:1000});
      await expect(claimEvalRun(host,binding,1,'answer')).rejects.toMatchObject({code:'subscription_lane_busy'});
      await settleSubscriptionAttempt(f.engine(),attempt,{state:'failed',failureCode:'fixture_not_dispatched'});
      const replacement=await claimEvalRun(host,binding,1,'answer');
      await expect(f.engine().transaction(tx=>fenceEvalRun(tx,host,first))).rejects.toMatchObject({code:'subscription_owner_lost'});
      await expect(releaseEvalRun(host,first,false)).rejects.toMatchObject({code:'subscription_owner_lost'});
      const question={question_id:'fixture',question:'bounded'}, outcome={row:{question_id:'fixture',hypothesis:'retained'},rerankerSkipped:false,vectorDegraded:false,expansionFailed:false};
      await expect(f.engine().transaction(tx=>retainEvalResult(tx,first,question,'answer',outcome))).rejects.toMatchObject({code:'subscription_owner_lost'});
      await f.engine().transaction(async tx=>{await fenceEvalRun(tx,host,replacement);await retainEvalResult(tx,replacement,question,'answer',outcome);});
      await expect(f.engine().transaction(tx=>retainEvalResult(tx,replacement,{...question,question:'changed'},'answer',outcome))).rejects.toMatchObject({code:'subscription_identity_conflict'});
      await releaseEvalRun(host,replacement,true); expect((await state(id)).state).toBe('complete');
      expect(await readEvalResult(f.engine(),replacement,question,'answer')).toEqual(outcome);
    });
  });
}); }
