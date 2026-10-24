import { withCodexRoleFixture } from './codex-role-fixture.ts';
/** Runs real proposal extraction and persistence with a synthetic CLI.
 * Protects grounded batch acceptance, empty-result cache identity and rollback.
 * Legacy extractor-injection tests do not cover native transport or private authority.
 * Reverting the private extractor/persistence integration must fail these tests.
 */
import { beforeAll, beforeEach, afterAll, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription, type CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { runPhaseProposeTakes } from '../../src/core/cycle/propose-takes.ts';

export function codexTakeProposalsContract(createEngine: () => Promise<{ engine: BrainEngine; cleanup?: () => Promise<void> }>) {
  const root = mkdtempSync(join(tmpdir(), 'codex-take-proposals-')), bin = join(root, 'fixture.mjs');
  const capture = join(root, 'calls.jsonl'), control = join(root, 'response.json');
  const keys = ['HOME', 'GBRAIN_HOME', 'CODEX_HOME'] as const;
  const saved = keys.map(k => [k, process.env[k]] as const), originalFetch = globalThis.fetch;
  let cleanup: (() => Promise<void>) | undefined, engine: BrainEngine, unregister: () => void, seq = 0;
  const sourceId = 'proposal-fixture', slug = 'notes/forecast';
  const body = 'The orchard will double its harvest next year. The orchard may expand its land.';
  const take = { claim_text: 'The orchard will double its harvest next year.', kind: 'bet', holder: 'brain', weight: 0.6,
    domain: null, source_quote: 'The orchard will double its harvest next year.' };
  const take2 = { ...take, claim_text: 'The orchard may expand its land.', kind: 'hunch', source_quote: 'The orchard may expand its land.' };
  const reply = (value: unknown) => writeFileSync(control, JSON.stringify(value));
  const calls = () => readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const ctx = () => ({ engine, config: {}, sourceId, remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext);
  const phase = () => runPhaseProposeTakes(ctx(), { extractor: async () => { throw new Error('injection bypass'); } });
  const run = async <T>(fn: (id: string) => Promise<T>, hooks: Partial<CodexSubscriptionContext> = {}) => {
    const runId = `take-proposal-${seq++}`;
    await createSubscriptionRun(engine, { runId, accountLane: runId, maxAttempts: 3, maxTurns: 3, deadline: new Date(Date.now() + 600000) });
    return withCodexSubscription({ engine, runId, ...hooks }, () => fn(runId));
  };
  const rows = () => engine.executeRaw<{ claim_text: string; status: string; model_id: string; prompt_version: string; codex_evidence: Record<string,unknown> }>('SELECT claim_text,status,model_id,prompt_version,codex_evidence FROM take_proposals ORDER BY id');
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
const text=value.raw??JSON.stringify(value);
writeFileSync(arg('--output-last-message'),text);
for(const event of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},
{type:'item.completed',item:{type:value.refusal?'refusal':'agent_message',text}},
...(value.missingCompletion?[]:[{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:4}}])])console.log(JSON.stringify(event));
`;
    writeFileSync(bin, script, { mode: 0o700 });
    unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(script).digest('hex'));
    ({ engine, cleanup } = await createEngine()); await engine.initSchema(); configureGateway({ env: {} });
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$2)', [sourceId, 'Synthetic proposal source']);
    await engine.putPage(slug, { type: 'note', title: 'Other source', compiled_truth: 'OTHER_SOURCE_SECRET' });
  });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM take_proposals');
    await engine.executeRaw("DELETE FROM extract_rollup_7d WHERE kind='takes.proposed'");
    await engine.executeRaw("DELETE FROM pages WHERE type='extract_receipt'");
    await engine.putPage(slug, { type: 'note', title: 'Synthetic forecast', compiled_truth: body }, { sourceId });
    reply({ takes: [take, take2] });
  });
  afterAll(async () => {
    await engine?.disconnect(); await cleanup?.(); unregister?.(); resetGateway(); globalThis.fetch = originalFetch;
    for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  });
  withCodexRoleFixture(root, ['take-proposals'], () => {
  test('native grounded batch keeps quote provenance, source scope and advisory status', async () => {
    await run(async id => {
      expect(await phase()).toMatchObject({ status: 'ok', details: { proposals_inserted: 2, cost_usd: null, billing: 'subscription' } });
      expect(Number((await accounting(id)).accepted_turns)).toBe(1);
    });
    const proposals = await rows(); expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({ status: 'pending', model_id: 'codex-cli:gpt-test', codex_evidence: { source_quote: take.source_quote, version: 1 } });
    expect(proposals[0]!.prompt_version).toStartWith('codex-take-proposals-v1:');
    expect(proposals[0]!.codex_evidence.page_revision).toBeDefined();
    const receipts = await engine.executeRaw<{ frontmatter: Record<string,unknown> }>("SELECT frontmatter FROM pages WHERE type='extract_receipt' AND source_id=$1", [sourceId]);
    expect(receipts).toHaveLength(1); expect(receipts[0]!.frontmatter).toMatchObject({ cost_usd: null, billing: 'subscription', api_metered_cost_usd: null });
    expect(await engine.executeRaw('SELECT id FROM takes')).toHaveLength(0);
    const wire = calls().at(-1)!; expect(wire.args).toContain('--output-schema');
    expect(wire.schema.properties.takes.items.required).toContain('source_quote');
    expect(wire.prompt).not.toContain('OTHER_SOURCE_SECRET');
    const before = calls().length;
    expect(await run(phase)).toMatchObject({ status: 'ok', details: { cache_hits: 1, proposals_inserted: 0 } });
    expect(calls().length).toBe(before);
  });
  test.each([
    { takes: [take, { ...take2, source_quote: 'invented quote' }] }, { takes: [take, take] },
    { takes: [{ ...take, kind: 'unknown' }] }, { takes: [{ ...take, weight: 4 }] },
    { takes: [{ ...take, operation_id: 'model-authority' }] }, { raw: '[invalid' }, { raw: 'I cannot judge.' },
  ])('invalid whole batches never cache partial proposals or empty tombstones', async value => {
    reply(value);
    await run(async id => {
      const result = await phase(); expect(result.status).not.toBe('ok'); expect(result.details?.llm_calls_failed).toBe(1);
      expect(await rows()).toHaveLength(0); expect(Number((await accounting(id)).accepted_turns)).toBe(0);
      const [rollup] = await engine.executeRaw<{ round_completed_count: number; halt_count: number }>("SELECT round_completed_count,halt_count FROM extract_rollup_7d WHERE kind='takes.proposed' AND source_id=$1", [sourceId]);
      expect(Number(rollup!.round_completed_count)).toBe(0); expect(Number(rollup!.halt_count)).toBe(1);
    });
  });
  test('valid empty extraction writes a versioned tombstone and avoids another call', async () => {
    reply({ takes: [] }); expect(await run(phase)).toMatchObject({ status: 'ok', details: { tombstones_written: 1 } });
    expect((await rows())[0]).toMatchObject({ status: 'rejected', claim_text: '(no gradeable claims)', codex_evidence: { source_quote: null } });
    const before = calls().length; await run(phase); expect(calls().length).toBe(before);
  });
  test('transaction failure after the first row rolls back the entire batch and allows a fresh attempt', async () => {
    await engine.executeRaw("CREATE FUNCTION reject_second_fixture_take() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.claim_text='The orchard may expand its land.' THEN RAISE EXCEPTION 'synthetic effect failure'; END IF; RETURN NEW; END $$");
    await engine.executeRaw('CREATE TRIGGER reject_second_fixture_take BEFORE INSERT ON take_proposals FOR EACH ROW EXECUTE FUNCTION reject_second_fixture_take()');
    try { expect((await run(phase)).status).toBe('fail'); expect(await rows()).toHaveLength(0); }
    finally { await engine.executeRaw('DROP TRIGGER reject_second_fixture_take ON take_proposals'); await engine.executeRaw('DROP FUNCTION reject_second_fixture_take()'); }
    expect(await run(phase)).toMatchObject({ status: 'ok', details: { proposals_inserted: 2 } });
  });
  test('page revision changes after inference cannot publish stale proposals', async () => {
    let runId = '';
    const result = await run(async id => { runId = id; return phase(); }, { checkAuthorityInTransaction: async tx => {
      const [run] = await tx.executeRaw<{ accepted_turns: number }>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [runId]);
      expect(Number(run!.accepted_turns)).toBe(1);
      await tx.executeRaw('UPDATE pages SET knowledge_revision=knowledge_revision+1 WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
    } });
    expect(result.status).toBe('fail'); expect(await rows()).toHaveLength(0);
  });
  test('a revoked local writer cannot persist accepted proposals', async () => {
    const result = await run(phase, { checkAuthorityInTransaction: async tx => {
      await tx.executeRaw("UPDATE persistence_local_writers SET revoked_at=now() WHERE lane='cli'");
    } });
    expect(result).toMatchObject({ status: 'fail', details: { proposals_inserted: 0, publication_failures: 1 } });
    expect(await rows()).toHaveLength(0);
  });
  test('receipt permission failure preserves committed proposals and reports partial completion', async () => {
    const [writer] = await engine.executeRaw<{ id: string; grant_ceiling: Record<string,unknown> }>("SELECT id,grant_ceiling FROM persistence_local_writers WHERE lane='cli'");
    await engine.executeRaw('UPDATE persistence_local_writers SET grant_ceiling=$2::text::jsonb WHERE id=$1',
      [writer!.id, JSON.stringify({ ...writer!.grant_ceiling, slugPrefixes: ['notes/*'] })]);
    try {
      const result = await run(phase);
      expect(result).toMatchObject({ status: 'warn', details: { proposals_inserted: 2 } });
      expect(await rows()).toHaveLength(2);
      expect(await engine.executeRaw("SELECT id FROM pages WHERE type='extract_receipt'")).toHaveLength(0);
      expect(result.details?.warnings).toContain('receipt_failed: committed proposals remain available for review');
    } finally {
      await engine.executeRaw('UPDATE persistence_local_writers SET grant_ceiling=$2::text::jsonb WHERE id=$1', [writer!.id, JSON.stringify(writer!.grant_ceiling)]);
    }
  });
  test.each([{ refusal: true }, { missingCompletion: true }])('unsettled inference cannot create proposals or release its lane', async value => {
    reply(value);
    await run(async id => {
      expect((await phase()).status).toBe('fail'); expect(await rows()).toHaveLength(0);
      const [attempt] = await engine.executeRaw<{ state: string }>('SELECT state FROM codex_subscription_attempts WHERE run_id=$1', [id]);
      expect(attempt!.state).toBe('unresolved');
      const before = calls().length; reply({ takes: [] }); await phase(); expect(calls().length).toBe(before);
    });
  });
  test('remote authority, conflicting pins, USD-only grants and dry runs cannot dispatch', async () => {
    const before = calls().length;
    expect((await run(() => runPhaseProposeTakes({ ...ctx(), remote: true }))).status).toBe('fail');
    expect((await run(() => runPhaseProposeTakes(ctx(), { model: 'anthropic:forbidden' }))).status).toBe('fail');
    expect((await phase()).details?.budget_exhausted).toBe(true);
    expect((await runPhaseProposeTakes(ctx(), { dryRun: true })).status).toBe('skipped');
    expect(calls().length).toBe(before); expect(await rows()).toHaveLength(0);
  });
  });
}
