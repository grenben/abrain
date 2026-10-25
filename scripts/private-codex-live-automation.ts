/** Bounded live automation cases. All pages/files belong to the disposable
 * acceptance root; provider output is real and never injected. These cases do
 * not qualify a full optimizer campaign, daemon lifecycle or production schedule. */
import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Trajectory } from '../src/core/skillopt/types.ts';
import { codexSubscriptionContext } from '../src/core/ai/subscription-context.ts';

export const AUTOMATION_ROLES = ['auto-think', 'iterative-minions', 'brainstorm', 'brainstorm-judge',
  'skillopt-judge', 'skillopt-optimizer', 'skillopt-bootstrap'] as const;
type Context = { engine: BrainEngine; root: string; models: Record<string, string> };
async function attempts(engine: BrainEngine): Promise<number> {
  const [row] = await engine.executeRaw<{ attempts: number }>('SELECT attempts FROM codex_subscription_runs WHERE run_id=$1', [codexSubscriptionContext()!.runId]);
  return Number(row!.attempts);
}
async function source(engine: BrainEngine, name: string, seed: (id: string) => Promise<void>): Promise<string> {
  const id = `live-automation-${name}`;
  const [existing] = await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [id]);
  if (!existing) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)', [id, `Synthetic automation ${name}`]);
    await seed(id);
  }
  return id;
}
async function importNote(engine: BrainEngine, sourceId: string, slug: string, title: string, body: string) {
  const { importFromContent } = await import('../src/core/import-file.ts');
  await importFromContent(engine, slug, `---\ntype: note\ntitle: ${title}\nvisibility: world\n---\n\n${body}`, { sourceId, noEmbed: true });
}

async function automaticThink({ engine, models }: Context): Promise<Record<string, unknown>> {
  const slug = 'notes/orchard-launch', body = 'The synthetic Orchard project launched in June 2026. Its first harvest contained twelve crates of apples.';
  const sourceId = await source(engine, 'think', async id => {
    await importNote(engine, id, slug, 'Synthetic Orchard launch', body);
    const page = await engine.getPage(slug, { sourceId: id }); assert(page);
    await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: body, kind: 'fact', holder: 'world', weight: 1 }]);
  });
  const { runPhaseAutoThink } = await import('../src/core/cycle/auto-think.ts');
  for (const [key, value] of Object.entries({ enabled: 'true', questions: JSON.stringify(['When did the synthetic Orchard project launch?']),
    max_per_cycle: '1', cooldown_days: '0', auto_commit: 'false', budget: '0' })) await engine.setConfig(`dream.auto_think.${key}`, value);
  const before = await attempts(engine);
  assert.equal((await runPhaseAutoThink(engine, { sourceId, dryRun: true })).status, 'skipped');
  assert.equal(await attempts(engine), before);
  const run = () => runPhaseAutoThink(engine, { sourceId, dryRun: false });
  const result = await run(); assert.equal(result.status, 'complete', JSON.stringify(result));
  const rows = () => engine.executeRaw<{ state: string; completed_at: unknown; results: Record<string, { state: string; slug?: string; result: { answer: string; citations: Array<{ page_slug: string }>; modelUsed: string } }> }>(
    'SELECT state,completed_at,results FROM codex_auto_think_runs WHERE run_id=$1', [codexSubscriptionContext()!.runId]);
  const saved = await rows(); assert.equal(saved.length, 1); assert.equal(saved[0]!.state, 'complete'); assert(saved[0]!.completed_at);
  const draft = saved[0]!.results['0']!; assert.equal(draft.state, 'complete'); assert.equal(draft.slug, undefined);
  assert(/June/.test(draft.result.answer) && /2026/.test(draft.result.answer)); assert.equal(draft.result.modelUsed, models.deep);
  assert(draft.result.citations.some(c => c.page_slug === slug));
  const count = await attempts(engine); assert.equal((await run()).status, 'complete');
  assert.equal(await attempts(engine), count); assert.deepEqual(await rows(), saved);
  return { real_automatic_phase: true, source_scoped_grounded_draft: true, completed_questions: 1,
    required_source_citation: true, auto_commit: false, replay_model_calls: 0, duplicate_batches: 0 };
}

async function actions({ engine }: Context): Promise<Record<string, unknown>> {
  const slug = 'notes/dispatch', code = 'ORCHARD-731';
  const sourceId = await source(engine, 'actions', async id => {
    await importNote(engine, id, slug, 'Synthetic dispatch', `The synthetic dispatch reference is ${code}.`);
    await engine.putPage('notes/private', { type: 'note', title: 'Private synthetic decoy', compiled_truth: 'PRIVATE_SYNTHETIC_DECOY', frontmatter: { visibility: 'private' } }, { sourceId: id });
  });
  const { MinionQueue } = await import('../src/core/minions/queue.ts');
  const { makeSubagentHandler } = await import('../src/core/minions/handlers/subagent.ts');
  const { buildJobContext } = await import('../src/core/minions/job-context.ts');
  const { runWithJobSpend } = await import('../src/core/minions/spend-authorization.ts');
  const { CODEX_READ_PROTOCOL } = await import('../src/core/minions/codex-action-contract.ts');
  const host = codexSubscriptionContext()!, queue = new MinionQueue(engine);
  const data = { action_protocol: CODEX_READ_PROTOCOL, prompt: `Read ${slug} exactly once. Then return only the dispatch reference found on that page. Do not guess or read other pages.`,
    source_id: sourceId, allowed_tools: ['get_page'], allowed_slug_prefixes: ['notes/dispatch'], max_turns: 2, no_self_fix: true };
  const found = await engine.executeRaw<{ id: number }>("SELECT id FROM minion_jobs WHERE name='subagent' AND data->>'source_id'=$1", [sourceId]);
  assert(found.length <= 1);
  let job = found.length ? (await queue.getJob(Number(found[0]!.id)))! : await queue.add('subagent', data, { max_attempts: 1 }, {
    allowProtectedSubmit: true, codexSubscription: { parentRunId: host.runId, maxAttempts: 2, maxTurns: 2,
      deadline: new Date((await engine.executeRaw<{ deadline: string }>('SELECT deadline FROM codex_subscription_runs WHERE run_id=$1', [host.runId]))[0]!.deadline) } });
  if (job.status !== 'completed') {
    if (job.status !== 'active') { const claimed = await queue.claim('live-acceptance', 600000, sourceId, ['subagent']); assert.equal(claimed?.id, job.id); job = claimed!; }
    assert(job.lock_token);
    const ctx = buildJobContext(engine, queue, job, job.lock_token!, new AbortController().signal, new AbortController().signal);
    const handler = makeSubagentHandler({ engine, makeAnthropic: () => { throw new Error('API client forbidden in subscription acceptance'); } });
    const run = () => runWithJobSpend(engine, job, ctx, () => handler(ctx));
    const result = await run(); assert.equal(result.stop_reason, 'end_turn'); assert.equal(result.result, code);
    const count = await attempts(engine); assert.deepEqual(await run(), result); assert.equal(await attempts(engine), count);
    const completed = await queue.completeJob(job.id, job.lock_token!, { ...result }); assert.equal(completed?.status, 'completed'); job = completed!;
  }
  assert.equal(job.result?.result, code); assert.equal(job.result?.cost_usd, null); assert.equal(job.result?.pages_written, 0);
  const tools = await engine.executeRaw<{ status: string; input: unknown }>('SELECT status,input FROM subagent_tool_executions WHERE job_id=$1 ORDER BY message_idx', [job.id]);
  assert.equal(tools.length, 1); assert.equal(tools[0]!.status, 'complete'); assert.deepEqual(tools[0]!.input, { slug });
  assert.equal(await attempts(engine), 2);
  return { actual_queue_claim_and_handler: true, durable_read_actions: 1, grounded_final_reference: true, completed_job: true,
    source_and_prefix_bound: true, pages_written: 0, replay_model_calls: 0, provider_calls: 2,
    daemon_process_lifecycle_qualified: false, write_action_qualified: false };
}

async function brainstorm({ engine, models }: Context): Promise<Record<string, unknown>> {
  const bodies = { 'notes/orchard-harvest': 'Orchard harvest planning uses weekly ripeness checks and staged picking to reduce spoilage.',
    'concepts/feedback': 'Feedback control compares measured output with a target and adjusts the next action to reduce the error.' };
  const sourceId = await source(engine, 'brainstorm', async id => {
    for (const [slug, body] of Object.entries(bodies)) await importNote(engine, id, slug, slug, body);
  });
  const { runBrainstorm, BRAINSTORM_PROFILE } = await import('../src/core/brainstorm/orchestrator.ts');
  const options = { question: 'Orchard harvest planning: how can feedback control improve staged picking?', sourceId,
    profile: { ...BRAINSTORM_PROFILE, k_close: 1, m_far: 1, ideas_per_cross: 1 }, modelOverride: models.deep, judgeModel: models.utility };
  const run = () => runBrainstorm(engine, {}, options);
  const result = await run(); assert.equal(result.generation_status, 'complete'); assert.equal(result.judge_failed, false);
  assert.equal(result.ideas.length, 1); assert.equal(result.close_set.length, 1); assert.equal(result.far_set.length, 1);
  const idea = result.ideas[0]!; assert.equal(idea.evidence?.length, 2); assert(idea.judge);
  for (const evidence of idea.evidence!) {
    assert.equal(evidence.source_id, sourceId); assert(evidence.revision);
    assert(bodies[evidence.slug as keyof typeof bodies].includes(evidence.quote));
  }
  assert(/harvest|pick|ripeness/i.test(idea.text) && /feedback|control|adjust|target|error/i.test(idea.text));
  assert.equal(idea.passes, idea.judge.passes); assert.equal(result.cost.actual_usd, null);
  const count = await attempts(engine); assert.equal(count, 2); assert.deepEqual(await run(), result); assert.equal(await attempts(engine), count);
  return { real_retrieval_cross_and_judge: true, generated_ideas: 1, exact_source_quotes: 2, judge_pass_count: idea.passes ? 1 : 0,
    generator_model: models.deep, judge_model: models.utility, retained_result_replay_model_calls: 0, published: false };
}

async function brainstormJudge({ engine, models }: Context): Promise<Record<string, unknown>> {
  const { runJudge, BRAINSTORM_JUDGE_CONFIG } = await import('../src/core/brainstorm/judges.ts');
  const ideas = [{ id: 'harvest-check', text: 'Compare measured apple ripeness with the picking target each week, then adjust the next picking batch to reduce spoilage.',
    close_slug: 'notes/orchard-harvest', far_slug: 'concepts/feedback' }];
  const run = () => runJudge(BRAINSTORM_JUDGE_CONFIG, ideas, { modelOverride: models.utility });
  const result = await run(); assert.equal(result.model, models.utility); assert.equal(result.ideas.length, 1);
  const judged = result.ideas[0]!; assert.equal(judged.id, ideas[0]!.id); assert(judged.note.trim());
  const scores = Object.values(judged.scores); assert.equal(scores.length, 5); assert(scores.every(s => s >= 1 && s <= 5));
  assert.equal(judged.passes, judged.weighted_score >= BRAINSTORM_JUDGE_CONFIG.threshold);
  assert.equal(result.pass_count, Number(judged.passes)); assert.equal(result.billing?.costUsd, null);
  const count = await attempts(engine), replay = await run(); assert.equal(replay.cache_hits, 1);
  assert.deepEqual(replay.ideas, result.ideas); assert.equal(await attempts(engine), count);
  return { exact_idea_id_coverage: true, bounded_axis_scores: true, host_threshold_verdict: true,
    pass_count: result.pass_count, cache_replay_model_calls: 0 };
}

function trajectory(final_text = '15'): Trajectory {
  return { task_id: 'synthetic-addition', task: 'Add twelve crates and three crates. Return only the total number of crates.', final_text,
    tool_calls: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, turns: 1, stop_reason: 'end', duration_ms: 0 };
}
async function skillJudge({ engine, models }: Context): Promise<Record<string, unknown>> {
  const { scoreTrajectory } = await import('../src/core/skillopt/score.ts');
  const input = trajectory(), judge = { kind: 'llm' as const, rubric: 'Score 1 if the answer is exactly the correct sum 15, and 0 otherwise. This is an arithmetic correctness check.' };
  const run = () => scoreTrajectory(input, judge, { judgeModel: models.reasoning });
  const result = await run(); assert.equal(result.judge_error, undefined); assert.equal(result.score, 1);
  assert(result.judge_evidence_quote && input.final_text.includes(result.judge_evidence_quote)); assert.equal(result.judge_billing?.costUsd, null);
  const count = await attempts(engine), replay = await run(); assert.equal(replay.judge_cache_hit, true);
  assert.equal(replay.score, result.score); assert.equal(await attempts(engine), count);
  return { real_trajectory_scorer: true, correct_score: 1, exact_evidence_quote: true, cache_replay_model_calls: 0,
    fixture_trajectory_not_model_rollout: true };
}
async function optimizer({ engine, models }: Context): Promise<Record<string, unknown>> {
  const { runReflect } = await import('../src/core/skillopt/reflect.ts');
  const { applyEditBatch } = await import('../src/core/skillopt/apply-edits.ts');
  const body = '# Method\n\nWhen asked to add two counts, concatenate the digits.\n';
  const frontmatter = '---\nname: synthetic-addition\ndescription: Add synthetic counts.\n---\n';
  const options = { skillBodyText: body, optimizerModel: models.deep, successes: [], failures: [{ trajectory: trajectory('123'), score: 0 }],
    rejected: [], criteria: 'Correct arithmetic: adding twelve and three must yield fifteen. Replace the faulty concatenation rule with numerical addition.', maxTokens: 2048 };
  const result = await runReflect(options); assert.equal(result.calls, 1); assert(result.failureEdits.length >= 1); assert.equal(result.successEdits.length, 0);
  const applied = applyEditBatch(frontmatter + body, result.failureEdits, result.failureEdits.length);
  assert(applied.results.every(r => r.outcome === 'applied')); assert(applied.newText.startsWith(frontmatter));
  assert.notEqual(applied.newText, frontmatter + body); assert(/sum|addition|numerical|arithmet|numeric/i.test(applied.newText));
  assert.equal(result.billing?.costUsd, null);
  const count = await attempts(engine), replay = await runReflect(options);
  assert.equal(replay.cacheHits, 1); assert.deepEqual(replay.failureEdits, result.failureEdits); assert.equal(await attempts(engine), count);
  return { real_failure_reflection: true, valid_body_edits: result.failureEdits.length, frontmatter_preserved: true,
    arithmetic_correction_proposed: true, cache_replay_model_calls: 0, installed_skill_changed: false,
    full_optimizer_campaign_qualified: false, fixture_trajectory_not_model_rollout: true };
}
async function bootstrap({ engine, root, models }: Context): Promise<Record<string, unknown>> {
  const { runBootstrapFromSkill } = await import('../src/core/skillopt/bootstrap-benchmark.ts');
  const { loadBenchmark } = await import('../src/core/skillopt/benchmark.ts');
  const { BOOTSTRAP_PENDING_REVIEW } = await import('../src/core/skillopt/types.ts');
  const skillsDir = join(root, 'synthetic-bootstrap'), skillName = 'synthetic-addition', dir = join(skillsDir, skillName);
  const text = '---\nname: synthetic-addition\ndescription: Add two counts.\n---\n# Method\n\nReturn the arithmetic sum of two supplied nonnegative integers as digits only. Never concatenate the digits.\n';
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'SKILL.md');
  try { await writeFile(path, text, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  assert.equal(await readFile(path, 'utf8'), text);
  const options = { skillsDir, skillName, optimizerModel: models.deep, taskCount: 2, force: true };
  const result = await runBootstrapFromSkill(options); assert.equal(result.rowsGenerated, 2); assert.equal(result.rowsSkipped, 0);
  assert.equal(result.billing?.costUsd, null); assert.equal(result.outputPath, join(dir, 'skillopt-benchmark.jsonl'));
  const output = await readFile(result.outputPath, 'utf8'); assert(output.includes(BOOTSTRAP_PENDING_REVIEW));
  assert.throws(() => loadBenchmark(result.outputPath));
  // Inspection opts into parsing a draft; it never removes the review marker or executes tasks.
  const tasks = loadBenchmark(result.outputPath, { bootstrapReviewed: true }).tasks;
  assert.deepEqual(tasks.map(t => t.task_id), ['synthetic-addition-001', 'synthetic-addition-002']);
  assert.equal((await stat(result.outputPath)).mode & 0o777, 0o600);
  const count = await attempts(engine), replay = await runBootstrapFromSkill(options); assert.equal(replay.cacheHit, true);
  assert.equal(await attempts(engine), count); assert.equal(await readFile(result.outputPath, 'utf8'), output);
  assert.equal(await readFile(path, 'utf8'), text); assert.throws(() => loadBenchmark(result.outputPath));
  return { actual_bootstrap_draft_writer: true, generated_tasks: 2, host_assigned_ids: true, owner_only_draft: true,
    review_marker_retained: true, unreviewed_execution_refused: true, installed_skill_changed: false, cache_replay_model_calls: 0 };
}
export async function exerciseAutomation(role: string, ctx: Context): Promise<Record<string, unknown>> {
  switch (role) {
    case 'auto-think': return automaticThink(ctx);
    case 'iterative-minions': return actions(ctx);
    case 'brainstorm': return brainstorm(ctx);
    case 'brainstorm-judge': return brainstormJudge(ctx);
    case 'skillopt-judge': return skillJudge(ctx);
    case 'skillopt-optimizer': return optimizer(ctx);
    case 'skillopt-bootstrap': return bootstrap(ctx);
    default: throw new Error('unsupported automation acceptance role');
  }
}
