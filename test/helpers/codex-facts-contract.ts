import { withCodexRoleFixture } from './codex-role-fixture.ts';
import { generatePerChunkSynopsis } from '../../src/core/page-summary.ts';
import { runPhaseGradeTakes, defaultJudge } from '../../src/core/cycle/grade-takes.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { upsertExtractRollup } from '../../src/core/extract/rollup-writer.ts';
import { runExtractStatus } from '../../src/commands/extract-status.ts';
import { computeExtractHealthCheck } from '../../src/commands/doctor/checks/extraction-sync.ts';
import { resolveExtractAtomsCostGate } from '../../src/core/cycle/extract-atoms-cost-gate.ts';
import { beforeAll, afterAll, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription, type CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { extractFactsFromTurn, extractFactsFromTurnWithOutcome } from '../../src/core/facts/extract.ts';
import { classifyAgainstCandidates } from '../../src/core/facts/classify.ts';
import type { FactRow } from '../../src/core/engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';

export function codexFactsContract(createEngine: () => Promise<{ engine: BrainEngine; cleanup?: () => Promise<void> }>) {
const root = mkdtempSync(join(tmpdir(), 'codex-facts-')), bin = join(root, 'fixture.mjs');
const capture = join(root, 'calls.jsonl'), control = join(root, 'response.json');
const keys = ['HOME', 'GBRAIN_HOME', 'CODEX_HOME'] as const;
const saved = keys.map(k => [k, process.env[k]] as const), originalFetch = globalThis.fetch;
let cleanup: (() => Promise<void>) | undefined;
let engine: BrainEngine, unregister: () => void, seq = 0;
const source = 'The synthetic orchard has twelve apple trees.';
const extraction = () => ({ turnText: source, source: 'fixture-source', sessionId: 'fixture-session', embedding: null, engine } as const);
const fact = { fact: source, kind: 'fact', entity: null, confidence: 0.9, notability: 'high',
  metric: null, value: null, unit: null, period: null, source_quote: source };
const candidate = { id: 7, fact: 'The synthetic orchard has ten apple trees.', kind: 'fact', embedding: null } as FactRow;
function reply(value: unknown) { writeFileSync(control, JSON.stringify(value)); }
const run = async <T>(fn: (runId: string) => Promise<T>, maxCalls = 2, hooks: Partial<CodexSubscriptionContext> = {}) => {
  const runId = `facts-${seq++}`;
  await createSubscriptionRun(engine, { runId, accountLane: runId, maxAttempts: maxCalls, maxTurns: maxCalls, deadline: new Date(Date.now() + 600_000) });
  return withCodexSubscription({ engine, runId, ...hooks }, () => fn(runId));
};
beforeAll(async () => {
  for (const k of keys) process.env[k] = root;
  globalThis.fetch = (() => { throw new Error('forbidden network'); }) as unknown as typeof fetch;
  mkdirSync(join(root, '.gbrain'));
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ private_codex: { mode: 'strict', model: 'codex-cli:gpt-test', bin } }));
  const script = `#!${Bun.which('node')}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1];
const schema=JSON.parse(readFileSync(arg('--output-schema'),'utf8')),prompt=readFileSync(0,'utf8');
appendFileSync(${JSON.stringify(capture)},JSON.stringify({schema,prompt})+'\\n');
const value=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
if(value.facts)for(const f of value.facts)for(const k of schema.properties.facts.items.required)if(!(k in f))f[k]=null;
const text=JSON.stringify({...(schema.properties.evidence_hash?{evidence_hash:schema.properties.evidence_hash.enum[0]}:{}),...value});writeFileSync(arg('--output-last-message'),text);
for(const event of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:4}}])console.log(JSON.stringify(event));
`;
  writeFileSync(bin, script, { mode: 0o700 }); unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(script).digest('hex'));
  ({ engine, cleanup } = await createEngine()); await engine.initSchema(); configureGateway({ env: {} });
});
afterAll(async () => {
  await engine?.disconnect(); await cleanup?.(); unregister?.(); resetGateway(); globalThis.fetch = originalFetch;
  for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(root, { recursive: true, force: true });
});

  withCodexRoleFixture(root, ['facts', 'classifiers', 'atoms', 'take-grading', 'page-summary'], () => {
test('native fact schema preserves host provenance and bounds candidates before acceptance', async () => {
  reply({ facts: [fact] });
  await run(async runId => {
    const result = await extractFactsFromTurnWithOutcome(extraction());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.facts[0]).toMatchObject({ fact: source, source: 'fixture-source', source_session: 'fixture-session', embedding: null });
    const rows = await engine.executeRaw<{accepted_turns:number}>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [runId]);
    expect(Number(rows[0]!.accepted_turns)).toBe(1);
  });
  const wire = JSON.parse(readFileSync(capture, 'utf8').trim().split('\n').at(-1)!);
  expect(wire.schema.properties.facts.maxItems).toBe(10);
  expect(wire.schema.properties.facts.items.required).toContain('source_quote');
});
test.each([
  { ...fact, source_quote: 'invented evidence' }, { ...fact, confidence: 9 },
  { ...fact, valid_from: '2026-02-30' }, { ...fact, value: 12, metric: null },
])('invalid fact proposal cannot count as an accepted turn or valid empty output', async bad => {
  reply({ facts: [bad] });
  await run(async runId => {
    const result = await extractFactsFromTurnWithOutcome(extraction());
    expect(result.ok).toBe(false);
    const rows = await engine.executeRaw<{accepted_turns:number;attempts:number}>('SELECT accepted_turns,attempts FROM codex_subscription_runs WHERE run_id=$1', [runId]);
    expect(Number(rows[0]!.accepted_turns)).toBe(0); expect(Number(rows[0]!.attempts)).toBe(1);
  });
  await run(async () => { await expect(extractFactsFromTurn(extraction())).rejects.toMatchObject({ name: 'FactsExtractionError' }); });
});
test('a valid empty facts array remains a successful result', async () => {
  reply({ facts: [] });
  expect(await run(() => extractFactsFromTurnWithOutcome(extraction()))).toEqual({ ok: true, facts: [] });
});
test('private classifier uses authorized candidate identities and propagates failures', async () => {
  for (const decision of ['duplicate', 'supersede', 'independent'] as const) {
    reply({ decision, matched_id: decision === 'independent' ? null : 7 });
    const result = await run(() => classifyAgainstCandidates({ fact: source, kind: 'fact', embedding: null }, [candidate]));
    expect(result.decision).toBe(decision); expect(result.reason).toBe('classifier');
  }
  for (const value of [{ decision: 'duplicate', matched_id: 999 }, { decision: 'independent', matched_id: 7 }]) {
    reply(value);
    await run(async runId => {
      await expect(classifyAgainstCandidates({ fact: source, kind: 'fact', embedding: null }, [candidate])).rejects.toMatchObject({ reason: 'invalid_output' });
      const rows = await engine.executeRaw<{accepted_turns:number}>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [runId]);
      expect(Number(rows[0]!.accepted_turns)).toBe(0);
    });
  }
});

test('private atom failures never become content strikes or tombstones', async () => {
  const atom = { title: 'Synthetic orchard', atom_type: 'quote', body: source, source_quote: 'made up quotation',
    lesson: null, concepts: null, virality_score: null, emotional_register: null };
  reply({ atoms: [atom] });
  for (let i = 0; i < 4; i++) await run(async runId => {
    const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [],
      _transcripts: [{ filePath: '/synthetic/2026-01-01-invalid.txt', content: source, contentHash: 'b'.repeat(64) }] });
    expect(result.status).toBe('warn');
    expect(result.details?.tombstoned_transcripts).toEqual([]);
    expect(result.details?.atoms_extracted).toBe(0);
    expect(result.details?.estimated_spend_usd).toBeNull();
    const accepted = await engine.executeRaw<{accepted_turns:number}>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [runId]);
    expect(Number(accepted[0]!.accepted_turns)).toBe(0);
  });
  const state = await engine.executeRaw('SELECT * FROM extract_atoms_transcript_state WHERE file_path=$1', ['/synthetic/2026-01-01-invalid.txt']);
  expect(state).toHaveLength(0);
});
test('private atom publication preserves verified quotes and an explicit empty completion', async () => {
  reply({ atoms: [{ title: 'Synthetic orchard fact', atom_type: 'insight', body: source, source_quote: source,
    lesson: null, concepts: null, virality_score: null, emotional_register: null }] });
  const extract = (path: string, hash: string) => runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [],
    _transcripts: [{ filePath: path, content: source, contentHash: hash.repeat(64) }] });
  const result = await run(() => extract('/synthetic/2026-01-01-valid.txt', 'c'));
  expect(result.details?.atoms_extracted).toBe(1);
  const rows = await engine.executeRaw<{frontmatter:Record<string,unknown>}>("SELECT frontmatter FROM pages WHERE type='atom' AND source_id='default' AND deleted_at IS NULL");
  expect(rows).toHaveLength(1); expect(rows[0]!.frontmatter.source_quote_verified).toBe(true);
  expect(rows[0]!.frontmatter.source_quote).toBe(source);
  reply({ atoms: [] });
  const empty = await run(() => extract('/synthetic/2026-01-01-empty.txt', 'd'));
  expect(empty.details?.atoms_extracted).toBe(0); expect(empty.details?.failures).toEqual([]);
  const calls = readFileSync(capture, 'utf8');
  await run(() => extract('/synthetic/2026-01-01-empty.txt', 'd'));
  expect(readFileSync(capture, 'utf8')).toBe(calls);
});
test('subscription rollups retain unknown totals alongside independent paid API subtotals', async () => {
  await engine.executeRaw("DELETE FROM extract_rollup_7d WHERE kind='atoms'");
  expect(await upsertExtractRollup(engine, { kind: 'atoms', source_id: 'default', cost_delta: 0.25, subscription: true })).toEqual({ ok: true });
  expect(await upsertExtractRollup(engine, { kind: 'atoms', source_id: 'default', cost_delta: 0.5 })).toEqual({ ok: true });
  const logs: string[] = [], originalLog = console.log;
  try {
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    await runExtractStatus(engine, ['--json', '--kind', 'atoms']);
    expect(JSON.parse(logs.at(-1)!).rows[0]).toMatchObject({ cost_7d_usd: null, api_metered_cost_7d_usd: 0.75, subscription_run_count: 1 });
    await runExtractStatus(engine, ['--kind', 'atoms']);
    expect(logs.at(-1)).toContain('unknown');
  } finally { console.log = originalLog; }
  const health = await computeExtractHealthCheck(engine);
  expect((health.details?.kinds as Array<unknown>)[0]).toMatchObject({ cost_7d_usd: null, api_metered_cost_7d_usd: 0.75, subscription_run_count: 1 });
});
test('subscription atom admission preserves the separate embedding price guard', () => {
  expect(resolveExtractAtomsCostGate('codex-cli:gpt-test', null, undefined, { subscription: true })).toEqual({ enforceCap: true });
  expect(resolveExtractAtomsCostGate('codex-cli:gpt-test', 'unknown:embedding', undefined, { subscription: true }).refusal).toBeDefined();
  expect(resolveExtractAtomsCostGate('codex-cli:gpt-test', null, undefined, { explicitBudget: true }).refusal).toBeDefined();
});
test('conflicting atom pins fail before dispatch and do not consume attempts', async () => {
  const before = readFileSync(capture, 'utf8');
  await engine.setConfig('models.dream.extract_atoms', 'anthropic:forbidden');
  try {
    await run(async runId => {
      await expect(runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [],
        _transcripts: [{ filePath: '/synthetic/conflict.txt', content: source, contentHash: 'f'.repeat(64) }] })).rejects.toMatchObject({ name: 'PrivateRoutingError' });
      const rows = await engine.executeRaw<{attempts:number}>('SELECT attempts FROM codex_subscription_runs WHERE run_id=$1', [runId]);
      expect(Number(rows[0]!.attempts)).toBe(0);
    });
  } finally { await engine.unsetConfig('models.dream.extract_atoms'); }
  expect(readFileSync(capture, 'utf8')).toBe(before);
});

// Source/quote tests do not catch a tier edit in the asynchronous publication fence.
test('atom publication rolls back when the host changes policy after model acceptance', async () => {
  reply({ atoms: [{ title: 'Policy fenced atom', atom_type: 'insight', body: source, source_quote: source,
    lesson: null, concepts: null, virality_score: null, emotional_register: null }] });
  const path = join(root, '.gbrain', 'config.json'), savedPolicy = readFileSync(path, 'utf8'); let changed = false;
  const before = await engine.executeRaw("SELECT id FROM pages WHERE type='atom' ORDER BY id");
  const transcriptPath = join(root, '2026-01-01-policy.txt'); writeFileSync(transcriptPath, source);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  try {
    await expect(run(() => runPhaseExtractAtoms(engine, { _pages: [], _transcripts: [
      { filePath: transcriptPath, content: source, contentHash: createHash('sha256').update(source).digest('hex') }] }), 2,
      { checkAuthorityInTransaction: async () => {
        changed = true; const next = JSON.parse(savedPolicy); next.private_codex.models.deep = 'codex-cli:changed-deep'; writeFileSync(path, JSON.stringify(next));
      } })).rejects.toThrow();
    expect(changed).toBe(true); expect(await engine.executeRaw("SELECT id FROM pages WHERE type='atom' ORDER BY id")).toEqual(before);
  } finally { writeFileSync(path, savedPolicy); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
});

test('private take grading validates evidence before acceptance and caches only valid verdicts', async () => {
  await engine.putPage('notes/synthetic-forecast', { type: 'note', title: 'Synthetic forecast', compiled_truth: source });
  const page = await engine.getPage('notes/synthetic-forecast', { sourceId: 'default' });
  await engine.addTakesBatch([{ page_id: page!.id, row_num: 1, claim: source, kind: 'bet', holder: 'fixture', since_date: '2020-01-01' }]);
  const ctx = { engine, config: {}, sourceId: 'default', remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  const grade = () => runPhaseGradeTakes(ctx, { evidenceRetriever: async () => source });
  reply({ verdict: 'correct', confidence: 0.9, reasoning: 'The supplied record supports the claim.', evidence_quotes: ['invented'] });
  await run(async runId => {
    const result = await grade();
    expect(result.details?.judge_calls_failed).toBe(1);
    expect(await engine.executeRaw('SELECT * FROM take_grade_cache')).toHaveLength(0);
    const rows = await engine.executeRaw<{accepted_turns:number}>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [runId]);
    expect(Number(rows[0]!.accepted_turns)).toBe(0);
  });
  reply({ verdict: 'correct', confidence: 0.9, reasoning: 'The supplied record supports the claim.', evidence_quotes: [source] });
  const good = await run(grade);
  expect(good.details?.verdicts_written).toBe(1);
  const rows = await engine.executeRaw<{prompt_version:string;judge_model_id:string}>('SELECT prompt_version,judge_model_id FROM take_grade_cache');
  expect(rows[0]!.prompt_version).toStartWith('codex-grounded-grade-v1:');
  expect(rows[0]!.judge_model_id).toBe('codex-cli:gpt-test');
  const calls = readFileSync(capture, 'utf8');
  expect((await run(grade)).details?.cache_hits).toBe(1);
  expect(readFileSync(capture, 'utf8')).toBe(calls);
  const conflict = await run(() => runPhaseGradeTakes(ctx, { model: 'anthropic:forbidden', evidenceRetriever: async () => source }));
  expect(conflict.status).toBe('fail'); expect(readFileSync(capture, 'utf8')).toBe(calls);
  const path = join(root, '.gbrain', 'config.json'), savedPolicy = readFileSync(path, 'utf8');
  try {
    const next = JSON.parse(savedPolicy); next.private_codex.models.deep = 'codex-cli:changed-deep'; writeFileSync(path, JSON.stringify(next));
    const fresh = await run(grade); expect(fresh.details?.cache_hits).toBe(0); expect(fresh.details?.verdicts_written).toBe(1);
    expect(readFileSync(capture, 'utf8')).not.toBe(calls);
  } finally { writeFileSync(path, savedPolicy); }

});

test('private synopsis accepts grounded native output and propagates invalid output without fallback', async () => {
  const synopsis = () => generatePerChunkSynopsis({ documentText: source, chunkText: source, pageTitle: 'Synthetic orchard',
    pageSlug: 'notes/orchard', sourceId: 'default', chunkIndex: 0 });
  reply({ synopsis: source, source_quote: source });
  expect(await run(synopsis)).toMatchObject({ kind: 'success', synopsis: source });
  reply({ synopsis: source, source_quote: 'fabricated' });
  await run(async runId => {
    await expect(synopsis()).rejects.toMatchObject({ reason: 'invalid_output' });
    const rows = await engine.executeRaw<{accepted_turns:number}>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [runId]);
    expect(Number(rows[0]!.accepted_turns)).toBe(0);
  });
});

test('private ensembles run sequentially and never cache a failed slot as a judgment', async () => {
  await engine.executeRaw('DELETE FROM take_grade_cache');
  const ctx = { engine, config: {}, sourceId: 'default', remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  const valid = { verdict: 'correct', confidence: 0.9, reasoning: 'Supported by the supplied record.', evidence_quotes: [source] };
  reply(valid);
  const failed = await run(() => runPhaseGradeTakes(ctx, { useEnsemble: true, evidenceRetriever: async () => source,
    ensembleJudges: [{ modelId: 'codex-cli:gpt-test', fn: input => {
      reply({ ...valid, evidence_quotes: ['fabricated'] }); return defaultJudge(input);
    } }] }));
  expect(failed.details?.verdicts_written).toBe(0);
  expect(await engine.executeRaw('SELECT * FROM take_grade_cache')).toHaveLength(0);
  reply(valid);
  await run(async runId => {
    const result = await runPhaseGradeTakes(ctx, { useEnsemble: true, evidenceRetriever: async () => source,
      ensembleJudges: Array.from({ length: 3 }, () => ({ modelId: 'codex-cli:gpt-test', fn: defaultJudge })) });
    expect(result.details?.ensemble_unanimous).toBe(1);
    expect(result.details?.verdicts_written).toBe(1);
    const rows = await engine.executeRaw<{accepted_turns:number}>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [runId]);
    expect(Number(rows[0]!.accepted_turns)).toBe(4);
  }, 4);
});

  });
}
