/** Explicit live smoke cases through real callers, confined to a disposable synthetic brain.
 * This is operator-run acceptance, never part of automatic unit tests. No fixture
 * executable registration, API fallback, injected model output or counter reset.
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { WORKFLOW_ROLES, exerciseWorkflow } from './private-codex-live-workflows.ts';
import { CONTENT_ROLES, exerciseContent } from './private-codex-live-content.ts';

const args = process.argv.slice(2);
const value = (name: string) => args[args.indexOf(name) + 1];
if (args[0] !== '--live' || !args.includes('--root') || !args.includes('--roles')) {
  console.error('Usage: bun scripts/private-codex-live-acceptance.ts --live --root /private/disposable/root --roles role,role [--retry]');
  process.exit(2);
}
const root = value('--root')!;
assert(isAbsolute(root) && await realpath(root) === root, 'explicit canonical disposable root required');
assert.equal((await lstat(root)).mode & 0o077, 0, 'acceptance root must be private');
assert.equal(await readFile(join(root, '.gbrain-live-acceptance'), 'utf8'), 'synthetic-only-v1\n');
assert.equal(process.env.HOME, join(root, 'home'));
assert.equal(process.env.GBRAIN_HOME, join(root, 'home'));
assert.equal(process.env.CODEX_HOME, join(root, 'codex'));
assert(!process.env.DATABASE_URL && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY);

const { PRIVATE_GENERATION_ROLES, privateRoleTier } = await import('../src/core/ai/private-roles.ts');
type Role = typeof PRIVATE_GENERATION_ROLES[number][0];
const implemented = ['chat', 'query-expansion', 'ocr', 'facts', 'classifiers', 'page-summary', 'think', ...WORKFLOW_ROLES, ...CONTENT_ROLES] as const;
const selected = value('--roles')!.split(',') as Role[];
assert(selected.length > 0 && new Set(selected).size === selected.length);
assert(selected.every(role => (implemented as readonly string[]).includes(role)), 'role needs a real caller case before selection');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
  runId: string; deadline: string; maxAttempts: number; maxTurns: number; roles?: Role[];
};
const allowed = manifest.roles ?? selected;
assert(selected.every(role => allowed.includes(role)), 'selection must stay within the retained batch');
assert(allowed.every(role => (implemented as readonly string[]).includes(role)));
assert(!selected.includes('dream-synthesis') || allowed.includes('dream-triage'),
  'dream-synthesis also requires dream-triage in the retained batch');
assert(manifest.maxAttempts === 16 && manifest.maxTurns === 16);
const models = JSON.parse(await readFile(join(root, 'models.json'), 'utf8'));
const bin = '/usr/local/lib/gbrain-codex/50ed828f357c655a3c82054d346cab8434f24901f14ec19b8267571bdd008b38/codex';
const { validatePrivateCodexConfig } = await import('../src/core/ai/private-policy.ts');
const privateCodex = validatePrivateCodexConfig({ mode: 'strict', bin, models, enabled_roles: allowed });
assert(privateCodex);
await mkdir(join(root, 'home/.gbrain'), { recursive: true, mode: 0o700 });
await writeFile(join(root, 'home/.gbrain/config.json'), JSON.stringify({ embedding_disabled: true,
  embedding_dimensions: 1536, private_codex: privateCodex }), { mode: 0o600 });

const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { chat, expand, generateOcrText, configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { createSubscriptionRun } = await import('../src/core/ai/subscription-admission.ts');
const { withCodexSubscription } = await import('../src/core/ai/subscription-context.ts');
const { extractFactsFromTurnWithOutcome } = await import('../src/core/facts/extract.ts');
const { classifyAgainstCandidates } = await import('../src/core/facts/classify.ts');
const { generatePerChunkSynopsis } = await import('../src/core/page-summary.ts');
const { runThink } = await import('../src/core/think/index.ts');
const { disposePersistenceConsumer } = await import('../src/core/persistence/service.ts');
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('parent HTTP is forbidden in subscription-only acceptance'); }) as unknown as typeof fetch;
const engine = new PGLiteEngine();
const sourceId = 'live-acceptance-synthetic';
const orchard = 'The synthetic orchard has twelve apple trees.';
const launch = 'The synthetic Orbit project launched in March 2026.';
type Result = { role: Role; model: string; status: 'pass' | 'fail'; elapsedMs: number;
  evidence?: Record<string, unknown>; error?: { name: string; code?: string; reason?: string; validationCode?: string; message: string };
  attempts: unknown[]; sourceCommit: string; sourceTree: string; sourceDirty: boolean;
  trackedDiffSha256: string; harnessSha256: string };
const resultsPath = join(root, 'results.json');
let results: Result[] = [];
try { results = JSON.parse(await readFile(resultsPath, 'utf8')); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const { spawnSync } = await import('node:child_process');
function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: join(import.meta.dir, '..'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, 'source provenance must be readable');
  return result.stdout;
}
const sourceCommit = git('rev-parse', 'HEAD').trim();
const sourceTree = git('rev-parse', 'HEAD^{tree}').trim();
const sourceDirty = git('status', '--porcelain').length > 0;
const trackedDiffSha256 = createHash('sha256').update(git('diff', '--binary', 'HEAD')).digest('hex');
const harnessSha256 = createHash('sha256').update(await readFile(import.meta.path)).digest('hex');

async function exercise(role: Role): Promise<Record<string, unknown>> {
  if ((CONTENT_ROLES as readonly string[]).includes(role)) return exerciseContent(role, { engine, root, models });
  if ((WORKFLOW_ROLES as readonly string[]).includes(role)) return exerciseWorkflow(role, { engine, root, sourceId, models });
  if (role === 'chat') {
    const answer = await chat({ privateRole: role, messages: [{ role: 'user', content:
      'Synthetic acceptance: compute 7 + 5 and return only the integer.' }], timeoutMs: 90_000 });
    assert.equal(answer.text.trim(), '12'); assert.equal(answer.model, models.reasoning);
    assert.equal(answer.providerId, 'codex-cli'); assert.equal(answer.providerMetadata?.billing.costUsd, null);
    return { correct_answer: true, model: answer.model, usage: answer.usage, cost_usd: null };
  }
  if (role === 'query-expansion') {
    const queries = await expand('synthetic apple orchard pruning');
    assert.equal(queries[0], 'synthetic apple orchard pruning');
    assert(queries.length >= 2 && queries.length <= 5 && new Set(queries).size === queries.length);
    assert(queries.slice(1).every(query => /apple|orchard|prun/i.test(query)));
    return { distinct_grounded_queries: true, count: queries.length };
  }
  if (role === 'ocr') {
    const text = await generateOcrText(await readFile(join(root, 'orchard.png')), 'image/png');
    assert.equal(text.trim().replace(/\s+/g, ' '), 'ORCHARD 12');
    return { visible_text_exact: true };
  }
  if (role === 'facts') {
    const output = await extractFactsFromTurnWithOutcome({ turnText: orchard, source: sourceId,
      sessionId: 'synthetic-orchard-session', embedding: null, engine });
    assert(output.ok && output.facts.length >= 1, 'expected a grounded orchard fact');
    if (!output.ok) throw new Error('fact extraction failed');
    assert(output.facts.some(fact => /apple/i.test(fact.fact) && /twelve|12/.test(fact.fact)));
    assert(output.facts.every(fact => fact.source === sourceId && fact.source_session === 'synthetic-orchard-session' && fact.embedding === null));
    return { extracted_facts: output.facts.length, numeric_fact_preserved: true, host_provenance_preserved: true };
  }
  if (role === 'classifiers') {
    const result = await classifyAgainstCandidates({ fact: orchard, kind: 'fact', embedding: null },
      [{ id: 7, fact: orchard, kind: 'fact', embedding: null } as import('../src/core/engine.ts').FactRow]);
    assert.equal(result.decision, 'duplicate');
    if (result.decision === 'duplicate') assert.equal(result.matched_id, 7);
    assert.equal(result.reason, 'classifier');
    return { duplicate_id_preserved: true, classifier_used: true };
  }
  if (role === 'page-summary') {
    const result = await generatePerChunkSynopsis({ documentText: orchard, chunkText: orchard,
      pageTitle: 'Synthetic orchard', pageSlug: 'notes/orchard', sourceId, chunkIndex: 0 });
    assert.equal(result.kind, 'success');
    if (result.kind !== 'success') throw new Error('synopsis failed');
    assert(/apple|orchard/i.test(result.synopsis));
    return { grounded_synopsis: true, cache_hit: result.cacheHit ?? false };
  }
  const result = await runThink(engine, { question: 'When did the synthetic Orbit project launch?',
    anchor: 'notes/launch', sourceId, remote: false });
  assert.equal(result.synthesisOk, true); assert.equal(result.synthesis_status, 'ok');
  assert.equal(result.modelUsed, models.deep);
  assert(/March/i.test(result.answer));
  assert(result.citations.some(citation => citation.page_slug === 'notes/launch' && citation.row_num === 1));
  return { synthesis_ok: true, grounded_month: true, source_citation_preserved: true, model: result.modelUsed, usage: result.usage };
}

try {
  await engine.connect({ database_path: join(root, 'database') }); await engine.initSchema();
  configureGateway({ env: {}, embedding_dimensions: 1536 });
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [sourceId, 'Synthetic live acceptance']);
  if (!await engine.getPage('notes/launch', { sourceId })) {
    const page = await engine.putPage('notes/launch', { type: 'note', title: 'Synthetic Orbit', compiled_truth: launch }, { sourceId });
    await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: launch, kind: 'fact', holder: 'world', weight: 1 }]);
  }
  await createSubscriptionRun(engine, { runId: manifest.runId, accountLane: manifest.runId,
    maxAttempts: manifest.maxAttempts, maxTurns: manifest.maxTurns, deadline: new Date(manifest.deadline) });
  for (const role of selected) {
    if (results.some(row => row.role === role && row.status === 'pass')) continue;
    if (results.some(row => row.role === role && row.status === 'fail') && !args.includes('--retry')) throw new Error('explicit --retry required; original allowance is retained');
    const runId = `${manifest.runId}:${role}`;
    await createSubscriptionRun(engine, { runId, parentRunId: manifest.runId, accountLane: manifest.runId,
      maxAttempts: 2, maxTurns: 2, deadline: new Date(manifest.deadline) });
    const started = Date.now();
    const row: Result = { role, model: models[privateRoleTier(role)], status: 'fail', elapsedMs: 0,
      attempts: [], sourceCommit, sourceTree, sourceDirty, trackedDiffSha256, harnessSha256 };
    try {
      row.evidence = await withCodexSubscription({ engine, runId }, () => exercise(role));
      const [ledger] = await engine.executeRaw<{ attempts: number; accepted_turns: number }>(
        'SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [runId]);
      assert(Number(ledger!.attempts) >= 1 && Number(ledger!.accepted_turns) >= 1, 'a real accepted model turn is required');
      row.status = 'pass';
    } catch (error) {
      const e = error as Error & { code?: string; reason?: string; validationCode?: string };
      row.error = { name: e.name, code: e.code, reason: e.reason, validationCode: e.validationCode, message: e.message.slice(0, 500) };
    }
    row.elapsedMs = Date.now() - started;
    row.attempts = await engine.executeRaw('SELECT state,accepted,input_tokens,cached_input_tokens,output_tokens,failure_code FROM codex_subscription_attempts WHERE run_id=$1 ORDER BY created_at', [runId]);
    results.push(row); await writeFile(resultsPath, JSON.stringify(results, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(row));
    if (row.status !== 'pass') { process.exitCode = 1; break; }
  }
} finally {
  await disposePersistenceConsumer(engine); await engine.disconnect(); resetGateway(); globalThis.fetch = originalFetch;
}
// Engine shutdown may install its own exit handling; publish the acceptance
// verdict only after every owned resource has been closed.
process.exit(selected.some(role => results.findLast(row => row.role === role)?.status !== 'pass') ? 1 : 0);
