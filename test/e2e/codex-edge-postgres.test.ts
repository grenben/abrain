import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription } from '../../src/core/ai/subscription-context.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { applyEdgeProposal, runPhaseEdgeContradictions, undoEdgeProposal } from '../../src/core/cycle/edge-contradictions.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const databaseUrl = process.env.DATABASE_URL;
const root = mkdtempSync(join(tmpdir(), 'codex-edge-pg-'));
const bin = join(root, 'fixture.mjs'), capture = join(root, 'calls.jsonl'), control = join(root, 'response.json');
const keys = ['HOME', 'GBRAIN_HOME', 'CODEX_HOME'] as const;
const saved = keys.map(key => [key, process.env[key]] as const);
const originalFetch = globalThis.fetch;
let engine: PostgresEngine | undefined, unregister: (() => void) | undefined;

const reply = (value: unknown) => writeFileSync(control, JSON.stringify(value));
const calls = () => readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

beforeAll(async () => {
  if (!databaseUrl) return;
  assertSafeE2eDatabaseUrl(databaseUrl);
  for (const key of keys) process.env[key] = root;
  globalThis.fetch = (() => { throw new Error('forbidden network'); }) as unknown as typeof fetch;
  mkdirSync(join(root, '.gbrain'));
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ embedding_disabled: true,
    private_codex: { mode: 'strict', model: 'codex-cli:gpt-test', bin } }));
  writeFileSync(capture, '');
  const script = `#!${Bun.which('node')}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
const schema=JSON.parse(readFileSync(arg('--output-schema'),'utf8'));
appendFileSync(${JSON.stringify(capture)},JSON.stringify({schema,prompt:readFileSync(0,'utf8')})+'\\n');
const value=JSON.parse(readFileSync(${JSON.stringify(control)},'utf8'));
const text=value.raw??JSON.stringify(value);
writeFileSync(arg('--output-last-message'),text);
for(const event of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},
{type:'item.completed',item:{type:'agent_message',text}},
{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:4}}])console.log(JSON.stringify(event));
`;
  writeFileSync(bin, script, { mode: 0o700 });
  unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(script).digest('hex'));
  engine = new PostgresEngine();
  await engine.connect({ database_url: databaseUrl });
  await engine.initSchema();
  configureGateway({ env: {} });
});
afterAll(async () => {
  await engine?.disconnect(); unregister?.(); resetGateway(); globalThis.fetch = originalFetch;
  for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
});

test('private PostgreSQL edge lifecycle: propose, accept, undo, explicit apply and invalid verdict', async () => {
  if (!engine) return;
  const db = engine, suffix = randomUUID().slice(0, 8);
  const context: OperationContext = { engine: db, config: { engine: 'postgres' },
    logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: false, sourceId: 'default' };
  const put = async (slug: string, title: string, type: string, body: string) => {
    await operations.find(op => op.name === 'put_page')!.handler(context, {
      slug, content: `---\ntype: ${type}\ntitle: ${title}\n---\n\n${body}`,
    });
  };
  const seed = async (name: string) => {
    const a = `companies/${name}-a-${suffix}`, b = `companies/${name}-b-${suffix}`;
    const subject = `people/${name}-${suffix}`;
    await put(a, `${name} A`, 'company', `A company ${suffix} A.`);
    await put(b, `${name} B`, 'company', `A company ${suffix} B.`);
    await put(subject, name, 'person',
      `${name} works at [${name} A](../${a}) and [${name} B](../${b}).\n\n` +
      `## Timeline\n\n- **2019-02-01** | test — joined [${name} A](../${a})\n` +
      `- **2024-05-01** | test — joined [${name} B](../${b})`);
    return { a, b, subject };
  };
  const allowance = async <T>(fn: (runId: string) => Promise<T>) => {
    const runId = `edge-pg-${randomUUID()}`;
    await createSubscriptionRun(db, { runId, accountLane: runId, maxAttempts: 8, maxTurns: 8,
      deadline: new Date(Date.now() + 600_000) });
    return withCodexSubscription({ engine: db, runId }, () => fn(runId));
  };
  const accounting = async (runId: string) => (await db.executeRaw<{ attempts: number; accepted_turns: number }>(
    'SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [runId]))[0]!;
  const proposal = async (subject: string) => (await db.executeRaw<{ id: number; status: string; model: string }>(
    `SELECT id,status,model FROM link_edge_proposals WHERE from_page_id=(SELECT id FROM pages WHERE slug=$1) ORDER BY id DESC LIMIT 1`,
    [subject]))[0];
  const live = async (subject: string) => (await db.executeRaw<{ slug: string }>(
    `SELECT t.slug FROM link_relationships lr JOIN pages f ON f.id=lr.from_page_id
       JOIN pages t ON t.id=lr.to_page_id WHERE f.slug=$1 AND lr.link_type='works_at'
       AND lr.scope='all' AND lr.valid_ranges @> CURRENT_DATE ORDER BY t.slug`, [subject])).map(row => row.slug);
  const auditPath = join(root, 'edge-budget.jsonl');

  await db.unsetConfig('dream.edge_contradictions.mode');
  const first = await seed('codex-edge-propose');
  reply({ pairs: [{ a: 1, b: 2, conflict: true, confidence: 0.9 }] });
  const initialCalls = calls().length;
  await allowance(async runId => {
    const result = await runPhaseEdgeContradictions(db, { auditPath });
    expect(result.totals?.proposed).toBeGreaterThanOrEqual(1);
    expect(result.totals?.applied).toBe(0);
    expect(Number((await accounting(runId)).accepted_turns)).toBeGreaterThanOrEqual(1);
  });
  expect(calls().length).toBeGreaterThan(initialCalls);
  expect(calls().at(-1)!.schema.properties.pairs.minItems).toBe(1);
  const firstProposal = await proposal(first.subject);
  expect(firstProposal).toMatchObject({ status: 'proposed', model: 'codex-cli:gpt-test' });
  expect(await live(first.subject)).toEqual([first.a, first.b]);
  expect((await applyEdgeProposal(db, Number(firstProposal!.id))).status).toBe('applied');
  expect(await live(first.subject)).toEqual([first.b]);
  expect((await undoEdgeProposal(db, Number(firstProposal!.id))).status).toBe('undone');
  expect(await live(first.subject)).toEqual([first.a, first.b]);

  await db.setConfig('dream.edge_contradictions.mode', 'apply');
  const second = await seed('codex-edge-apply');
  await allowance(async runId => {
    const result = await runPhaseEdgeContradictions(db, { auditPath });
    expect(result.totals?.applied).toBeGreaterThanOrEqual(1);
    expect(Number((await accounting(runId)).accepted_turns)).toBeGreaterThanOrEqual(1);
  });
  expect((await proposal(second.subject))?.status).toBe('applied');
  expect(await live(second.subject)).toEqual([second.b]);

  await db.setConfig('dream.edge_contradictions.mode', 'propose');
  const bad = await seed('codex-edge-invalid');
  reply({ pairs: [] });
  await allowance(async runId => {
    const result = await runPhaseEdgeContradictions(db, { auditPath });
    expect(result.totals?.errors).toBeGreaterThanOrEqual(1);
    expect(Number((await accounting(runId)).accepted_turns)).toBe(0);
    expect(Number((await accounting(runId)).attempts)).toBeGreaterThanOrEqual(1);
  });
  expect((await proposal(bad.subject))?.status).toBe('error');
  expect(await live(bad.subject)).toEqual([bad.a, bad.b]);
}, 120_000);
