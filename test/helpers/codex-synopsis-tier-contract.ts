import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { withSubscriptionScratch } from '../../src/core/ai/subscription-target.ts';
import { withSubscriptionAuxiliaryBudget } from '../../src/core/ai/subscription-auxiliary.ts';
import { configureGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { createBenchmarkBrain, resetTables } from '../../src/eval/longmemeval/harness.ts';
import { applySynopsisTier, resolveSynopsisTier, newSynopsisTierOptions, type SynopsisTierOptions } from '../../src/eval/longmemeval/synopsis-tier.ts';
import { resolveSearchMode } from '../../src/core/search/mode.ts';
import type { RetrievalPins } from '../../src/eval/longmemeval/run-config.ts';
import { CODEX_SYNOPSIS_VERSION } from '../../src/core/ai/codex-versions.ts';
import { installFixtureChunks } from './page-projection.ts';
import { runEvalLongMemEval } from '../../src/commands/eval-longmemeval.ts';

interface Fixture {
  root: string; engine(): BrainEngine;
  run<T>(fn: (id: string) => Promise<T>, hooks?: Partial<CodexSubscriptionContext>, maxAttempts?: number): Promise<T>;
  reply(value: unknown): void; calls(): any[];
}
export function codexSynopsisTierContract(f: Fixture) { describe('native benchmark synopsis tier', () => {
  let scratch: PGLiteEngine, embedded: string[][], intervene: (() => Promise<void>) | undefined, unknownUsage: boolean;
  const slug = 'chat/synopsis-fixture', chunk = 'Nebula launched in June. The launch succeeded.';
  const valid = { synopsis: 'Nebula launched in June.', source_quote: 'Nebula launched in June.' };
  const resolve = (opts: Partial<SynopsisTierOptions> = {}, pins = {} as RetrievalPins) => resolveSynopsisTier(
    resolveSearchMode({ mode: 'tokenmax' }), false, { ...newSynopsisTierOptions(), ...opts }, pins);
  const seed = async () => {
    await scratch.putPage(slug, { type: 'note', title: 'Nebula launch', compiled_truth: chunk });
    await installFixtureChunks(scratch, slug, [{ chunk_index: 0, chunk_text: chunk, chunk_source: 'compiled_truth' }]);
  };
  const paid = <T>(run: () => Promise<T>, cap: number | undefined = 0.1, key = `synopsis-${randomUUID()}`) =>
    withSubscriptionAuxiliaryBudget(f.engine(), key, cap, run);
  const apply = async () => applySynopsisTier(scratch, [{ slug }], (await resolve())!);
  beforeAll(async () => { scratch = await createBenchmarkBrain(); });
  afterAll(async () => { await scratch.disconnect(); });
  beforeEach(async () => {
    await resetTables(scratch); embedded = []; intervene = undefined; unknownUsage = false; f.reply(valid);
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fixture-not-a-credential' } });
    __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
      embedded.push(values); await intervene?.();
      return { embeddings: values.map(() => [1, ...Array(1535).fill(0)]), ...unknownUsage ? {} : { usage: { tokens: 17 } } } as never;
    });
    await seed();
  });
  afterEach(() => { __setEmbedTransportForTests(null); configureGateway({ embedding_dimensions: 1536, env: {} }); });

  test('native pins and defaults are sequential and subscription-priced', async () => {
    const pins = {} as RetrievalPins, tier = (await resolve({}, pins))!;
    expect(tier).toMatchObject({ concurrency: 1, chunkConcurrency: 1, spend: { usd: null, subscription: true } });
    expect(pins.contextual_synopsis).toMatchObject({ model: 'codex-cli:gpt-test', prompt_version: CODEX_SYNOPSIS_VERSION });
    expect(await resolveSynopsisTier(resolveSearchMode({ mode: 'balanced' }), false, newSynopsisTierOptions(), {} as RetrievalPins)).toBeNull();
  });
  test.each([{ cachePath: '/nonexistent/legacy.jsonl' }, { maxUsdExplicit: true }, { concurrencyExplicit: true, concurrency: 2 }])('legacy cache/cap or explicit parallelism cannot authorize private summaries', async opts => {
    await expect(resolve(opts)).rejects.toThrow('private synopsis requires');
  });
  test('real synopsis service publishes scratch vectors with separately settled embedding cost', async () => {
    const before = f.calls().length, key = `synopsis-${randomUUID()}`;
    await f.run(() => paid(() => withSubscriptionScratch(scratch, async () => {
      const result = await apply();
      expect(result).toMatchObject({ pages_synopsis: 1, pages_fallback: 0, calls: 1, cache_hits: 0, usd: null,
        billing: 'subscription', input_tokens: 21, output_tokens: 9, usage_complete: true });
    }), 0.1, key));
    expect(f.calls().length - before).toBe(1); expect(embedded).toHaveLength(1);
    expect(embedded[0]![0]).toContain('Nebula launched in June.');
    expect((await scratch.getPage(slug, { sourceId: 'default' }))!.contextual_retrieval_mode).toBe('per_chunk_synopsis');
    const [charge] = await f.engine().executeRaw<{ actual_cents: number; status: string }>('SELECT actual_cents,status FROM mcp_spend_reservations WHERE budget_key=$1', [key]);
    expect(charge!.status).toBe('settled'); expect(Number(charge!.actual_cents)).toBeGreaterThan(0);
    expect(await scratch.executeRaw('SELECT run_id FROM codex_proposal_cache')).toEqual([]);
  });
  test('cache survives corpus reset without charging another native call or copying measured tokens', async () => {
    const before = f.calls().length;
    await f.run(() => paid(async () => {
      await withSubscriptionScratch(scratch, apply);
      await resetTables(scratch); await seed();
      const result = await withSubscriptionScratch(scratch, apply);
      expect(result).toMatchObject({ calls: 0, cache_hits: 1, input_tokens: 0, output_tokens: 0, usd: null });
    }), {}, 1);
    expect(f.calls().length - before).toBe(1); expect(embedded).toHaveLength(2);
  });
  test('USD-only consent and foreign unscoped targets cannot dispatch', async () => {
    const before = f.calls().length;
    await expect(paid(apply)).rejects.toMatchObject({ code: 'subscription_required' });
    await f.run(async () => { await expect(paid(apply)).rejects.toMatchObject({ code: 'subscription_identity_conflict' }); });
    expect(f.calls().length).toBe(before); expect(embedded).toHaveLength(0);
  });
  test('subscription-only consent and exhausted auxiliary caps cannot publish vectors', async () => {
    const before = f.calls().length;
    await f.run(() => withSubscriptionScratch(scratch, async () => {
      await expect(apply()).rejects.toMatchObject({ code: 'subscription_auxiliary_budget_required' });
    })); expect(f.calls().length).toBe(before);
    await expect(f.run(() => paid(() => withSubscriptionScratch(scratch, apply), 1e-12))).rejects.toThrow();
    expect(embedded).toHaveLength(0);
    expect((await scratch.getPage(slug, { sourceId: 'default' }))!.contextual_retrieval_mode).toBeNull();
  });
  test.each([{ raw: 'malformed' }, { refusal: true }, { missingCompletion: true }, { ...valid, source_quote: 'Invented evidence' }])('native failures do not retry, cache a rejection, or publish title fallback', async value => {
    f.reply(value); const before = f.calls().length;
    await expect(f.run(() => paid(() => withSubscriptionScratch(scratch, apply)))).rejects.toThrow();
    expect(f.calls().length - before).toBe(1); expect(embedded).toHaveLength(0);
    expect((await scratch.getPage(slug, { sourceId: 'default' }))!.contextual_retrieval_mode).toBeNull();
  });
  test('host and scratch database model pins both fail before dispatch', async () => {
    const before = f.calls().length;
    for (const engine of [f.engine(), scratch]) {
      await engine.setConfig('models.contextual_synopsis', 'anthropic:fixture');
      try { await expect(f.run(() => paid(() => withSubscriptionScratch(scratch, apply)))).rejects.toMatchObject({ code: 'private_route_conflict' }); }
      finally { await engine.setConfig('models.contextual_synopsis', ''); }
    }
    expect(f.calls().length).toBe(before);
  });
  test('unknown embedding usage stays reserved and cannot be reported as free', async () => {
    unknownUsage = true; const key = `synopsis-${randomUUID()}`;
    await f.run(() => paid(() => withSubscriptionScratch(scratch, apply), 0.1, key));
    const [hold] = await f.engine().executeRaw('SELECT status,actual_cents,usage_unknown_reason FROM mcp_spend_reservations WHERE budget_key=$1', [key]);
    expect(hold).toEqual({ status: 'pending', actual_cents: null, usage_unknown_reason: 'provider_usage_unknown' });
  });
  test('source drift after embedding fails once and leaves the page uncompleted', async () => {
    intervene = () => scratch.executeRaw("UPDATE sources SET incarnation=gen_random_uuid() WHERE id='default'").then(() => {});
    const before = f.calls().length;
    await expect(f.run(() => paid(() => withSubscriptionScratch(scratch, apply)))).rejects.toThrow();
    expect(f.calls().length - before).toBe(1); expect(embedded).toHaveLength(1);
    expect((await scratch.getPage(slug, { sourceId: 'default' }))!.contextual_retrieval_mode).toBeNull();
  });
  test('fenced empty pages are distinct from missing pages and require no model call', async () => {
    const before = f.calls().length;
    await scratch.putPage('chat/empty', { type: 'note', title: 'Empty', compiled_truth: '' });
    await f.run(() => paid(() => withSubscriptionScratch(scratch, async () => {
      const tier = (await resolve())!;
      expect(await applySynopsisTier(scratch, [{ slug: 'chat/empty' }], tier)).toMatchObject({ pages_empty: 1, calls: 0, chunks: 0 });
      await expect(applySynopsisTier(scratch, [{ slug: 'chat/missing' }], tier)).rejects.toThrow('private_eval_synopsis_publication_failed');
    })));
    expect(f.calls().length).toBe(before); expect(embedded).toHaveLength(0);
  });
  test('a nonempty page with missing chunks cannot be stamped as clean zero', async () => {
    const before = f.calls().length;
    await scratch.putPage('chat/unindexed', { type: 'note', title: 'Unindexed', compiled_truth: chunk });
    await expect(f.run(() => paid(() => withSubscriptionScratch(scratch, async () =>
      applySynopsisTier(scratch, [{ slug: 'chat/unindexed' }], (await resolve())!)))))
      .rejects.toThrow('private_contextual_projection_incomplete');
    expect(f.calls().length).toBe(before); expect(embedded).toHaveLength(0);
    expect((await scratch.getPage('chat/unindexed', { sourceId: 'default' }))!.contextual_retrieval_mode).toBeNull();
  });
  test('injected generators, duplicate pages and oversized batches refuse before inference', async () => {
    const before = f.calls().length;
    await f.run(() => paid(() => withSubscriptionScratch(scratch, async () => {
      const tier = (await resolve())!;
      await expect(applySynopsisTier(scratch, [{ slug }], tier, async () => ({ kind: 'success', synopsis: 'Forged' }))).rejects.toThrow('native provider');
      await expect(applySynopsisTier(scratch, [{ slug }, { slug }], tier)).rejects.toMatchObject({ reason: 'invalid_input' });
      await expect(applySynopsisTier(scratch, Array.from({ length: 257 }, (_, i) => ({ slug: `chat/${i}` })), tier)).rejects.toMatchObject({ reason: 'invalid_input' });
    })));
    expect(f.calls().length).toBe(before);
  });
  test('lost host ownership after embedding prevents a successful scratch publication', async () => {
    let stale = false; intervene = async () => { stale = true; };
    await expect(f.run(() => paid(() => withSubscriptionScratch(scratch, apply)), {
      checkAuthorityInTransaction: async () => { if (stale) throw new Error('synthetic replacement owner'); },
    })).rejects.toThrow();
    expect(embedded).toHaveLength(1);
    expect((await scratch.getPage(slug, { sourceId: 'default' }))!.contextual_retrieval_mode).toBeNull();
  });
  test('cancellation after embedding keeps the accepted attempt but rejects publication', async () => {
    const abort = new AbortController(); intervene = async () => { abort.abort(); };
    await f.run(async id => {
      await expect(paid(() => withSubscriptionScratch(scratch, apply))).rejects.toThrow();
      const [row] = await f.engine().executeRaw<{ attempts: number; accepted_turns: number }>('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [id]);
      expect(Number(row!.attempts)).toBe(1); expect(Number(row!.accepted_turns)).toBe(1);
    }, { signal: abort.signal });
    expect((await scratch.getPage(slug, { sourceId: 'default' }))!.contextual_retrieval_mode).toBeNull();
  });
  test('actual tokenmax benchmark records native synopses and separately metered embedding calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-synopsis-bench-')), dataset = join(root, 'input.jsonl'), output = join(root, 'output.jsonl');
    writeFileSync(dataset, JSON.stringify({ question_id: 'synopsis-q', question_type: 'single-session-user', question: 'When did Nebula launch?',
      answer: 'June', question_date: '2026-07-01', answer_session_ids: ['s1'], haystack_dates: ['2026-06-01'],
      haystack_sessions: [{ session_id: 's1', turns: [{ role: 'user', content: chunk }] }] }));
    const configPath = join(f.root, '.gbrain', 'config.json'), config = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(config), embedding_disabled: false }));
    try {
      await f.run(() => paid(() => runEvalLongMemEval([dataset, '--mode', 'tokenmax', '--reranker', 'off', '--no-trajectory',
        '--retrieval-only', '--no-embed-cache', '--by-type', '--output', output], { engine: scratch, exitOnError: false })));
      const rows = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows[0].contextual_synopsis).toMatchObject({ pages_synopsis: 1, calls: 1, usd: null, billing: 'subscription' });
      expect(rows[1].run_config.contextual_synopsis.prompt_version).toBe(CODEX_SYNOPSIS_VERSION);
      expect(embedded.length).toBeGreaterThan(1);
      expect(rows[0].search_meta.vector_enabled).toBe(true);
    } finally { writeFileSync(configPath, config); rmSync(root, { recursive: true, force: true }); }
  });
}); }
