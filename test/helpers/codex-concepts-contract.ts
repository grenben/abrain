import { beforeAll, afterAll, test, expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription } from '../../src/core/ai/subscription-context.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { __setMaintenanceWriteWaitForTests } from '../../src/core/persistence/maintenance-wait.ts';
import { withCodexRoleFixture, withDistinctCodexModels } from './codex-role-fixture.ts';

// Real phase → native executable → prepared publication, on both engines.
// Existing concept tests inject plain chat and cannot discriminate native
// validation, role/tier routing, subscription accounting or revoked grants.
export function codexConceptsContract(factory: () => Promise<{ engine: BrainEngine; cleanup?: () => Promise<void> }>) {
  const root = mkdtempSync(join(tmpdir(), 'codex-concepts-')), bin = join(root, 'fake.mjs');
  const control = join(root, 'reply.json'), capture = join(root, 'calls.jsonl'), path = join(root, '.gbrain', 'config.json');
  const keys = ['HOME', 'GBRAIN_HOME', 'CODEX_HOME'] as const, saved = keys.map(k => [k, process.env[k]] as const), fetch = globalThis.fetch;
  let engine: BrainEngine, cleanup: (() => Promise<void>) | undefined, unregister: () => void, restoreWait: () => void;
  const quote = 'Early review keeps decisions grounded in evidence.';
  const reply = (value: unknown) => writeFileSync(control, JSON.stringify(value));
  const calls = () => existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  beforeAll(async () => {
    for (const k of keys) process.env[k] = root;
    globalThis.fetch = (() => { throw new Error('forbidden network'); }) as unknown as typeof fetch;
    mkdirSync(join(root, '.gbrain')); writeFileSync(path, JSON.stringify({ embedding_disabled: true, private_codex: { mode: 'strict', model: 'codex-cli:gpt-test', bin } }));
    const script = `#!${Bun.which('node')}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const a=process.argv.slice(2),arg=n=>a[a.indexOf(n)+1],schema=JSON.parse(readFileSync(arg('--output-schema'),'utf8')),prompt=readFileSync(0,'utf8');
appendFileSync(${JSON.stringify(capture)},JSON.stringify({schema,prompt,model:arg('--model')})+'\\n');
const text=readFileSync(${JSON.stringify(control)},'utf8');writeFileSync(arg('--output-last-message'),text);
for(const e of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed',usage:{input_tokens:30,cached_input_tokens:0,output_tokens:15}}])console.log(JSON.stringify(e));
`;
    writeFileSync(bin, script, { mode: 0o700 }); unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(script).digest('hex'));
    ({ engine, cleanup } = await factory()); await engine.initSchema(); configureGateway({ env: {} }); restoreWait = __setMaintenanceWriteWaitForTests(5000);
    await engine.setConfig('cycle.synthesize_concepts.budget_usd', '0.00000001');
  });
  afterAll(async () => {
    await disposePersistenceConsumer(engine); await engine?.disconnect(); await cleanup?.(); unregister?.(); restoreWait?.(); resetGateway(); globalThis.fetch = fetch;
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(root, { recursive: true, force: true });
  });
  async function fixture(count = 5, visibility = 'world') {
    await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const sourceId = `concept-${randomUUID().slice(0, 8)}`, dir = join(root, sourceId); mkdirSync(dir);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, dir]);
    for (let i = 0; i < count; i++) await engine.putPage(`atoms/lesson-${i}`, { type: 'atom', title: `Review lesson ${i}`, compiled_truth: quote,
      frontmatter: { visibility, concepts: ['review'] } }, { sourceId });
    await claimWorktree(engine, sourceId, dir); await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const runId = randomUUID(); await createSubscriptionRun(engine, { runId, accountLane: runId, maxAttempts: 4, maxTurns: 4, deadline: new Date(Date.now() + 600000) });
    const opts = { sourceId, brainDir: dir };
    const run = (checkAuthority?: () => Promise<void>) => withCodexSubscription({ engine, runId, checkAuthority }, () => runPhaseSynthesizeConcepts(engine, opts));
    const proposal = () => ({ narrative: quote, evidence: [0, 1].map(i => ({ slug: `atoms/lesson-${i}`, quote })) });
    reply(proposal());
    return { sourceId, runId, run, opts, proposal };
  }
  const accepted = async (runId: string) => (await engine.executeRaw<{ accepted_turns: number }>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [runId]))[0]!.accepted_turns;
  withCodexRoleFixture(root, ['concepts'], () => {
    test('exhausted allowance refuses synthesis without a call or fallback page', async () => {
      const f = await fixture(), before = calls().length;
      await engine.executeRaw('UPDATE codex_subscription_runs SET attempts=max_attempts WHERE run_id=$1', [f.runId]);
      await expect(f.run()).rejects.toThrow('subscription_exhausted');
      expect(calls()).toHaveLength(before); expect(await engine.getPage('concepts/review', { sourceId: f.sourceId })).toBeNull();
    });
    test('legacy scalar policy retains native concept compatibility', async () => {
      const f = await fixture(), config = JSON.parse(readFileSync(path, 'utf8'));
      config.private_codex = { mode: 'strict', model: 'codex-cli:gpt-test', bin }; writeFileSync(path, JSON.stringify(config));
      expect((await f.run()).status).toBe('ok'); expect(await accepted(f.runId)).toBe(1);
    });
    test('distinct reasoning tier publishes preserved source provenance and reuses unchanged concepts without a USD charge', async () => withDistinctCodexModels(async models => {
      const f = await fixture(), before = calls().length, result = await f.run();
      expect(result.status).toBe('ok'); expect(result.details?.estimated_spend_usd).toBeNull(); expect(result.details?.budget_usd).toBeNull();
      expect(result.details?.synthesis_mode_counts).toMatchObject({ llm: 1, error_fallback: 0, budget_fallback: 0 });
      expect(calls().slice(before).map(c => c.model)).toEqual([models.reasoning.slice('codex-cli:'.length)]);
      const page = await engine.getPage('concepts/review', { sourceId: f.sourceId });
      expect(page!.compiled_truth).toContain('[Source: [[atoms/lesson-0]]]'); expect(page!.frontmatter.visibility).toBe('world');
      expect((await engine.getLinks('concepts/review', { sourceId: f.sourceId })).filter(l => l.link_source === 'concept-provenance').length).toBeGreaterThanOrEqual(5);
      expect((await f.run()).details?.skipped_unchanged).toEqual(['concepts/review']); expect(calls()).toHaveLength(before + 1); expect(await accepted(f.runId)).toBe(1);
    }));
    test.each(['quote', 'number', 'link', 'duplicate'])('invalid %s is refused before accepted-turn accounting or fallback publication', async kind => {
      const f = await fixture(), p = f.proposal();
      if (kind === 'quote') p.evidence[0]!.quote = 'Invented evidence.';
      if (kind === 'number') p.narrative = 'Review saves 918 dollars.';
      if (kind === 'link') p.narrative = 'See [[people/invented]].';
      if (kind === 'duplicate') p.evidence[1] = p.evidence[0]!;
      reply(p); await expect(f.run()).rejects.toThrow(); expect(await accepted(f.runId)).toBe(0);
      expect(await engine.getPage('concepts/review', { sourceId: f.sourceId })).toBeNull();
    });
    test('disabled role refuses cached work without another call', async () => {
      const f = await fixture(); await f.run(); const before = calls().length, config = JSON.parse(readFileSync(path, 'utf8'));
      config.private_codex.enabled_roles = []; writeFileSync(path, JSON.stringify(config));
      await expect(f.run()).rejects.toThrow(); expect(calls()).toHaveLength(before);
    });
    test('policy revocation while authority is suspended cannot accept or publish', async () => {
      const f = await fixture(), before = calls().length;
      await expect(f.run(async () => { if (calls().length > before) {
        const config = JSON.parse(readFileSync(path, 'utf8')); config.private_codex.models.utility = 'codex-cli:revoked'; writeFileSync(path, JSON.stringify(config));
      } })).rejects.toThrow();
      expect(await accepted(f.runId)).toBe(0); expect(await engine.getPage('concepts/review', { sourceId: f.sourceId })).toBeNull();
    });
    test('changed atom revision cannot accept or publish a stale narrative', async () => {
      const f = await fixture(), before = calls().length;
      await expect(f.run(async () => { if (calls().length > before) await engine.executeRaw('UPDATE pages SET knowledge_revision=$1::uuid WHERE source_id=$2 AND slug=$3', [randomUUID(), f.sourceId, 'atoms/lesson-0']); })).rejects.toThrow();
      expect(await accepted(f.runId)).toBe(0); expect(await engine.getPage('concepts/review', { sourceId: f.sourceId })).toBeNull();
    });
    test('private member atoms stay outside inference and publication', async () => {
      const f = await fixture(5, 'private'), before = calls().length;
      expect((await f.run()).status).toBe('skipped'); expect(calls()).toHaveLength(before);
    });
    test('preview needs no grant and invokes no model or writer', async () => {
      const f = await fixture(), before = calls().length;
      expect((await runPhaseSynthesizeConcepts(engine, { ...f.opts, dryRun: true })).details?.dry_run).toBe(true);
      expect(calls()).toHaveLength(before); expect(await engine.getPage('concepts/review', { sourceId: f.sourceId })).toBeNull();
    });
    test('small groups retain deterministic synthesis without consuming a turn', async () => {
      const f = await fixture(2), before = calls().length;
      expect((await f.run()).status).toBe('ok'); expect(calls()).toHaveLength(before); expect(await accepted(f.runId)).toBe(0);
      expect((await engine.getPage('concepts/review', { sourceId: f.sourceId }))!.frontmatter.synthesis_mode).toBe('deterministic_tier');
    });
  });
}
