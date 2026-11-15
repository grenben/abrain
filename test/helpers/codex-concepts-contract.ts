import { beforeAll, afterAll, test, expect, spyOn } from 'bun:test';
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
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { TEST_WRITE_ATTRIBUTION } from './write-attribution.ts';
import { __setPrivateConceptPreparedHookForTests } from '../../src/core/persistence/prepared-maintenance.ts';

// Real phase → native executable → prepared publication, on both engines.
// Existing concept tests inject plain chat and cannot discriminate native
// validation, role/tier routing, subscription accounting or revoked grants.
export function codexConceptsContract(factory: () => Promise<{ engine: BrainEngine; cleanup?: () => Promise<void> }>) {
  const root = mkdtempSync(join(tmpdir(), 'codex-concepts-')), bin = join(root, 'fake.mjs');
  const control = join(root, 'reply.json'), capture = join(root, 'calls.jsonl'), path = join(root, '.gbrain', 'config.json');
  const keys = ['HOME', 'GBRAIN_HOME', 'CODEX_HOME'] as const, saved = keys.map(k => [k, process.env[k]] as const), fetch = globalThis.fetch;
  let engine: BrainEngine, cleanup: (() => Promise<void>) | undefined, unregister: () => void, restoreWait: () => void;
  const quote = 'Early review keeps decisions grounded in evidence.';
  const bounded = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([promise, Bun.sleep(ms).then(() => { throw new Error(`${label} exceeded ${ms}ms`); })]);
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
  async function fixture(count = 5, visibility = 'world', concepts?: string[]) {
    await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const sourceId = `concept-${randomUUID().slice(0, 8)}`, dir = join(root, sourceId); mkdirSync(dir);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, dir]);
    for (let i = 0; i < count; i++) await engine.putPage(`atoms/lesson-${i}`, { type: 'atom', title: `Review lesson ${i}`, compiled_truth: quote,
      frontmatter: { visibility, concepts: concepts ? [concepts[i]!] : ['review'] } }, { sourceId });
    await claimWorktree(engine, sourceId, dir); await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const runId = randomUUID(); await createSubscriptionRun(engine, { runId, accountLane: runId, maxAttempts: 4, maxTurns: 4, deadline: new Date(Date.now() + 600000) });
    const opts = { sourceId, brainDir: dir };
    const run = (checkAuthority?: () => Promise<void>, checkAuthorityInTransaction?: (tx: BrainEngine) => Promise<void>) =>
      withCodexSubscription({ engine, runId, checkAuthority, checkAuthorityInTransaction }, () => runPhaseSynthesizeConcepts(engine, opts));
    const proposal = (start = 0) => ({ narrative: quote, evidence: [start, start + 1].map(i => ({ slug: `atoms/lesson-${i}`, quote })) });
    reply(proposal());
    return { sourceId, runId, run, opts, proposal, reply };
  }
  const accepted = async (runId: string) => (await engine.executeRaw<{ accepted_turns: number }>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [runId]))[0]!.accepted_turns;
  const changeRevision = (sourceId: string, slug: string, deleted = false) => engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
      'UPDATE pages SET knowledge_revision=$1::uuid, deleted_at=CASE WHEN $4 THEN now() ELSE deleted_at END WHERE source_id=$2 AND slug=$3',
      [randomUUID(), sourceId, slug, deleted]), TEST_WRITE_ATTRIBUTION);
  });
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
      let changed = false;
      await expect(f.run(async () => { if (!changed && calls().length > before) {
        await changeRevision(f.sourceId, 'atoms/lesson-0'); changed = true;
      } })).rejects.toMatchObject({ reason: 'invalid_output' });
      expect(changed).toBe(true);
      expect(await accepted(f.runId)).toBe(0); expect(await engine.getPage('concepts/review', { sourceId: f.sourceId })).toBeNull();
    });
    test('two queued groups keep their own evidence fence through flush', async () => {
      const assignments = Array.from({ length: 10 }, (_, i) => i < 5 ? 'review-a' : 'review-b');
      const f = await fixture(10, 'world', assignments), before = calls().length;
      let switchedReply = false, changedFirst = false;
      const result = await f.run(async () => {
        const completed = calls().length - before;
        if (completed === 1 && !switchedReply) { f.reply(f.proposal(5)); switchedReply = true; }
        if (completed === 2 && !changedFirst) {
          await changeRevision(f.sourceId, 'atoms/lesson-0');
          changedFirst = true;
        }
      });
      expect(switchedReply).toBe(true); expect(changedFirst).toBe(true);
      expect(await engine.getPage('concepts/review-a', { sourceId: f.sourceId })).toBeNull();
      expect(await engine.getPage('concepts/review-b', { sourceId: f.sourceId })).not.toBeNull();
      expect(result.details?.publication_deferred).toEqual(expect.arrayContaining([
        expect.objectContaining({ concept: 'review-a', reason: expect.stringContaining('revision_conflict') }),
      ]));
    });
    test('concurrent concept admission and publication reject stale evidence without deadlock', async () => {
      const f = await fixture();
      let prepared!: () => void, continuePublish!: () => void, paused = false;
      const preparedGate = new Promise<void>(resolve => { prepared = resolve; });
      const prepareGate = new Promise<void>(resolve => { continuePublish = resolve; });
      const restoreHook = __setPrivateConceptPreparedHookForTests(async row => {
        if (row.slug === 'concepts/review' && !paused) { paused = true; prepared(); await prepareGate; }
      });
      const first = f.run();
      let second: Promise<unknown> | undefined;
      try {
        await bounded(preparedGate, 5000, 'first prepared publication barrier');
        await bounded(changeRevision(f.sourceId, 'atoms/lesson-0'), 5000, 'evidence revision change');
        second = f.run();
        const turnsDeadline = Date.now() + 5000;
        while (Date.now() < turnsDeadline && await accepted(f.runId) < 2) await Bun.sleep(10);
        expect(await accepted(f.runId)).toBe(2);
        continuePublish();
        const [firstResult] = await Promise.race([
          Promise.all([first, second]),
          Bun.sleep(10_000).then(() => { throw new Error('admission/publication lock-order contention exceeded its bound'); }),
        ]);
        expect(firstResult.details?.publication_deferred).toEqual(expect.arrayContaining([
          expect.objectContaining({ concept: 'review', reason: expect.stringContaining('revision_conflict') }),
        ]));
      } finally {
        continuePublish(); restoreHook();
        await bounded(Promise.allSettled([first, ...(second ? [second] : [])]), 15_000, 'concept contention cleanup');
      }
      expect(await engine.getPage('concepts/review', { sourceId: f.sourceId })).not.toBeNull();
      expect((await engine.getLinks('concepts/review', { sourceId: f.sourceId })).filter(link => link.link_source === 'concept-provenance').length)
        .toBeGreaterThan(0);
    });
    test.each([false, true])('prepared world concept refuses changed or deleted evidence before publication (deleted=%s)', async deleted => {
      const f = await fixture();
      let reached!: () => void, release!: () => void, paused = false;
      const prepared = new Promise<void>(resolve => { reached = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const restoreHook = __setPrivateConceptPreparedHookForTests(async row => {
        if (row.slug === 'concepts/review' && !paused) { paused = true; reached(); await gate; }
      });
      const running = f.run();
      try {
        await bounded(prepared, 5000, 'prepared evidence publication barrier');
        await bounded(changeRevision(f.sourceId, 'atoms/lesson-0', deleted), 5000, 'evidence mutation');
        release();
        const result = await bounded(running, 15_000, 'prepared evidence publication');
        expect(result.details?.publication_deferred).toEqual(expect.arrayContaining([
          expect.objectContaining({ concept: 'review', reason: expect.stringContaining('revision_conflict') }),
        ]));
        expect(await engine.getPage('concepts/review', { sourceId: f.sourceId })).toBeNull();
      } finally { release(); restoreHook(); await bounded(Promise.allSettled([running]), 15_000, 'prepared evidence cleanup'); }
    });
    test('prepared queued concept is refused when the bound private policy is revoked', async () => {
      const f = await fixture(), originalConfig = readFileSync(path, 'utf8');
      let reached!: () => void, release!: () => void, paused = false;
      const prepared = new Promise<void>(resolve => { reached = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const restoreHook = __setPrivateConceptPreparedHookForTests(async row => {
        if (row.slug === 'concepts/review' && !paused) { paused = true; reached(); await gate; }
      });
      const running = f.run();
      try {
        await bounded(prepared, 5000, 'prepared policy publication barrier');
        const config = JSON.parse(originalConfig) as { private_codex: Record<string, unknown> };
        const policy = config.private_codex;
        if (policy.models && typeof policy.models === 'object') {
          const models = policy.models as Record<string, string>;
          models.reasoning = 'codex-cli:revoked';
        } else policy.model = 'codex-cli:revoked';
        writeFileSync(path, JSON.stringify(config));
        release();
        await expect(bounded(running, 15_000, 'revoked policy publication')).rejects.toThrow();
        expect(await engine.getPage('concepts/review', { sourceId: f.sourceId })).toBeNull();
      } finally {
        release(); restoreHook(); writeFileSync(path, originalConfig);
        await bounded(Promise.allSettled([running]), 15_000, 'revoked policy cleanup');
      }
    });
    test('revoked authority before queued admission prevents concept publication', async () => {
      const f = await fixture();
      let active = true, revoked = false;
      const check = async () => { if (!active) throw new Error('authority revoked'); };
      const checkInTransaction = async (tx: BrainEngine) => {
        const turns = await tx.executeRaw<{ accepted_turns: number }>(
          'SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [f.runId]);
        const target = await tx.readPageSnapshot('concepts/review', { sourceId: f.sourceId });
        if (!revoked && Number(turns[0]?.accepted_turns ?? 0) > 0 && !target) { active = false; revoked = true; }
        await check();
      };
      await expect(f.run(check, checkInTransaction)).rejects.toThrow('Private concept evidence or authority changed before publication.');
      expect(revoked).toBe(true); expect(await accepted(f.runId)).toBe(1);
      expect(await engine.getPage('concepts/review', { sourceId: f.sourceId })).toBeNull();
    });
    test('revoked authority before provenance edge replacement leaves edges untouched', async () => {
      const f = await fixture();
      let active = true, revoked = false;
      const check = async () => { if (!active) throw new Error('authority revoked'); };
      const checkInTransaction = async (tx: BrainEngine) => {
        const target = await tx.readPageSnapshot('concepts/review', { sourceId: f.sourceId });
        if (target && !revoked) {
          const existing = await tx.getLinks('concepts/review', { sourceId: f.sourceId });
          if (!existing.some(link => link.link_source === 'concept-provenance')) { active = false; revoked = true; }
        }
        await check();
      };
      await expect(f.run(check, checkInTransaction)).rejects.toThrow('Private concept evidence or authority changed before publication.');
      expect(revoked).toBe(true); expect(await accepted(f.runId)).toBe(1);
      expect((await engine.getPage('concepts/review', { sourceId: f.sourceId }))?.frontmatter.visibility).toBe('private');
      expect((await engine.getLinks('concepts/review', { sourceId: f.sourceId })).filter(link => link.link_source === 'concept-provenance')).toHaveLength(0);
    });
    // The earlier case changes a revision after inference. This exercises the
    // selection-to-capture race: unchanged body/title cannot adopt a new revision.
    // Reverting the revision comparison admits a model call and publication.
    test('an atom revision changed after selection refuses before inference', async () => {
      const f = await fixture(), before = calls().length, original = engine.executeRaw.bind(engine);
      let changed = false;
      const race = spyOn(engine, 'executeRaw').mockImplementation(async <T>(sql: string, params?: unknown[], opts?: Parameters<BrainEngine['executeRaw']>[2]): Promise<T[]> => {
        const rows = await original<T>(sql, params, opts);
        if (!changed && sql.startsWith('SELECT slug, title, compiled_truth, frontmatter') && params?.[0] === f.sourceId) {
          // Restore before entering a transaction: its executor must retain its
          // own receiver, rather than accidentally querying the outer engine.
          race.mockRestore();
          await changeRevision(f.sourceId, 'atoms/lesson-0'); changed = true;
        }
        return rows;
      });
      try { await expect(f.run()).rejects.toMatchObject({ reason: 'invalid_output' }); }
      finally { race.mockRestore(); }
      expect(changed).toBe(true); expect(calls()).toHaveLength(before); expect(await accepted(f.runId)).toBe(0);
      expect(await engine.getPage('concepts/review', { sourceId: f.sourceId })).toBeNull();
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
