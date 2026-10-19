import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { runEvalSuspectedContradictions } from '../../src/commands/eval-suspected-contradictions.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { loadTrend } from '../../src/core/eval-contradictions/trends.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const root = mkdtempSync(join(tmpdir(), 'codex-contradiction-pg-'));
const bin = join(root, 'fixture.mjs'), capture = join(root, 'calls.jsonl'), control = join(root, 'response.json');
const keys = ['HOME', 'GBRAIN_HOME', 'CODEX_HOME'] as const;
const saved = keys.map(key => [key, process.env[key]] as const);
const originalFetch = globalThis.fetch;
let engine: PostgresEngine | undefined, unregister: (() => void) | undefined;

beforeAll(async () => {
  if (!DATABASE_URL) return;
  assertSafeE2eDatabaseUrl(DATABASE_URL);
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
const text=readFileSync(${JSON.stringify(control)},'utf8');
writeFileSync(arg('--output-last-message'),text);
for(const event of [{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},
{type:'item.completed',item:{type:'agent_message',text}},
{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:4}}])console.log(JSON.stringify(event));
`;
  writeFileSync(bin, script, { mode: 0o700 });
  unregister = __registerCodexFixtureForTests(bin, createHash('sha256').update(script).digest('hex'));
  engine = new PostgresEngine();
  await engine.connect({ database_url: DATABASE_URL });
  await engine.initSchema();
  configureGateway({ env: {} });
});
afterAll(async () => {
  await engine?.disconnect(); unregister?.(); resetGateway(); globalThis.fetch = originalFetch;
  for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
});

test('private contradiction CLI completes retrieval, report and cache on PostgreSQL', async () => {
  if (!engine) return;
  const suffix = randomUUID().slice(0, 8);
  const entity = `Northstar${suffix}`;
  const query = `What was ${entity} revenue?`;
  const textA = `${entity} revenue was 10 million dollars.`;
  const textB = `${entity} revenue was 20 million dollars.`;
  const slugA = `notes/northstar-revenue-a-${suffix}`, slugB = `notes/northstar-revenue-b-${suffix}`;
  for (const [slug, text] of [[slugA, textA], [slugB, textB]] as const) {
    await engine.putPage(slug, { title: slug, type: 'note', compiled_truth: text });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' }]);
  }
  const retrieved = await hybridSearch(engine, query, { limit: 2 });
  expect(retrieved.map(row => row.slug).sort()).toEqual([slugA, slugB].sort());
  const quote = (text: string) => text.includes('10 million') ? 'revenue was 10 million' : 'revenue was 20 million';
  writeFileSync(control, JSON.stringify({ verdict: 'contradiction', severity: 'medium', axis: 'Northstar revenue',
    confidence: 0.9, resolution_kind: 'manual_review', source_quote_a: quote(retrieved[0]!.chunk_text),
    source_quote_b: quote(retrieved[1]!.chunk_text) }));
  const requestId = randomUUID();
  const args = ['run', '--query', query, '--judge', 'codex-cli:gpt-test', '--top-k', '2',
    '--budget-usd', '100', '--yes', '--codex-max-attempts', '2', '--codex-max-turns', '2',
    '--codex-deadline', new Date(Date.now() + 600_000).toISOString(), '--codex-request-id', requestId];
  await runEvalSuspectedContradictions(engine, args);
  expect(readFileSync(capture, 'utf8').trim().split('\n')).toHaveLength(1);
  const first = (await loadTrend(engine, 30))[0]!.report_json;
  expect(first.run_status).toBe('ok');
  expect(first.per_query[0]!.pairs_judged).toBe(1);
  expect(first.verdict_breakdown.contradiction).toBe(1);
  await runEvalSuspectedContradictions(engine, args);
  expect(readFileSync(capture, 'utf8').trim().split('\n')).toHaveLength(1);
  const second = (await loadTrend(engine, 30))[0]!.report_json;
  expect(second.per_query[0]!.pairs_cache_hit).toBe(1);
  const [allowance] = await engine.executeRaw<{ attempts: number; accepted_turns: number }>(
    'SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id LIKE $1', [`codex-eval:${requestId}:%`]);
  expect(Number(allowance?.attempts)).toBe(1);
  expect(Number(allowance?.accepted_turns)).toBe(1);
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$2)',
    [`synthetic-northstar-source-${suffix}`, `Synthetic Northstar source ${suffix}`]);
  await expect(runEvalSuspectedContradictions(engine, args))
    .rejects.toMatchObject({ code: 'subscription_identity_conflict' });
  expect(readFileSync(capture, 'utf8').trim().split('\n')).toHaveLength(1);
}, 120_000);
