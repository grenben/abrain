import { beforeAll, afterAll, test, expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription } from '../../src/core/ai/subscription-context.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { withCodexRoleFixture, withDistinctCodexModels } from './codex-role-fixture.ts';

// The existing repair contract injects plain chat. These tests traverse the
// real runner, native schema, attempt store and revision-bound publication.
export function codexFenceRepairContract(factory: () => Promise<{ engine: BrainEngine; cleanup?: () => Promise<void> }>) {
  const root = mkdtempSync(join(tmpdir(), 'codex-fences-')), bin = join(root, 'fake.mjs');
  const control = join(root, 'reply.json'), capture = join(root, 'calls.jsonl'), path = join(root, '.gbrain', 'config.json');
  const keys = ['HOME', 'GBRAIN_HOME', 'CODEX_HOME'] as const, saved = keys.map(k => [k, process.env[k]] as const), fetch = globalThis.fetch;
  let engine: BrainEngine, cleanup: (() => Promise<void>) | undefined, unregister: () => void;
  const claim = 'Synthetic orchard ships quarterly';
  const row = `| 1 | ${claim} | fact | 0.9 | private | high | 2026-01-01 |  | chat | ctx |`;
  const header = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
  const body = `Intro.\n\n<!--- gbrain:facts:begin -->\n${row}\n<!--- gbrain:facts:end -->\n`;
  const proposal = () => ({ hold: false, tails: [], tables: [{ id: 'body:facts', table: `${header}\n${row}` }] });
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
    ({ engine, cleanup } = await factory()); await engine.initSchema(); configureGateway({ env: {} });
    await engine.setConfig('fences.repair.llm', 'true'); await engine.setConfig('fences.repair.max_usd_per_page', '0'); await engine.setConfig('fences.repair.max_usd_per_day', '0');
  });
  afterAll(async () => {
    await disposePersistenceConsumer(engine); await engine?.disconnect(); await cleanup?.(); unregister?.(); resetGateway(); globalThis.fetch = fetch;
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(root, { recursive: true, force: true });
  });
  async function fixture(file = false, input = body) {
    await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const sourceId = `fence-${randomUUID().slice(0, 8)}`, dir = join(root, sourceId); mkdirSync(dir);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, file ? dir : null]);
    await engine.putPage('notes/fence', { type: 'note', title: 'Synthetic fence', compiled_truth: input, timeline: '' }, { sourceId });
    if (file) {
      mkdirSync(join(dir, 'notes')); writeFileSync(join(dir, 'notes', 'fence.md'), `---\ntitle: Synthetic fence\ntype: note\n---\n${input}`);
      const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
      git('init', '-q'); git('config', 'user.name', 'Synthetic Fixture'); git('config', 'user.email', 'fixture@example.invalid');
      git('add', '--', 'notes/fence.md'); git('commit', '-qm', 'synthetic fixture');
      writeFileSync(join(dir, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n', { mode: 0o700 });
      await claimWorktree(engine, sourceId, dir);
    }
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const runId = randomUUID(); await createSubscriptionRun(engine, { runId, accountLane: runId, maxAttempts: 2, maxTurns: 2, deadline: new Date(Date.now() + 600000) });
    const run = async (apply = true, checkAuthority?: () => Promise<void>, expect?: string) => {
      const execute = async () => (await repairRunner(engine, { apply, noEmbed: true, logger: { info() {}, warn() {}, error() {} } }))
        .run('fences', await resolveRepairScope(engine, sourceId), { explicit: true, sourceFlag: sourceId, ...(file ? { only: ['notes/fence.md'] } : { slugs: ['notes/fence'] }), maxLlmUsd: 0, expect });
      return apply ? withCodexSubscription({ engine, runId, checkAuthority }, execute) : execute();
    };
    reply(proposal()); return { sourceId, runId, run, dir };
  }
  const accepted = async (runId: string) => (await engine.executeRaw<{ accepted_turns: number }>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [runId]))[0]!.accepted_turns;
  const current = async (sourceId: string) => (await engine.getPage('notes/fence', { sourceId }))!.compiled_truth;
  withCodexRoleFixture(root, ['fence-repair'], () => {
    test('exhausted allowance refuses repair without a call or write', async () => {
      const f = await fixture(), before = calls().length;
      await engine.executeRaw('UPDATE codex_subscription_runs SET attempts=max_attempts WHERE run_id=$1', [f.runId]);
      const result = await f.run(); expect(result.applied).toBe(0); expect(result.failed.length).toBeGreaterThan(0);
      expect(calls()).toHaveLength(before); expect(await current(f.sourceId)).toBe(body);
    });
    test('native repair publishes a canonical file and its matching database projection', async () => {
      const f = await fixture(true), preview = await f.run(false), result = await f.run(true, undefined, preview.preview_hash);
      expect(result.failed).toEqual([]); expect(result.outcome_items?.[0]).toMatchObject({ outcome: 'repaired' });
      const content = readFileSync(join(f.dir, 'notes', 'fence.md'), 'utf8');
      expect(content).toContain(header.split('\n')[0]!); expect(parseFactsFence(await current(f.sourceId)).facts.map(f => f.claim)).toEqual([claim]);
    });
    test('tail classification preserves exposure approval and repairs only the approved fence', async () => {
      const tail = `Intro.\n\n<!--- gbrain:facts:begin -->\n${header}\n${row}\n\nA synthetic paragraph with a pipe | in prose.\n`;
      const f = await fixture(false, tail), preview = await f.run(false);
      reply({ hold: false, tails: [{ id: 'body:facts', verdict: 'prose' }], tables: [] });
      const result = await f.run(true, undefined, preview.preview_hash);
      expect(result.failed).toEqual([]); expect(result.repaired).toBe(1);
      expect(await current(f.sourceId)).toContain('A synthetic paragraph with a pipe | in prose.');
    });
    test('deep tier repairs through the real runner with zero USD caps and unknown subscription cost', async () => withDistinctCodexModels(async models => {
      const f = await fixture(), before = calls().length, preview = await f.run(false);
      expect(preview.affected).toBe(1); expect(preview.cost.llm_usd).toBeNull(); expect(calls()).toHaveLength(before);
      const result = await f.run(true, undefined, preview.preview_hash);
      expect(result.outcome_items?.[0]).toMatchObject({ outcome: 'repaired' });
      expect(result.failed).toEqual([]); expect(result.repaired).toBe(1); expect(result.cost.llm_usd).toBeNull();
      expect(parseFactsFence(await current(f.sourceId)).facts.map(f => f.claim)).toEqual([claim]);
      expect(calls().slice(before).map(c => c.model)).toEqual([models.deep.slice('codex-cli:'.length)]); expect(await accepted(f.runId)).toBe(1);
    }));
    test.each(['claim', 'row', 'visibility', 'extra'])('a %s mutation fails the preservation gates before acceptance or publication', async kind => {
      const f = await fixture(), p = proposal();
      if (kind === 'claim') p.tables[0]!.table = p.tables[0]!.table.replace(claim, 'Invented claim');
      if (kind === 'row') p.tables[0]!.table += `\n${row.replace('| 1 |', '| 2 |')}`;
      if (kind === 'visibility') p.tables[0]!.table = p.tables[0]!.table.replace('private', 'world');
      if (kind === 'extra') p.tables.push(p.tables[0]!);
      reply(p); const result = await f.run();
      expect(result.applied).toBe(0); expect(result.failed.length).toBeGreaterThan(0); expect(await accepted(f.runId)).toBe(0); expect(await current(f.sourceId)).toBe(body);
    });
    test('a valid hold is explicit and leaves the page unchanged', async () => {
      const f = await fixture(); reply({ hold: true, tails: [], tables: [] });
      const result = await f.run(); expect(result.applied).toBe(0); expect(await current(f.sourceId)).toBe(body); expect(await accepted(f.runId)).toBe(1);
    });
    test('changed policy rejects a saved preview without a model call', async () => {
      const f = await fixture(), preview = await f.run(false), before = calls().length, config = JSON.parse(readFileSync(path, 'utf8'));
      config.private_codex.models.utility = 'codex-cli:changed'; writeFileSync(path, JSON.stringify(config));
      await expect(f.run(true, undefined, preview.preview_hash)).rejects.toThrow('policy_changed');
      expect(calls()).toHaveLength(before); expect(await current(f.sourceId)).toBe(body);
    });
    test('revocation after an accepted answer blocks publication', async () => {
      const f = await fixture();
      const result = await f.run(true, async () => { if (await accepted(f.runId)) {
        const config = JSON.parse(readFileSync(path, 'utf8')); config.private_codex.enabled_roles = []; writeFileSync(path, JSON.stringify(config));
      } });
      expect(result.applied).toBe(0); expect(await accepted(f.runId)).toBe(1); expect(await current(f.sourceId)).toBe(body);
    });
    test('the existing model-repair opt-in remains required', async () => {
      const f = await fixture(), before = calls().length; await engine.setConfig('fences.repair.llm', 'false');
      try { const result = await f.run(); expect(result.applied).toBe(0); expect(calls()).toHaveLength(before); }
      finally { await engine.setConfig('fences.repair.llm', 'true'); }
    });
  });
}
