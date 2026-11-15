/** Real workflow callers for operator-run synthetic acceptance. No injected model outputs. */
import { strict as assert } from 'node:assert';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PrivateRole, PrivateModelTier } from '../src/core/ai/private-roles.ts';

export const WORKFLOW_ROLES = ['patterns', 'parser-fallback', 'parser-polish', 'calibration-voice-judge',
  'take-grading', 'drift', 'contradiction-probe'] as const;

export async function exerciseWorkflow(role: PrivateRole, context: {
  engine: BrainEngine; root: string; sourceId: string; models: Record<PrivateModelTier, string>;
}): Promise<Record<string, unknown>> {
  const { engine, root, sourceId, models } = context;
  if (role === 'parser-fallback') {
    const { runLlmFallback } = await import('../src/core/conversation-parser/llm-fallback.ts');
    const opts = { engine, modelStr: models.utility, fallbackDate: '2026-06-02',
      body: 'Aster ⟿ 10:00 ⟿ Orbit launched.\nBirch ⟿ 10:01 ⟿ Confirmed launch.' };
    const messages = await runLlmFallback(opts);
    assert(messages, 'fallback must produce parsed messages');
    assert.deepEqual(messages.map(message => ({ ...message, timestamp: new Date(message.timestamp!).toISOString() })), [
      { speaker: 'Aster', timestamp: '2026-06-02T10:00:00.000Z', text: 'Orbit launched.' },
      { speaker: 'Birch', timestamp: '2026-06-02T10:01:00.000Z', text: 'Confirmed launch.' },
    ]);
    assert.deepEqual(await runLlmFallback(opts), messages);
    return { speakers_text_and_times_preserved: true, cached_replay_equal: true };
  }
  if (role === 'parser-polish') {
    const { polishConversation } = await import('../src/core/conversation-parser/llm-polish.ts');
    const parsed = { phase: 'regex_match' as const, matched_pattern_id: 'synthetic', messages: [
      { speaker: 'Aster', timestamp: '2026-06-02T10:00:00Z', text: 'Orbit  launched. The quote was "keep  this".' },
    ] };
    const before = structuredClone(parsed);
    const result = await polishConversation({ enabled: true, engine, parsed, model: models.utility });
    assert.deepEqual(parsed, before); assert.deepEqual(result.parsed, before);
    assert.equal(result.presentation.length, 1); assert.equal(result.presentation[0]!.message_index, 0);
    assert(result.presentation[0]!.prose.includes('"keep  this"'));
    return { canonical_evidence_unchanged: true, quoted_spacing_preserved: true, separate_presentation: true };
  }
  if (role === 'calibration-voice-judge') {
    const { defaultJudge, DEFAULT_RUBRICS } = await import('../src/core/calibration/voice-gate.ts');
    const result = await defaultJudge({ candidate: 'You called the orchard well: 4 of 5 forecasts held up.',
      mode: 'pattern_statement', rubric: DEFAULT_RUBRICS.pattern_statement });
    assert.equal(result.verdict, 'conversational'); assert(result.reason.trim().length > 0);
    return { plain_language_judgment: true, candidate_binding_validated: true };
  }
  if (role === 'take-grading') {
    const { defaultJudge } = await import('../src/core/cycle/grade-takes.ts');
    const page = await engine.putPage('notes/forecast', { type: 'note', title: 'Synthetic forecast',
      compiled_truth: 'Orbit launched in March 2026.' }, { sourceId });
    if (!(await engine.listTakes({ sourceId, page_slug: 'notes/forecast' })).length)
      await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Orbit will launch in March 2026.',
        kind: 'bet', holder: 'synthetic', since_date: '2026-01-01', weight: 0.8 }]);
    const [take] = await engine.listTakes({ sourceId, page_slug: 'notes/forecast' });
    const result = await defaultJudge({ take: take!, evidence: 'Confirmed on 2026-04-01: Orbit launched in March 2026.' });
    assert.equal(result.verdict, 'correct'); assert(result.confidence >= 0.5);
    return { supported_forecast_graded_correctly: true, evidence_quotes_validated: true };
  }
  if (role === 'drift') {
    const { defaultDriftJudge } = await import('../src/core/cycle/drift.ts');
    const result = await defaultDriftJudge({ candidate: { sourceId, takeId: 1, pageId: 1, pageSlug: 'notes/orchard',
      rowNum: 1, claim: 'The orchard has twelve apple trees.', weight: 0.8, recentEvidenceCount: 1 },
      evidence: 'Current verified count: the orchard has twelve apple trees. No trees were added or removed.' });
    assert.equal(result.drifted, false); assert(result.confidence >= 0.5);
    return { unchanged_claim_judged_correctly: true, evidence_quote_validated: true, advisory_only: true };
  }
  if (role === 'contradiction-probe') {
    const { judgeContradiction } = await import('../src/core/eval-contradictions/judge.ts');
    const result = await judgeContradiction({ model: models.utility, query: 'How many trees were in the orchard on 2026-06-01?',
      a: { slug: 'notes/count-a', text: 'The orchard contained exactly twelve trees on 2026-06-01.' },
      b: { slug: 'notes/count-b', text: 'The same orchard contained exactly twenty trees on 2026-06-01.' } });
    assert.equal(result.verdict.verdict, 'contradiction');
    return { same_time_incompatible_counts_detected: true, usage: result.usage };
  }
  assert.equal(role, 'patterns', 'unknown live workflow');
  const { runPhasePatterns } = await import('../src/core/cycle/patterns.ts');
  const { claimWorktree } = await import('../src/core/persistence/ownership.ts');
  const { disposePersistenceConsumer } = await import('../src/core/persistence/service.ts');
  const dir = join(root, 'managed-patterns');
  const patternSource = 'live-pattern-publication';
  const quote = 'Independent synthetic observations show that early review prevents rework.';
  await mkdir(dir, { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2) ON CONFLICT(id) DO NOTHING', [patternSource, dir]);
  for (const slug of ['reflections/one', 'reflections/two'])
    if (!await engine.getPage(slug, { sourceId: patternSource }))
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: quote }, { sourceId: patternSource });
  await engine.setConfig('dream.patterns.min_evidence', '2');
  await engine.setConfig('dream.patterns.source_slug_prefix', 'reflections');
  await engine.setConfig('dream.patterns.output_slug_prefix', 'patterns');
  await engine.setConfig('sync.write_through', 'true');
  await claimWorktree(engine, patternSource, dir);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  try {
    const result = await runPhasePatterns(engine, { sourceId: patternSource, brainDir: dir, once: true,
      dryRun: false, cycleDate: '2026-06-02' });
    assert.equal(result.status, 'ok'); assert(Number(result.details?.patterns_written) >= 1, JSON.stringify(result));
    const pages = await engine.executeRaw<{ id: number; slug: string; frontmatter: Record<string, unknown> }>(
      "SELECT id,slug,frontmatter FROM pages WHERE source_id=$1 AND slug LIKE 'patterns/%' AND deleted_at IS NULL", [patternSource]);
    assert(pages.length >= 1);
    for (const page of pages) {
      assert.equal(page.frontmatter.dream_generated, true);
      assert((await readFile(join(dir, page.slug + '.md'), 'utf8')).includes(quote));
      const edges = await engine.executeRaw("SELECT id FROM links WHERE link_source='codex-publication' AND from_page_id=$1", [page.id]);
      assert.equal(edges.length, 2);
    }
    const plans = await engine.executeRaw<{ state: string }>('SELECT state FROM codex_publication_plans WHERE source_id=$1', [patternSource]);
    const receipts = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE source_id=$1', [patternSource]);
    assert(plans.length > 0 && plans.every(plan => plan.state === 'complete'));
    assert(receipts.length > 0 && receipts.every(receipt => receipt.state === 'committed'));
    return { managed_pages_written: pages.length, files_and_database_agree: true, provenance_edges_preserved: true,
      publication_plans_complete: true, canonical_receipts_committed: true };
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  }
}
