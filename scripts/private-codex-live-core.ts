/** Real core callers against isolated synthetic sources; never automatic CI or production. */
import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { PrivateRole, PrivateModelTier } from '../src/core/ai/private-roles.ts';
import { codexSubscriptionContext } from '../src/core/ai/subscription-context.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';

export const CORE_ROLES = ['take-proposals', 'take-calibration', 'contextual-synopsis', 'edge-contradictions', 'fence-repair'] as const;
type Context = { engine: BrainEngine; root: string; models: Record<PrivateModelTier, string> };
const logger = { info() {}, warn() {}, error() {} };
const operation = (engine: BrainEngine, sourceId: string): OperationContext => ({ engine, sourceId,
  config: { engine: 'pglite', embedding_disabled: true }, remote: false, dryRun: false, logger });
async function attempts(engine: BrainEngine): Promise<number> {
  const scope = codexSubscriptionContext(); assert(scope);
  const [row] = await engine.executeRaw<{ attempts: number }>('SELECT attempts FROM codex_subscription_runs WHERE run_id=$1', [scope.runId]);
  assert(row); return Number(row.attempts);
}
async function source(engine: BrainEngine, name: string, seed: (id: string) => Promise<void>, dir?: string) {
  const id = `live-core-${name}`;
  const [prior] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [id]);
  if (prior) assert.equal(prior.local_path, dir ?? null);
  else {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, dir ?? null]);
    await seed(id);
  }
  return id;
}

async function proposals({ engine, models }: Context): Promise<Record<string, unknown>> {
  const slug = 'notes/forecast', body = 'I bet the synthetic Orchard project will double its harvest by the end of 2027.';
  const sourceId = await source(engine, 'proposals', id => engine.putPage(slug,
    { type: 'note', title: 'Synthetic forecast', compiled_truth: body }, { sourceId: id }).then(() => {}));
  const { runPhaseProposeTakes } = await import('../src/core/cycle/propose-takes.ts');
  const run = () => runPhaseProposeTakes(operation(engine, sourceId), { once: true, pageLimit: 1 });
  const result = await run(); assert.equal(result.status, 'ok', JSON.stringify(result));
  const rows = () => engine.executeRaw<{ id: string; status: string; claim_text: string; model_id: string;
    codex_evidence: { source_quote: string; page_revision: string } }>(
    'SELECT id,status,claim_text,model_id,codex_evidence FROM take_proposals WHERE source_id=$1 AND page_slug=$2 ORDER BY id', [sourceId, slug]);
  const saved = await rows(); assert.equal(saved.length, 1);
  assert.equal(saved[0]!.status, 'pending'); assert.equal(saved[0]!.model_id, models.reasoning);
  assert(/2027/.test(saved[0]!.claim_text) && /doubl/i.test(saved[0]!.claim_text));
  assert(body.includes(saved[0]!.codex_evidence.source_quote)); assert(saved[0]!.codex_evidence.page_revision);
  assert.equal((await engine.listTakes({ sourceId, page_slug: slug })).length, 0, 'a proposal must not become a canonical take');
  const count = await attempts(engine), replay = await run();
  assert.equal(replay.status, 'ok'); assert.equal(replay.details?.cache_hits, 1); assert.equal(replay.details?.proposals_inserted, 0);
  assert.equal(await attempts(engine), count); assert.deepEqual(await rows(), saved);
  return { grounded_pending_proposal: true, source_revision_retained: true, canonical_takes_added: 0,
    cache_replay_model_calls: 0, duplicate_proposals: 0 };
}

async function calibration({ engine, models }: Context): Promise<Record<string, unknown>> {
  const holder = 'self';
  async function seed(id: string, slug: string, who: string, count: number, correct: number) {
    const page = await engine.putPage(slug, { type: 'note', title: 'Synthetic calibration', compiled_truth: 'Synthetic resolved forecasts.' }, { sourceId: id });
    for (let i = 0; i < count; i++) await engine.executeRaw(
      "INSERT INTO takes(page_id,row_num,claim,kind,holder,weight,resolved_at,resolved_quality,resolved_outcome) VALUES($1,$2,$3,'bet',$4,0.8,now(),$5,$6)",
      [page.id, i + 1, `Synthetic forecast ${i}`, who, i < correct ? 'correct' : 'incorrect', i < correct]);
  }
  const sourceId = await source(engine, 'calibration', async id => {
    await seed(id, 'notes/selected', holder, 5, 4);
    await seed(id, 'notes/other-holder', 'other-holder', 2, 0);
  });
  await source(engine, 'calibration-other-source', id => seed(id, 'notes/selected', holder, 2, 0));
  const { runPhaseCalibrationProfile } = await import('../src/core/cycle/calibration-profile.ts');
  const run = () => runPhaseCalibrationProfile(operation(engine, sourceId), { holder, gradeCompletion: 1 });
  const result = await run(); assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.details?.profiles_completed, 1);
  const rows = () => engine.executeRaw<{ id: string; published: boolean; total_resolved: number; voice_gate_passed: boolean;
    model_id: string; codex_evidence: { scorecard: { correct: number; incorrect: number }; snapshot_hash: string;
      facts: Array<{ id: string; quote: string }>; proposal: { patterns: Array<{ fact_id: string; statement: string }> } } }>(
    'SELECT id,published,total_resolved,voice_gate_passed,model_id,codex_evidence FROM calibration_profiles WHERE source_id=$1 AND holder=$2 ORDER BY id', [sourceId, holder]);
  const saved = await rows(); assert.equal(saved.length, 1); const profile = saved[0]!;
  assert.equal(profile.published, false); assert.equal(Number(profile.total_resolved), 5);
  assert.equal(profile.voice_gate_passed, true); assert.equal(profile.model_id, models.reasoning);
  assert.equal(Number(profile.codex_evidence.scorecard.correct), 4); assert.equal(Number(profile.codex_evidence.scorecard.incorrect), 1);
  assert.match(profile.codex_evidence.snapshot_hash, /^[a-f0-9]{64}$/);
  for (const pattern of profile.codex_evidence.proposal.patterns) {
    const fact = profile.codex_evidence.facts.find(fact => fact.id === pattern.fact_id); assert(fact);
    assert(pattern.statement.includes(fact.quote));
  }
  const count = await attempts(engine); assert.equal(count, 2, 'profile generation and its real voice judge each consume one turn');
  const replay = await run(); assert.equal(replay.status, 'ok'); assert.equal(replay.details?.profile_written, false);
  assert.equal(await attempts(engine), count); assert.deepEqual(await rows(), saved);
  return { source_and_holder_scoped: true, resolved_forecasts: 5, correct: 4, incorrect: 1,
    exact_metric_quotes_preserved: true, voice_gate_passed: true, published: false,
    profile_model: models.reasoning, voice_model: models.utility, cache_replay_model_calls: 0, duplicate_profiles: 0 };
}

async function contextual({ engine, models }: Context): Promise<Record<string, unknown>> {
  const slug = 'notes/contextual-orchard', body = 'The synthetic Orchard project launched in June 2026. Its first harvest contained twelve crates of apples.';
  const sourceId = await source(engine, 'contextual', async id => {
    const { importFromContent } = await import('../src/core/import-file.ts');
    await importFromContent(engine, slug, `---\ntype: note\ntitle: Synthetic Orchard launch\n---\n\n${body}`, { sourceId: id, noEmbed: true });
  });
  const chunks = await engine.getChunks(slug, { sourceId, includeEmbedding: true }); assert(chunks.length >= 1);
  const page = await engine.getPage(slug, { sourceId }); assert(page);
  const { reembedPageWithContextualRetrieval } = await import('../src/core/contextual-retrieval-service.ts');
  const before = await attempts(engine);
  await assert.rejects(reembedPageWithContextualRetrieval({ engine, sourceId, pageSlug: slug, globalMode: 'per_chunk_synopsis' }),
    { code: 'subscription_auxiliary_budget_required' });
  assert.equal(await attempts(engine), before, 'embedding refusal must precede any model call');
  const { generatePerChunkSynopsis } = await import('../src/core/page-summary.ts');
  const args = { privateRole: 'contextual-synopsis' as const, model: models.utility, sourceId, pageSlug: slug,
    documentText: body, chunkText: chunks[0]!.chunk_text, pageTitle: page.title, chunkIndex: 0 };
  const result = await generatePerChunkSynopsis(args); assert.equal(result.kind, 'success');
  if (result.kind !== 'success') throw new Error('contextual synopsis failed');
  assert(/Orchard/.test(result.synopsis) && /June|harvest|apples/.test(result.synopsis));
  const count = await attempts(engine), replay = await generatePerChunkSynopsis(args);
  assert.equal(replay.kind, 'success');
  if (replay.kind !== 'success') throw new Error('contextual synopsis replay failed');
  assert.equal(replay.cacheHit, true); assert.equal(replay.synopsis, result.synopsis); assert.equal(await attempts(engine), count);
  assert.deepEqual(await engine.getChunks(slug, { sourceId, includeEmbedding: true }), chunks);
  assert.equal((await engine.getPage(slug, { sourceId }))!.contextual_retrieval_mode, page.contextual_retrieval_mode);
  return { grounded_native_synopsis: true, role_identity: 'contextual-synopsis', cached_replay_equal: true,
    auxiliary_spend_refused_before_inference: true, embeddings_unchanged: true, full_reindex_qualified: false };
}

async function edges({ engine, root, models }: Context): Promise<Record<string, unknown>> {
  const subject = 'people/edge-aster';
  const sourceId = await source(engine, 'edges', async id => {
    const { operations } = await import('../src/core/operations.ts');
    const put = operations.find(op => op.name === 'put_page')!;
    for (const [slug, title, type, body] of [
      ['companies/edge-orchard', 'Edge Orchard', 'company', 'A synthetic company.'],
      ['companies/edge-meadow', 'Edge Meadow', 'company', 'Another synthetic company.'],
      [subject, 'Edge Aster', 'person', 'Aster works full-time at [Edge Orchard](../companies/edge-orchard) and [Edge Meadow](../companies/edge-meadow).\n\n## Timeline\n\n- **2019-02-01** | synthetic — joined [Edge Orchard](../companies/edge-orchard)\n- **2024-05-01** | synthetic — joined [Edge Meadow](../companies/edge-meadow)'],
    ]) await put.handler(operation(engine, id), { slug, content: `---\ntype: ${type}\ntitle: ${title}\n---\n\n${body}` });
  });
  const { runPhaseEdgeContradictions, loadEdgeContradictionsConfig } = await import('../src/core/cycle/edge-contradictions.ts');
  await engine.setConfig('dream.single_value.mode', 'off');
  assert.equal((await loadEdgeContradictionsConfig(engine, models.utility)).mode, 'propose');
  const page = await engine.getPage(subject, { sourceId }); assert(page);
  const relations = () => engine.executeRaw('SELECT to_page_id,link_type,valid_ranges::text FROM link_relationships WHERE source_id=$1 AND from_page_id=$2 ORDER BY to_page_id', [sourceId, page.id]);
  const originalRelations = await relations(); assert.equal(originalRelations.length, 2);
  const run = () => runPhaseEdgeContradictions(engine, { auditPath: join(root, 'edge-budget.jsonl') });
  const result = await run(); assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(result.totals?.proposed, 1); assert.equal(result.totals?.applied, 0);
  const rows = () => engine.executeRaw<{ id: string; status: string; model: string }>(
    'SELECT id,status,model FROM link_edge_proposals WHERE from_page_id=$1 ORDER BY id', [page.id]);
  const saved = await rows(); assert.equal(saved.length, 1); assert.equal(saved[0]!.status, 'proposed'); assert.equal(saved[0]!.model, models.utility);
  assert.equal((await engine.getPage(subject, { sourceId }))!.timeline, page.timeline);
  assert.deepEqual(await relations(), originalRelations);
  const count = await attempts(engine), replay = await run(); assert.equal(replay.status, 'complete'); assert.equal(replay.totals?.judged, 0);
  assert.equal(await attempts(engine), count); assert.deepEqual(await rows(), saved);
  return { conflicting_relationships_proposed: 1, default_mode: 'propose', timeline_and_relationships_unchanged: true,
    replay_model_calls: 0, duplicate_proposals: 0 };
}

async function fences({ engine, root }: Context): Promise<Record<string, unknown>> {
  const dir = join(root, 'managed-fence-repair'), slug = 'notes/fence', claim = 'Synthetic orchard ships quarterly';
  const row = `| 1 | ${claim} | fact | 0.9 | private | high | 2026-01-01 |  | chat | ctx |`;
  const body = `Intro.\n\n<!--- gbrain:facts:begin -->\n${row}\n<!--- gbrain:facts:end -->\n`;
  const { claimWorktree } = await import('../src/core/persistence/ownership.ts');
  const { disposePersistenceConsumer } = await import('../src/core/persistence/service.ts');
  const sourceId = await source(engine, 'fences', async id => {
    await mkdir(join(dir, 'notes'), { recursive: true, mode: 0o700 });
    const page = await engine.putPage(slug, { type: 'note', title: 'Synthetic fence', compiled_truth: body, timeline: '' }, { sourceId: id });
    await writeFile(join(dir, slug + '.md'), serializePageToMarkdown(page, []), { mode: 0o600, flag: 'wx' });
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
    git('init', '-q'); git('add', '--', 'notes/fence.md');
    git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic fixture');
    await writeFile(join(dir, '.git/hooks/post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n', { mode: 0o700 });
    await claimWorktree(engine, id, dir);
  }, dir);
  for (const [key, value] of Object.entries({ 'fences.repair.llm': 'true', 'fences.repair.max_usd_per_page': '0',
    'fences.repair.max_usd_per_day': '0', 'sync.write_through': 'true' })) await engine.setConfig(key, value);
  const { repairRunner } = await import('../src/core/repair/registry.ts');
  const { resolveRepairScope } = await import('../src/core/repair/core.ts');
  const { parseFactsFence } = await import('../src/core/facts-fence.ts');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  try {
    const run = async (apply: boolean, expect?: string) => (await repairRunner(engine, { apply, noEmbed: true, logger }))
      .run('fences', await resolveRepairScope(engine, sourceId), { explicit: true, sourceFlag: sourceId, only: [slug + '.md'], maxLlmUsd: 0, expect });
    const before = await attempts(engine), preview = await run(false);
    assert.equal(preview.affected, 1); assert(preview.preview_hash); assert.equal(await attempts(engine), before);
    const result = await run(true, preview.preview_hash); assert.deepEqual(result.failed, []); assert.equal(result.repaired, 1);
    assert.equal(result.cost.llm_usd, null);
    const page = await engine.getPage(slug, { sourceId }); assert(page);
    const file = parseMarkdown(await readFile(join(dir, slug + '.md'), 'utf8'), slug);
    assert.equal(file.compiled_truth.trim(), page.compiled_truth.trim());
    assert(page.compiled_truth.startsWith('Intro.'));
    const parsed = parseFactsFence(page.compiled_truth); assert.deepEqual(parsed.warnings, []); assert.equal(parsed.facts.length, 1);
    assert.equal(parsed.facts[0]!.claim, claim); assert.equal(parsed.facts[0]!.visibility, 'private'); assert.equal(parsed.facts[0]!.confidence, 0.9);
    const receipts = () => engine.executeRaw<{ id: string; state: string }>('SELECT id,state FROM persistence_requests WHERE source_id=$1 ORDER BY id', [sourceId]);
    const saved = await receipts(); assert(saved.length > 0 && saved.every(row => row.state === 'committed'));
    const count = await attempts(engine), replay = await run(true); assert.deepEqual(replay.failed, []); assert.equal(replay.repaired, 0);
    assert.equal(await attempts(engine), count); assert.deepEqual(await receipts(), saved);
    return { preview_bound_repair: true, claim_confidence_and_private_visibility_preserved: true,
      canonical_file_matches_database: true, receipts_committed: true, replay_model_calls: 0, duplicate_writes: 0 };
  } finally { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
}

export async function exerciseCore(role: PrivateRole, context: Context): Promise<Record<string, unknown>> {
  switch (role) {
    case 'take-proposals': return proposals(context);
    case 'take-calibration': return calibration(context);
    case 'contextual-synopsis': return contextual(context);
    case 'edge-contradictions': return edges(context);
    case 'fence-repair': return fences(context);
    default: throw new Error('unknown core acceptance role');
  }
}
