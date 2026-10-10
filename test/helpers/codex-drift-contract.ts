/** Protects real private drift routing, evidence validation and report outcomes.
 * Reverting the private judge branch admits malformed judgments as stable.
 * Existing drift tests inject a judge and cannot exercise native schema transport.
 * Uses the production phase/gateway with a qualified synthetic executable only.
 */
import { beforeAll, afterAll, beforeEach, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription, type CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { runPhaseDrift, defaultDriftJudge } from '../../src/core/cycle/drift.ts';
import { bindPrivateDriftSource } from '../../src/core/cycle/drift-codex.ts';

export function codexDriftContract(createEngine: () => Promise<{ engine: BrainEngine; cleanup?: () => Promise<void> }>) {
  const root = mkdtempSync(join(tmpdir(), 'codex-drift-')), bin = join(root, 'fixture.mjs');
  const capture = join(root, 'calls.jsonl'), control = join(root, 'response.json');
  const keys = ['HOME', 'GBRAIN_HOME', 'CODEX_HOME'] as const;
  const saved = keys.map(k => [k, process.env[k]] as const), originalFetch = globalThis.fetch;
  let cleanup: (() => Promise<void>) | undefined, engine: BrainEngine, unregister: () => void, seq = 0;
  const quote = 'Funding round closed', sourceId = 'drift-fixture', date = '2026-01-15';
  const slug = 'notes/forecast', reportSlug = `reports/drift-${date}`;
  const good = { drifted: false, confidence: 0.4, reasoning: 'Evidence is adjacent.', suggested_weight: null, source_quote: quote };
  const reply = (value: unknown) => writeFileSync(control, JSON.stringify(value));
  const calls = () => readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const phase = () => runPhaseDrift(engine, { sourceId, dryRun: false, forceEnabled: true, cycleDate: date,
    auditPath: join(root, 'audit.jsonl'), judge: async () => { throw new Error('private judge injection bypass'); } });
  const run = async <T>(fn: (runId: string) => Promise<T>, maxCalls = 2, hooks: Partial<CodexSubscriptionContext> = {}) => {
    const runId = `drift-${seq++}`;
    await createSubscriptionRun(engine, { runId, accountLane: runId, maxAttempts: maxCalls, maxTurns: maxCalls, deadline: new Date(Date.now() + 600_000) });
    return withCodexSubscription({ engine, runId, ...hooks }, () => fn(runId));
  };
  const accounting = async (id: string) => (await engine.executeRaw<{ accepted_turns: number; attempts: number }>(
    'SELECT accepted_turns,attempts FROM codex_subscription_runs WHERE run_id=$1', [id]))[0]!;
  beforeAll(async () => {
    for (const key of keys) process.env[key] = root;
    globalThis.fetch = (() => { throw new Error('forbidden network'); }) as unknown as typeof fetch;
    mkdirSync(join(root, '.gbrain'));
    writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ private_codex: { mode: 'strict', model: 'codex-cli:gpt-test', bin } }));
    writeFileSync(capture, '');
    const script = `#!${Bun.which('node')}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1];
const schema=JSON.parse(readFileSync(arg('--output-schema'),'utf8')),prompt=readFileSync(0,'utf8');
appendFileSync(${JSON.stringify(capture)},JSON.stringify({args,schema,prompt})+'\\n');
const responses=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
const value=Array.isArray(responses)?responses.shift():responses;
if(Array.isArray(responses))writeFileSync(${JSON.stringify(control)},JSON.stringify(responses));
const text=value.raw??JSON.stringify({take_id:schema.properties.take_id.const,...value});
writeFileSync(arg('--output-last-message'),text);
for(const event of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},
{type:'item.completed',item:{type:value.refusal?'refusal':'agent_message',text}},
...(value.missingCompletion?[]:[{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:4}}])])console.log(JSON.stringify(event));
`;
    writeFileSync(bin, script, { mode: 0o700 });
    unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(script).digest('hex'));
    ({ engine, cleanup } = await createEngine()); await engine.initSchema(); configureGateway({ env: {} });
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$2)', [sourceId, 'Synthetic drift source']);
    for (const source of [sourceId, 'default']) {
      const page = await engine.putPage(slug, { type: 'note', title: 'Synthetic forecast', compiled_truth: 'Synthetic forecast' }, { sourceId: source });
      await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: source === sourceId ? 'Will grow' : 'OTHER_SOURCE_SECRET', kind: 'bet', holder: 'fixture', weight: 0.6 }]);
      await engine.addTimelineEntriesBatch([{ slug, date, source: 'fixture', summary: quote, source_id: source }]);
    }
  });
  beforeEach(async () => {
    await engine.executeRaw("DELETE FROM pages WHERE type='note' AND slug LIKE 'reports/drift-%'");
    await engine.executeRaw('DELETE FROM takes WHERE row_num=2');
    reply(good);
  });
  afterAll(async () => {
    await engine?.disconnect(); await cleanup?.(); unregister?.(); resetGateway(); globalThis.fetch = originalFetch;
    for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  });
  test('native transport produces a private scoped report with exact evidence, preserving takes', async () => {
    const before = await engine.executeRaw('SELECT id,weight FROM takes ORDER BY id');
    await run(async id => {
      expect(await phase()).toMatchObject({ status: 'complete', totals: { candidates: 1, judged: 1, failed: 0, reports_written: 1 } });
      expect(Number((await accounting(id)).accepted_turns)).toBe(1);
    });
    const report = await engine.getPage(reportSlug, { sourceId });
    expect(report?.frontmatter).toMatchObject({ visibility: 'private', judgment_protocol: 'codex-drift-v1' });
    expect(report?.compiled_truth).toContain(quote);
    expect(report?.compiled_truth).toContain('[Source: [[notes/forecast]]');
    expect(await engine.getPage(reportSlug, { sourceId: 'default' })).toBeNull();
    expect(await engine.executeRaw('SELECT id,weight FROM takes ORDER BY id')).toEqual(before);
    const wire = calls().at(-1)!;
    expect(wire.args).toContain('--output-schema'); expect(wire.args).toContain('--ephemeral');
    expect(wire.schema.required).toContain('source_quote'); expect(wire.prompt).not.toContain('OTHER_SOURCE_SECRET');
  });
  test.each([
    { ...good, source_quote: 'invented quotation' }, { ...good, confidence: 9 },
    { ...good, take_id: -1 }, { ...good, suggested_weight: 0.7 }, { ...good, reasoning: '' },
    { raw: '{truncated' }, { raw: 'I cannot provide a judgment.' },
  ])('invalid proposals fail without reports or accepted turns', async value => {
    reply(value);
    await run(async id => {
      expect(await phase()).toMatchObject({ status: 'failed', totals: { judged: 0, failed: 1, reports_written: 0 } });
      expect(Number((await accounting(id)).accepted_turns)).toBe(0);
      expect(Number((await accounting(id)).attempts)).toBe(1);
    });
    expect(await engine.getPage(reportSlug, { sourceId })).toBeNull();
  });
  const secondTake = async () => {
    const page = await engine.getPage(slug, { sourceId });
    await engine.addTakesBatch([{ page_id: page!.id, row_num: 2, claim: 'May grow later', kind: 'bet', holder: 'fixture', weight: 0.5 }]);
  };
  test('drifted output stays advisory and a phase cap reports partial coverage', async () => {
    await secondTake(); await engine.setConfig('dream.drift.max_per_cycle', '1');
    reply({ ...good, drifted: true, suggested_weight: 0.2 });
    const before = await engine.executeRaw('SELECT id,weight FROM takes ORDER BY id');
    try {
      expect(await run(phase)).toMatchObject({ status: 'partial', totals: { candidates: 2, judged: 1, drifted: 1, reports_written: 1 } });
      expect((await engine.getPage(reportSlug, { sourceId }))?.compiled_truth).toContain('suggested 0.2');
      expect(await engine.executeRaw('SELECT id,weight FROM takes ORDER BY id')).toEqual(before);
    } finally { await engine.unsetConfig('dream.drift.max_per_cycle'); }
  });
  test('deleted candidate pages leave an empty model-free phase', async () => {
    const before = calls().length;
    await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
    try { expect(await phase()).toMatchObject({ status: 'complete', totals: { candidates: 0 } }); }
    finally { await engine.executeRaw('UPDATE pages SET deleted_at=NULL WHERE source_id=$1 AND slug=$2', [sourceId, slug]); }
    expect(calls().length).toBe(before);
    expect(await engine.getPage(reportSlug, { sourceId })).toBeNull();
  });
  test('mixed valid and failed judgments stay partial and report missing judgments explicitly', async () => {
    await secondTake(); reply([{ raw: 'private provider detail' }, good]);
    const result = await run(phase);
    expect(result).toMatchObject({ status: 'partial', totals: { judged: 1, failed: 1, reports_written: 1 } });
    expect((await engine.getPage(reportSlug, { sourceId }))?.compiled_truth).toContain('Failed judgments: 1');
    expect(result.detail).toContain('unknown (subscription)'); expect(result.detail).not.toContain('private provider detail');
  });
  test('attempt exhaustion stops dispatch and USD alone grants no subscription calls', async () => {
    await secondTake(); const before = calls().length;
    expect(await run(phase, 1)).toMatchObject({ status: 'partial', totals: { judged: 1 } });
    expect(calls().length - before).toBe(1);
    expect(await phase()).toMatchObject({ status: 'partial', totals: { judged: 0, reports_written: 0 } });
    expect(calls().length - before).toBe(1);
  });
  test.each(['models.drift', 'dream.drift.model'])('explicit conflicting pin %s fails before inference', async key => {
    const before = calls().length; await engine.setConfig(key, 'anthropic:forbidden');
    try { await run(async () => { await expect(phase()).rejects.toMatchObject({ name: 'PrivateRoutingError' }); }); }
    finally { await engine.unsetConfig(key); }
    expect(calls().length).toBe(before);
  });
  test('source archive after acceptance and mismatched incarnation refuse publication', async () => {
    await expect(bindPrivateDriftSource(engine, sourceId, { sourceId, incarnation: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'source_changed' });
    try {
      let runId = '';
      await run(async id => { runId = id;
        await expect(phase()).rejects.toMatchObject({ code: 'source_changed' });
      }, 2, { checkAuthority: async () => {
        if (Number((await accounting(runId)).accepted_turns) > 0) {
          await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
        }
      } });
    } finally { await engine.executeRaw('UPDATE sources SET archived=false WHERE id=$1', [sourceId]); }
    expect(await engine.getPage(reportSlug, { sourceId })).toBeNull();
  });
  test('publication transaction checks the host claim before report effects', async () => {
    await expect(run(phase, 2, { checkAuthorityInTransaction: async () => { throw new Error('stale fixture claim'); } })).rejects.toThrow('stale fixture claim');
    expect(await engine.getPage(reportSlug, { sourceId })).toBeNull();
  });
  test('dry runs and disabled phases do not need an inference allowance', async () => {
    const before = calls().length;
    expect((await runPhaseDrift(engine, { sourceId, dryRun: true, forceEnabled: true, cycleDate: date })).status).toBe('skipped');
    expect((await runPhaseDrift(engine, { sourceId, dryRun: false, cycleDate: date })).status).toBe('skipped');
    expect(calls().length).toBe(before);
  });
  test('direct judge rejects oversized evidence before dispatch', async () => {
    const before = calls().length;
    await expect(defaultDriftJudge({ candidate: { takeId: 1, pageId: 1, pageSlug: slug, rowNum: 1, claim: 'Synthetic', weight: 0.6, recentEvidenceCount: 1 }, evidence: 'x'.repeat(24001) })).rejects.toMatchObject({ reason: 'invalid_input' });
    expect(calls().length).toBe(before);
  });
  test.each([{ refusal: true }, { missingCompletion: true }])('incomplete lifecycle is not a stable verdict and retains unresolved admission', async value => {
    reply(value); const before = calls().length;
    await run(async id => {
      expect(await phase()).toMatchObject({ status: 'failed', totals: { judged: 0, reports_written: 0 } });
      expect(Number((await accounting(id)).accepted_turns)).toBe(0);
      const rows = await engine.executeRaw<{ state: string; failure_code: string }>('SELECT state,failure_code FROM codex_subscription_attempts WHERE run_id=$1', [id]);
      expect(rows[0]).toMatchObject({ state: 'unresolved', failure_code: value.refusal ? 'refusal' : 'missing_completion' });
      reply(good);
      expect((await phase()).totals?.judged).toBe(0);
    });
    expect(calls().length - before).toBe(1);
  });
}
