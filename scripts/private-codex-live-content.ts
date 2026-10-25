/** Operator-run synthetic content phases, using real discovery, models and managed writes. */
import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PrivateRole, PrivateModelTier } from '../src/core/ai/private-roles.ts';
import { codexSubscriptionContext } from '../src/core/ai/subscription-context.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';

export const CONTENT_ROLES = ['atoms', 'dream-triage', 'dream-synthesis', 'concepts', 'enrichment'] as const;
type Context = { engine: BrainEngine; root: string; models: Record<PrivateModelTier, string> };
const transcript = `User: I changed how I make decisions after reviewing the synthetic Orchard project.
Early review prevents rework by making uncertain assumptions explicit.
I used to treat a polished plan as evidence that the underlying assumptions were sound. That confused presentation quality with confidence in the facts.
Now I ask a colleague to name the weakest assumption before we commit to a plan. We record the evidence for that assumption and the observation that would make us change our minds.
This turns disagreement into a testable question instead of a contest over who sounds more certain. The point is to discover a cheap correction while changing direction is still easy.
I want to keep this practice: separate the proposed decision, the evidence supporting it, and the condition for revisiting it. A review is useful when it exposes uncertainty early, not when it merely approves the presentation.`;

async function attempts(engine: BrainEngine): Promise<number> {
  const scope = codexSubscriptionContext(); assert(scope);
  const [row] = await engine.executeRaw<{ attempts: number }>('SELECT attempts FROM codex_subscription_runs WHERE run_id=$1', [scope.runId]);
  assert(row); return Number(row.attempts);
}

async function source(context: Context, name: string, seed: (sourceId: string, dir: string) => Promise<void>) {
  const { engine, root } = context, sourceId = `live-content-${name}`, dir = join(root, sourceId);
  const [existing] = await engine.executeRaw<{ local_path: string }>('SELECT local_path FROM sources WHERE id=$1', [sourceId]);
  if (!existing) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, dir]);
    await seed(sourceId, dir);
    await claimWorktree(engine, sourceId, dir);
  } else assert.equal(existing.local_path, dir);
  await engine.setConfig('sync.write_through', 'true');
  return { sourceId, dir };
}

async function managed<T>(engine: BrainEngine, run: () => Promise<T>): Promise<T> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  try { return await run(); }
  finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  }
}

async function published(engine: BrainEngine, sourceId: string, dir: string, slugs: string[], storage: 'filesystem' | 'database' = 'filesystem') {
  assert(slugs.length > 0, 'at least one published page required');
  for (const slug of slugs) {
    const page = await engine.getPage(slug, { sourceId }); assert(page);
    if (storage === 'filesystem') {
      const file = parseMarkdown(await readFile(join(dir, slug + '.md'), 'utf8'), slug);
      assert.equal(file.compiled_truth.trim(), page.compiled_truth.trim(), 'canonical file must match database');
    } else {
      assert.equal(page.source_path ?? null, null, 'a new concept must retain its database-only storage');
      await assert.rejects(readFile(join(dir, slug + '.md')), { code: 'ENOENT' });
    }
  }
  const receipts = await engine.executeRaw<{ id: string; state: string; worktree_id: string | null }>(
    'SELECT id,state,worktree_id FROM persistence_requests WHERE source_id=$1 ORDER BY id', [sourceId]);
  assert(receipts.length > 0 && receipts.every(row => row.state === 'committed'), 'all canonical writes must be committed');
  assert(receipts.every(row => (row.worktree_id !== null) === (storage === 'filesystem')), 'receipts must use the expected storage mode');
  return receipts.map(row => row.id);
}

async function atoms(context: Context): Promise<Record<string, unknown>> {
  const { engine } = context;
  const { sourceId, dir } = await source(context, 'atoms', async id => {
    await engine.putPage('originals/review-practice', { type: 'original', title: 'Review practice',
      compiled_truth: transcript, frontmatter: { visibility: 'world' } }, { sourceId: id });
  });
  const { runPhaseExtractAtoms, discoverExtractablePages } = await import('../src/core/cycle/extract-atoms.ts');
  return managed(engine, async () => {
    const before = await discoverExtractablePages(engine, sourceId, ['originals/review-practice']);
    assert.equal(before.length, 1, 'normal discovery must select the seeded source');
    const run = () => runPhaseExtractAtoms(engine, { sourceId, brainDir: dir, affectedSlugs: ['originals/review-practice'] });
    const result = await run();
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert(Number(result.details?.atoms_extracted) >= 1, JSON.stringify(result));
    const pages = await engine.executeRaw<{ slug: string; frontmatter: Record<string, unknown> }>(
      "SELECT slug,frontmatter FROM pages WHERE source_id=$1 AND type='atom' AND deleted_at IS NULL ORDER BY slug", [sourceId]);
    assert(pages.length >= 1 && pages.length <= 3);
    for (const page of pages) {
      assert.equal(page.frontmatter.source_quote_verified, true);
      assert(typeof page.frontmatter.source_quote === 'string' && transcript.includes(page.frontmatter.source_quote));
    }
    const slugs = pages.map(page => page.slug), receipts = await published(engine, sourceId, dir, slugs), count = await attempts(engine);
    const replay = await run(); assert(['ok', 'skipped'].includes(replay.status), JSON.stringify(replay));
    assert.equal(await attempts(engine), count, 'unchanged atoms must not spend another model attempt');
    assert.deepEqual(await published(engine, sourceId, dir, slugs), receipts, 'replay must not duplicate writes');
    return { atoms_published: slugs.length, normal_page_discovery: true, verified_quotes: true,
      canonical_files_match: true, receipts_committed: true, replay_model_calls: 0, duplicate_writes: 0 };
  });
}

async function synthesisSetup(context: Context) {
  const { engine } = context;
  const fixture = await source(context, 'synthesis', async (_id, dir) => {
    await writeFile(join(dir, '2026-06-02-review.txt'), transcript, { mode: 0o600, flag: 'wx' });
  });
  for (const [key, value] of Object.entries({ 'dream.synthesize.enabled': 'true', 'dream.synthesize.min_chars': '0',
    'dream.synthesize.reflections_slug_prefix': 'reflections', 'dream.synthesize.originals_slug_prefix': 'originals',
    'dream.synthesize.output_root': 'wiki', 'dream.synthesize.max_submissions_per_source_per_day': '0' }))
    await engine.setConfig(key, value);
  return { ...fixture, file: join(fixture.dir, '2026-06-02-review.txt') };
}

async function triage(context: Context): Promise<Record<string, unknown>> {
  const { engine } = context, { file } = await synthesisSetup(context);
  const { runTriagePass, loadSynthConfig } = await import('../src/core/cycle/synthesize.ts');
  const { readSingleTranscript } = await import('../src/core/cycle/transcript-discovery.ts');
  const input = readSingleTranscript(file, { minChars: 0, excludePatterns: [] }); assert(input);
  const config = (await loadSynthConfig(engine)).triage;
  const result = await runTriagePass(engine, [input], config);
  assert.equal(result.unreliable, 0); assert.equal(result.deferred, 0); assert.equal(result.verdictCacheFailures.length, 0);
  assert.equal(result.reports[0]?.worth, true, JSON.stringify(result.reports));
  assert.equal(result.byPath.size, 1);
  const count = await attempts(engine), replay = await runTriagePass(engine, [input], config);
  assert.equal(replay.cacheHits, 1); assert.equal(replay.judged, 0); assert.equal(await attempts(engine), count);
  return { transcript_discovered: true, durable_signal_passed_gate: true, validated_verdict_cached: true,
    cache_replay_model_calls: 0, score: result.reports[0]!.score };
}

async function synthesis(context: Context): Promise<Record<string, unknown>> {
  const { engine } = context, { sourceId, dir, file } = await synthesisSetup(context);
  const { runPhaseSynthesize } = await import('../src/core/cycle/synthesize.ts');
  return managed(engine, async () => {
    const run = () => runPhaseSynthesize(engine, { sourceId, brainDir: dir, inputFile: file, once: true,
      dryRun: false, cycleDate: '2026-06-02' });
    const result = await run(); assert.equal(result.status, 'ok', JSON.stringify(result));
    assert(Number(result.details?.pages_written) >= 2, JSON.stringify(result));
    const pages = await engine.executeRaw<{ slug: string; frontmatter: Record<string, unknown> }>(
      'SELECT slug,frontmatter FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [sourceId]);
    assert(pages.some(page => page.slug.startsWith('reflections/') || page.slug.startsWith('originals/')));
    assert(pages.every(page => page.frontmatter.dream_generated === true && page.frontmatter.raw_source === file));
    const receipts = await published(engine, sourceId, dir, pages.map(page => page.slug));
    const plans = await engine.executeRaw<{ state: string }>('SELECT state FROM codex_publication_plans WHERE source_id=$1', [sourceId]);
    assert(plans.length > 0 && plans.every(plan => plan.state === 'complete'));
    const count = await attempts(engine), replay = await run();
    assert.equal(replay.status, 'ok'); assert.equal(replay.details?.already_synthesized, 1);
    assert.equal(await attempts(engine), count);
    assert.deepEqual(await published(engine, sourceId, dir, pages.map(page => page.slug)), receipts);
    return { pages_published_including_required_summary: pages.length, canonical_files_match: true,
      source_file_provenance_preserved: true, publication_plans_complete: true, replay_model_calls: 0, duplicate_writes: 0 };
  });
}

async function concepts(context: Context): Promise<Record<string, unknown>> {
  const { engine } = context, quote = 'Early review keeps decisions grounded in evidence.';
  const { sourceId, dir } = await source(context, 'concepts', async id => {
    for (const name of ['one', 'two', 'three', 'four', 'five'])
      await engine.putPage(`atoms/review-${name}`, { type: 'atom', title: `Review lesson ${name}`, compiled_truth: quote,
        frontmatter: { visibility: 'world', concepts: ['review-evidence'] } }, { sourceId: id });
  });
  const { runPhaseSynthesizeConcepts } = await import('../src/core/cycle/synthesize-concepts.ts');
  return managed(engine, async () => {
    const slug = 'concepts/review-evidence', prior = await engine.getPage(slug, { sourceId }), before = await attempts(engine);
    const run = () => runPhaseSynthesizeConcepts(engine, { sourceId, brainDir: dir });
    const result = await run(); assert.equal(result.status, 'ok', JSON.stringify(result));
    if (prior) {
      // A failed post-publication assertion may be resumed without spending
      // another turn or replacing the already accepted synthetic narrative.
      assert(before >= 1 && prior.frontmatter.synthesis_mode === 'llm');
      assert.deepEqual(result.details?.skipped_unchanged, [slug]);
      assert.equal(await attempts(engine), before);
    } else assert.equal((result.details?.synthesis_mode_counts as Record<string, unknown>)?.llm, 1);
    const page = await engine.getPage(slug, { sourceId }); assert(page);
    assert.equal(page.frontmatter.visibility, 'world'); assert(page.compiled_truth.includes('[Source: [[atoms/review-'));
    const links = await engine.getLinks(slug, { sourceId });
    assert.equal(links.filter(link => link.link_source === 'concept-provenance').length, 5);
    const receipts = await published(engine, sourceId, dir, [slug], 'database'), count = await attempts(engine);
    const replay = await run(); assert.deepEqual(replay.details?.skipped_unchanged, [slug]);
    assert.equal(await attempts(engine), count); assert.deepEqual(await published(engine, sourceId, dir, [slug], 'database'), receipts);
    return { concept_published: true, five_source_provenance_links: true, cited_evidence_validated: true,
      database_only_storage_preserved: true, receipts_committed: true, retained_publication: prior !== null,
      replay_model_calls: 0, duplicate_writes: 0 };
  });
}

async function enrichment(context: Context): Promise<Record<string, unknown>> {
  const { engine, models } = context, slug = 'people/aster-example';
  const { sourceId, dir } = await source(context, 'enrichment', async (id, path) => {
    const page = await engine.putPage(slug, { type: 'person', title: 'Aster Example', compiled_truth: 'Synthetic person stub.',
      frontmatter: { visibility: 'world' } }, { sourceId: id });
    // Seed both sides before claiming the synthetic worktree. A missing file
    // on an existing managed page correctly refuses enrichment publication.
    await mkdir(join(path, 'people'), { mode: 0o700 });
    await writeFile(join(path, slug + '.md'), serializePageToMarkdown(page, []), { mode: 0o600, flag: 'wx' });
    await engine.executeRaw('INSERT INTO facts(source_id,entity_slug,fact,source,valid_from) VALUES($1,$2,$3,$4,now())',
      [id, slug, 'Aster Example led the synthetic Orchard launch in 2026 and introduced early evidence reviews.', 'synthetic-acceptance']);
  });
  const input = await engine.getPage(slug, { sourceId }); assert(input);
  assert.equal(parseMarkdown(await readFile(join(dir, slug + '.md'), 'utf8'), slug).compiled_truth.trim(),
    input.compiled_truth.trim(), 'the synthetic enrichment input must match its canonical file before inference');
  const { runEnrichCore } = await import('../src/commands/enrich.ts');
  return managed(engine, async () => {
    const run = () => runEnrichCore(engine, { sourceId, model: models.reasoning, limit: 1, minContextChars: 20 });
    const result = await run(); assert.equal(result.pages_failed, 0, JSON.stringify(result));
    assert.equal(result.pages_enriched, 1, JSON.stringify(result));
    const page = await engine.getPage(slug, { sourceId }); assert(page);
    assert(page.compiled_truth.includes(`[Source: ${slug}]`)); assert(/Orchard/.test(page.compiled_truth));
    const receipts = await published(engine, sourceId, dir, [slug]), count = await attempts(engine);
    const replay = await run(); assert.equal(replay.pages_failed, 0); assert.equal(replay.pages_enriched, 0);
    assert.equal(await attempts(engine), count); assert.deepEqual(await published(engine, sourceId, dir, [slug]), receipts);
    return { enriched_page_published: true, supporting_fact_cited: true, canonical_files_match: true,
      receipts_committed: true, replay_model_calls: 0, duplicate_writes: 0 };
  });
}

export async function exerciseContent(role: PrivateRole, context: Context): Promise<Record<string, unknown>> {
  switch (role) {
    case 'atoms': return atoms(context);
    case 'dream-triage': return triage(context);
    case 'dream-synthesis': return synthesis(context);
    case 'concepts': return concepts(context);
    case 'enrichment': return enrichment(context);
    default: throw new Error('unknown content acceptance role');
  }
}
