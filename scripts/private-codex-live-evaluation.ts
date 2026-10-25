/** Bounded real evaluation callers. Synthetic data only; no paid vector stage or fabricated preference. */
import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PrivateRole, PrivateModelTier } from '../src/core/ai/private-roles.ts';
import { codexSubscriptionContext } from '../src/core/ai/subscription-context.ts';
import { withCodexProposalCache } from '../src/core/ai/codex-proposal-cache.ts';
import { digest } from '../src/core/persistence/digest.ts';

export const EVALUATION_ROLES = ['calibration-think-ab', 'longmemeval-reader', 'longmemeval-judge',
  'longmemeval-extractor', 'longmemeval-fact-keys-paper', 'longmemeval-fact-keys-production',
  'longmemeval-synopsis', 'nightly-probes'] as const;
type Context = { engine: BrainEngine; root: string; sourceId: string; models: Record<PrivateModelTier, string> };
async function attempts(engine: BrainEngine): Promise<number> {
  const scope = codexSubscriptionContext(); assert(scope);
  const [row] = await engine.executeRaw<{ attempts: number }>('SELECT attempts FROM codex_subscription_runs WHERE run_id=$1', [scope.runId]);
  assert(row); return Number(row.attempts);
}
const cached = <T>(name: string, run: () => Promise<T>) => withCodexProposalCache({
  namespace: 'live-evaluation', bindingHash: digest({ name, runId: codexSubscriptionContext()!.runId }),
}, run);

async function ab({ engine, root, sourceId, models }: Context): Promise<Record<string, unknown>> {
  const { preparePrivateAbTrial, inspectPrivateAbTrial } = await import('../src/core/calibration/think-ab-codex.ts');
  const profiles = await engine.executeRaw('SELECT id FROM calibration_profiles WHERE source_id=$1 AND holder=$2', [sourceId, 'self']);
  if (!profiles.length) await engine.executeRaw(`INSERT INTO calibration_profiles(source_id,holder,published,total_resolved,pattern_statements,
    active_bias_tags,model_id,domain_scorecards,voice_gate_passed,voice_gate_attempts)
    VALUES($1,'self',false,5,$2::text[],ARRAY[]::text[],'synthetic-fixture','{}'::jsonb,true,1)`,
  [sourceId, ['For synthetic project dates, distinguish the recorded launch month from later expectations.']]);
  const input = { engine, sourceId, remote: false, trialId: '48a87601-e218-4935-8f46-bb63fbb8537f',
    question: 'When did the synthetic Orbit project launch?', holder: 'self' };
  const result = await preparePrivateAbTrial(input);
  assert.equal(result.state, 'ready'); assert.equal(result.result_id, null);
  for (const side of [result.baseline, result.calibrated]) {
    assert(side); assert.match(side.answer, /March/); assert.equal(side.modelUsed, models.deep);
    assert(side.citations.some(c => c.page_slug === 'notes/launch' && c.row_num === 1));
    assert.match(side.codex_evidence_hash!, /^[a-f0-9]{64}$/);
  }
  assert.notEqual(result.baseline!.codex_evidence_hash, result.calibrated!.codex_evidence_hash);
  const count = await attempts(engine); assert.equal(count, 2);
  assert.deepEqual(await preparePrivateAbTrial(input), result);
  assert.equal(await attempts(engine), count);
  assert.equal((await inspectPrivateAbTrial(engine, sourceId, input.trialId, false)).result_id, null);
  await writeFile(join(root, 'ab-synthetic-drafts.json'), JSON.stringify({ baseline: result.baseline!.answer,
    calibrated: result.calibrated!.answer, preference: null }, null, 2) + '\n', { mode: 0o600 });
  return { grounded_answers: 2, retained_before_review: true, seeded_synthetic_profile: true,
    distinct_evidence_hashes: true, preference: null, published: false, cache_replay_model_calls: 0 };
}

async function reader({ engine, root }: Context): Promise<Record<string, unknown>> {
  const { runEvalLongMemEval } = await import('../src/commands/eval-longmemeval.ts');
  const dir = join(root, 'evaluation'); await mkdir(dir, { recursive: true, mode: 0o700 });
  const dataset = join(dir, 'input.jsonl'), output = join(dir, 'output.jsonl');
  const body = 'On 2026-06-02, Aster moved to the coast.';
  await writeFile(dataset, JSON.stringify({ question_id: 'synthetic-location-1', question_type: 'single-session-user',
    question: 'Where did Aster move?', answer: 'The coast', question_date: '2026-06-03', answer_session_ids: ['s1'],
    haystack_dates: ['2026-06-02'], haystack_sessions: [{ session_id: 's1', turns: [{ role: 'user', content: body }] }] }) + '\n', { mode: 0o600 });
  const run = () => runEvalLongMemEval([dataset, '--keyword-only', '--no-trajectory', '--no-embed-cache', '--by-type',
    '--judge', '--output', output], { exitOnError: false });
  await run();
  const rows = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const answer = rows.find(row => row.question_id === 'synthetic-location-1'); assert(answer);
  assert.match(answer.hypothesis, /coast/i); assert.equal(answer.judge_correct, true);
  assert.equal(answer.judge_cost_usd, null);
  const runId = codexSubscriptionContext()!.runId;
  const retained = await engine.executeRaw<{ stage: string }>('SELECT stage FROM codex_eval_results WHERE run_id=$1 ORDER BY stage', [runId]);
  assert.deepEqual(retained.map(row => row.stage), ['answer', 'judge']);
  const count = await attempts(engine); assert.equal(count, 2);
  await run(); assert.equal(await attempts(engine), count);
  assert.deepEqual((await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(row => row.question_id === answer.question_id), answer);
  const [state] = await engine.executeRaw<{ state: string; owner_token: string | null }>('SELECT state,owner_token FROM codex_eval_runs WHERE run_id=$1', [runId]);
  assert.equal(state?.state, 'complete'); assert.equal(state.owner_token, null);
  return { actual_benchmark_cli: true, questions: 1, correct: 1, keyword_only: true, trajectory: false,
    retained_answer_and_judge: true, released_run_lease: true, receipt_replay_model_calls: 0, cost_usd: null,
    full_dataset_qualified: false };
}

async function judge({ engine, models }: Context): Promise<Record<string, unknown>> {
  const { judgeRow } = await import('../src/eval/longmemeval/judge.ts');
  const { BudgetLedger } = await import('../src/eval/shared/judge-runner.ts');
  const { chat } = await import('../src/core/ai/gateway.ts');
  const input = { question_id: 'synthetic-wrong-answer', question_type: 'single-session-user',
    question: 'Where did Aster move?', answer: 'The coast', hypothesis: 'The mountains.' };
  const run = () => judgeRow(input, { client: chat, model: models.deep, ledger: new BudgetLedger(0, null), configHashFor: digest, retries: 0 });
  return cached('judge-negative-control', async () => {
    const result = await run(); assert.equal(result.judge_correct, false); assert.equal(result.judge_error, undefined);
    assert.equal(result.judge_cost_usd, null); assert.equal(result.judge_native?.cache_hit, false);
    const count = await attempts(engine); const replay = await run();
    assert.equal(replay.judge_correct, false); assert.equal(replay.judge_native?.cache_hit, true);
    assert.equal(await attempts(engine), count);
    return { incorrect_answer_rejected: true, judge_error: false, cache_replay_model_calls: 0, cost_usd: null };
  });
}

async function extractor({ engine, sourceId }: Context): Promise<Record<string, unknown>> {
  const { extractAndInsertClaims, makeAliasMap } = await import('../src/eval/longmemeval/extract.ts');
  const { makeGatewayThinkClient } = await import('../src/eval/longmemeval/gateway-client.ts');
  const { privateModelForRole, readPrivateCodexConfig } = await import('../src/core/ai/private-policy.ts');
  const slug = 'chat/eval-extractor', sessionId = 'eval-extractor', body = 'On 2026-06-02, Aster moved to the coast.';
  if (!await engine.getPage(slug, { sourceId })) await engine.putPage(slug, { type: 'note', title: 'Synthetic move', compiled_truth: body }, { sourceId });
  const result = await extractAndInsertClaims({ engine, client: makeGatewayThinkClient(),
    model: privateModelForRole(readPrivateCodexConfig()!, 'longmemeval-extractor'), sessionSlug: slug, sessionId,
    sessionBody: body, sessionDate: '2026-06-02', sourceId, aliasMap: makeAliasMap() });
  assert(result.inserted >= 1 && result.parsed >= 1);
  const facts = await engine.executeRaw<{ fact: string; source_session: string; source_id: string; event_type: string }>(
    'SELECT fact,source_session,source_id,event_type FROM facts WHERE source_markdown_slug=$1 AND source_id=$2', [slug, sourceId]);
  assert(facts.length >= 1); assert(facts.some(f => /coast/.test(f.fact) && f.event_type === 'location_change'));
  assert(facts.every(f => body.includes(f.fact) && f.source_id === sourceId && f.source_session === sessionId));
  return { inserted: result.inserted, parsed: result.parsed, exact_quotes: true, source_and_session_preserved: true,
    full_trajectory_benchmark_qualified: false };
}

async function vectorProposal(role: PrivateRole, { engine, models }: Context): Promise<Record<string, unknown>> {
  const { createBenchmarkBrain } = await import('../src/eval/longmemeval/harness.ts');
  const { withSubscriptionScratch } = await import('../src/core/ai/subscription-target.ts');
  const { importFromContent } = await import('../src/core/import-file.ts');
  const scratch = await createBenchmarkBrain();
  const slug = 'chat/synthetic-eval', body = '**user:** I moved to the coast in June 2026.';
  try {
    await importFromContent(scratch, slug, `---\ntype: note\ntitle: Synthetic coastal move\n---\n\n${body}`, { sourceId: 'default', noEmbed: true });
    const chunks = await scratch.getChunks(slug, { sourceId: 'default', includeEmbedding: true }); assert(chunks.length);
    const before = await attempts(engine);
    if (role === 'longmemeval-synopsis') {
      const { resolveSynopsisTier, newSynopsisTierOptions, applySynopsisTier } = await import('../src/eval/longmemeval/synopsis-tier.ts');
      const { resolveSearchMode } = await import('../src/core/search/mode.ts');
      const tier = await resolveSynopsisTier(resolveSearchMode({ mode: 'tokenmax' }), false, newSynopsisTierOptions(), {} as import('../src/eval/longmemeval/run-config.ts').RetrievalPins); assert(tier);
      await assert.rejects(withSubscriptionScratch(scratch, () => applySynopsisTier(scratch, [{ slug }], tier)), { code: 'subscription_auxiliary_budget_required' });
      assert.equal(await attempts(engine), before);
      const { generatePerChunkSynopsis } = await import('../src/core/page-summary.ts');
      const result = await generatePerChunkSynopsis({ privateRole: role, documentText: body, chunkText: body,
        pageTitle: 'Synthetic coastal move', pageSlug: slug, sourceId: 'default', chunkIndex: 0, model: models.utility });
      assert.equal(result.kind, 'success'); if (result.kind !== 'success') throw new Error('synopsis failed');
      assert.match(result.synopsis, /coast/i);
    } else {
      const { resolveFactKeyArm, newRetrievalArmOptions, applyFactKeyArm } = await import('../src/eval/longmemeval/retrieval-arms.ts');
      const { makeGatewayThinkClient } = await import('../src/eval/longmemeval/gateway-client.ts');
      const { codexFactKeyItems } = await import('../src/eval/longmemeval/codex-fact-keys-extract.ts');
      const extractor = role === 'longmemeval-fact-keys-paper' ? 'paper' : 'production';
      const resolved = await resolveFactKeyArm({ ...newRetrievalArmOptions(), factKeys: 'page', factExtractor: extractor }, makeGatewayThinkClient()); assert(resolved);
      const { arm, spend } = resolved;
      await assert.rejects(withSubscriptionScratch(scratch, () => applyFactKeyArm(scratch, [{ slug, content: body }], arm, spend)), { code: 'subscription_auxiliary_budget_required' });
      assert.equal(await attempts(engine), before);
      await cached(role, async () => {
        const items = await codexFactKeyItems(body, arm, spend);
        assert(items.length >= 1 && items.some(item => /coast/i.test(item)));
        assert.deepEqual(await codexFactKeyItems(body, arm, spend), items);
        assert.equal(spend.calls, 1); assert.equal(spend.cacheHits, 1); assert.equal(spend.usd, null);
      });
    }
    assert.equal(await attempts(engine), before + 1);
    assert.deepEqual(await scratch.getChunks(slug, { sourceId: 'default', includeEmbedding: true }), chunks);
    return { grounded_proposal: true, role_identity: role, auxiliary_spend_refused_before_inference: true,
      embeddings_unchanged: true, full_vector_stage_qualified: false,
      ...(role !== 'longmemeval-synopsis' ? { cache_replay_model_calls: 0 } : {}) };
  } finally { await scratch.disconnect(); }
}

async function nightly({ engine, root, models }: Context): Promise<Record<string, unknown>> {
  const { runEval } = await import('../src/core/cross-modal-eval/runner.ts');
  const { PROBE_QA_DIMENSIONS } = await import('../src/core/cycle/nightly-probe-adapters.ts');
  const receiptDir = join(root, 'nightly-judge'); await mkdir(receiptDir, { recursive: true, mode: 0o700 });
  const input = { task: 'Question: Where did Aster move? Expected answer: The coast.', output: 'The coast.',
    dimensions: PROBE_QA_DIMENSIONS, slots: [{ id: 'A', model: models.reasoning }], cycles: 1, receiptDir };
  const result = await runEval(input); assert.equal(result.finalAggregate.successes, 1);
  assert.equal(result.finalAggregate.failures, 0); assert.equal(result.finalAggregate.verdict, 'inconclusive');
  assert.equal(result.cycles[0]!.slots[0]!.ok, true);
  const count = await attempts(engine); const replay = await runEval(input);
  assert.equal(await attempts(engine), count); assert.deepEqual(replay.cycles[0]!.slots, result.cycles[0]!.slots);
  return { actual_nightly_judge_caller: true, valid_scored_slots: 1, panel_verdict: 'inconclusive',
    quorum_not_met: true, cache_replay_model_calls: 0, full_scheduled_probe_qualified: false,
    schedule_enabled: false };
}

export async function exerciseEvaluation(role: PrivateRole, context: Context): Promise<Record<string, unknown>> {
  if (role === 'calibration-think-ab') return ab(context);
  if (role === 'longmemeval-reader') return reader(context);
  if (role === 'longmemeval-judge') return judge(context);
  if (role === 'longmemeval-extractor') return extractor(context);
  if (role === 'nightly-probes') return nightly(context);
  if (role === 'longmemeval-synopsis' || role === 'longmemeval-fact-keys-paper' || role === 'longmemeval-fact-keys-production') return vectorProposal(role, context);
  throw new Error(`No evaluation case for ${role}`);
}
