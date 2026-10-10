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
import { makeGatewayThinkClient } from '../../src/eval/longmemeval/gateway-client.ts';
import { applyFactKeyArm, resolveFactKeyArm, newRetrievalArmOptions, armPins, type FactExtractor } from '../../src/eval/longmemeval/retrieval-arms.ts';
import { CODEX_FACT_KEYS_PROTOCOL } from '../../src/eval/longmemeval/codex-fact-keys-extract.ts';
import { installFixtureChunks } from './page-projection.ts';
import { runEvalLongMemEval } from '../../src/commands/eval-longmemeval.ts';
import { readProjectionSnapshot, embeddingInputContext } from '../../src/core/page-state/projections.ts';
import { embeddingInputHash } from '../../src/core/embedding-input-hash.ts';

interface Fixture {
  root: string; engine(): BrainEngine;
  run<T>(fn: (id: string) => Promise<T>, hooks?: Partial<CodexSubscriptionContext>, maxAttempts?: number): Promise<T>;
  reply(value: unknown): void; calls(): any[];
}
export function codexFactKeysContract(f: Fixture) { describe('native benchmark fact keys', () => {
  let scratch: PGLiteEngine, embedded: string[][], intervene: (() => Promise<void>) | undefined;
  const body = '**user:** I moved to the coast in June.', slug = 'chat/fact-key-fixture';
  const item = { fact: 'The user moved to the coast in June.', source_quote: 'I moved to the coast in June.' };
  const client = makeGatewayThinkClient();
  const hasVector = async () => (await scratch.getChunks(slug, { sourceId: 'default', includeEmbedding: true }))[0]!.embedding !== null;
  const seed = async (s = slug) => {
    await scratch.putPage(s, { type: 'note', title: 'Synthetic session', compiled_truth: body });
    await installFixtureChunks(scratch, s, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
  };
  const configure = (extractor: FactExtractor = 'paper') => resolveFactKeyArm({ ...newRetrievalArmOptions(), factKeys: 'page', factExtractor: extractor }, client);
  const paid = <T>(run: () => Promise<T>, cap: number | undefined = 0.1, key = `fact-keys-${randomUUID()}`) =>
    withSubscriptionAuxiliaryBudget(f.engine(), key, cap, run);
  const apply = async (extractor: FactExtractor = 'paper', slugs = [slug]) => {
    const { arm, spend } = (await configure(extractor))!;
    return applyFactKeyArm(scratch, slugs.map(slug => ({ slug, content: 'This caller body is unrelated and must not reach the model.' })), arm, spend);
  };
  const productionReply = () => ({ facts: [{ ...item, kind: 'fact', entity: null, confidence: 0.9,
    notability: 'medium', metric: null, value: null, unit: null, period: null, valid_from: null, attributed_to: 'user' }] });
  beforeAll(async () => { scratch = await createBenchmarkBrain(); });
  afterAll(async () => { await scratch.disconnect(); });
  beforeEach(async () => {
    await resetTables(scratch); embedded = []; intervene = undefined; f.reply({ items: [item] });
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fixture-not-a-credential' } });
    __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
      embedded.push(values); await intervene?.();
      return { embeddings: values.map(() => [1, ...Array(1535).fill(0)]), usage: { tokens: 17 } } as never;
    });
    await seed();
  });
  afterEach(() => { __setEmbedTransportForTests(null); configureGateway({ embedding_dimensions: 1536, env: {} }); });

  test.each(['paper', 'production'] as const)('%s extraction uses native schemas, canonical source and exact vector-input provenance', async extractor => {
    if (extractor === 'production') f.reply(productionReply());
    const before = f.calls().length;
    await f.run(() => paid(() => withSubscriptionScratch(scratch, async () => {
      expect(await apply(extractor)).toMatchObject({ pages_keyed: 1, chunks_keyed: 1, items: 1, calls: 1, cache_hits: 0,
        usd: null, billing: 'subscription', protocol: CODEX_FACT_KEYS_PROTOCOL, input_tokens: 21, output_tokens: 9 });
    })));
    expect(f.calls().length - before).toBe(1); expect(embedded).toHaveLength(1);
    expect(f.calls().at(-1)!.prompt).toContain('I moved to the coast');
    expect(f.calls().at(-1)!.prompt).not.toContain('caller body is unrelated');
    expect(embedded[0]![0]).toContain(`Facts: ${item.fact}`);
    const snapshot = (await readProjectionSnapshot(scratch, slug, 'default'))!, chunk = snapshot.chunks[0]!;
    expect(chunk.chunk_text).toBe(body); expect(await hasVector()).toBe(true);
    const hash = (await scratch.executeRaw<{ embedding_input_hash: string }>('SELECT embedding_input_hash FROM content_chunks WHERE id=$1', [chunk.id]))[0]!.embedding_input_hash;
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const plain = embeddingInputHash(embeddingInputContext({ column: snapshot.embeddingColumn, provenanceModel: snapshot.embeddingModel },
      snapshot.snapshot.page.title, null, snapshot.chunks), 'none', chunk);
    expect(hash).not.toBe(plain);
  });
  test.each(['paper', 'production'] as const)('%s raw proposals survive corpus reset without duplicate native usage', async extractor => {
    if (extractor === 'production') f.reply(productionReply());
    const before = f.calls().length;
    await f.run(() => paid(async () => {
      await withSubscriptionScratch(scratch, () => apply(extractor));
      await resetTables(scratch); await seed();
      expect(await withSubscriptionScratch(scratch, () => apply(extractor))).toMatchObject({ calls: 0, cache_hits: 1, input_tokens: 0, output_tokens: 0 });
    }), {}, 1);
    expect(f.calls().length - before).toBe(1); expect(embedded).toHaveLength(2);
  });
  test.each([{ raw: 'not json' }, { refusal: true }, { missingCompletion: true }, { items: [{ ...item, source_quote: 'Invented evidence' }] },
    { items: [item, item] }, { items: [{ ...item, source_id: 'forged' }] }])('invalid proposals never turn into empty keys or partial writes', async reply => {
    f.reply(reply); const before = f.calls().length;
    await expect(f.run(() => paid(() => withSubscriptionScratch(scratch, () => apply())))).rejects.toThrow();
    expect(f.calls().length - before).toBe(1); expect(embedded).toHaveLength(0);
    expect(await hasVector()).toBe(false);
  });
  test('production extraction failures propagate without becoming a cached empty list', async () => {
    f.reply({ refusal: true });
    await f.run(async id => {
      await expect(paid(() => withSubscriptionScratch(scratch, () => apply('production')))).rejects.toThrow('provider_error');
      expect(await f.engine().executeRaw('SELECT request_hash FROM codex_proposal_cache WHERE run_id=$1', [id])).toEqual([]);
    }); expect(embedded).toHaveLength(0);
  });
  test('valid empty facts stay explicit, fenced and reusable', async () => {
    f.reply({ items: [] }); const before = f.calls().length;
    await f.run(() => paid(async () => {
      expect(await withSubscriptionScratch(scratch, () => apply())).toMatchObject({ pages_keyed: 0, pages_empty: 1, items: 0 });
      expect(await withSubscriptionScratch(scratch, () => apply())).toMatchObject({ cache_hits: 1, calls: 0 });
    })); expect(f.calls().length - before).toBe(1); expect(embedded).toHaveLength(0);
  });
  test('without user turns the paper arm does not invent user facts from assistant text', async () => {
    await scratch.putPage(slug, { type: 'note', title: 'Assistant only', compiled_truth: '**assistant:** I moved to the coast.' });
    await installFixtureChunks(scratch, slug, [{ chunk_index: 0, chunk_text: '**assistant:** I moved to the coast.', chunk_source: 'compiled_truth' }]);
    const before = f.calls().length;
    await f.run(() => paid(() => withSubscriptionScratch(scratch, async () => { expect((await apply()).pages_empty).toBe(1); })));
    expect(f.calls().length).toBe(before); expect(embedded).toHaveLength(0);
  });
  test('stale second-page publication rolls back the entire prepared vector batch', async () => {
    const second = 'chat/second'; await seed(second);
    intervene = async () => {
      if (embedded.length === 2) await scratch.putPage(second, { type: 'note', title: 'Newer revision', compiled_truth: body + ' Changed.' });
    };
    await expect(f.run(() => paid(() => withSubscriptionScratch(scratch, () => apply('paper', [slug, second]))))).rejects.toThrow('private_fact_keys_projection_conflict');
    expect(embedded).toHaveLength(2);
    expect(await hasVector()).toBe(false);
  });
  test('cancellation after embedding cannot publish a batch or refund an accepted proposal', async () => {
    const abort = new AbortController(); intervene = async () => { abort.abort(); };
    await f.run(async id => {
      await expect(paid(() => withSubscriptionScratch(scratch, () => apply()))).rejects.toThrow();
      const [run] = await f.engine().executeRaw<{ accepted_turns: number }>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [id]);
      expect(Number(run!.accepted_turns)).toBe(1);
    }, { signal: abort.signal });
    expect(await hasVector()).toBe(false);
  });
  test('both native and auxiliary admission are required before the corresponding provider', async () => {
    await expect(paid(() => apply())).rejects.toMatchObject({ code: 'subscription_required' });
    await f.run(() => withSubscriptionScratch(scratch, async () => { await expect(apply()).rejects.toMatchObject({ code: 'subscription_auxiliary_budget_required' }); }));
    await expect(f.run(() => paid(() => withSubscriptionScratch(scratch, () => apply()), 1e-12))).rejects.toThrow();
    expect(embedded).toHaveLength(0);
  });
  test('host and target pins, injected clients, legacy cache and USD-only flags refuse', async () => {
    const before = f.calls().length;
    await f.run(() => paid(() => withSubscriptionScratch(scratch, async () => {
      const resolved = (await configure())!;
      for (const patch of [{ client: { create: async () => { throw new Error('forbidden SDK'); } } }, { cachePath: '/untrusted/cache.jsonl' }])
        await expect(applyFactKeyArm(scratch, [{ slug, content: body }], { ...resolved.arm, ...patch }, resolved.spend)).rejects.toThrow();
      for (const engine of [f.engine(), scratch]) {
        await engine.setConfig('models.tier.utility', 'anthropic:fixture');
        try { await expect(apply()).rejects.toMatchObject({ code: 'private_route_conflict' }); }
        finally { await engine.setConfig('models.tier.utility', ''); }
      }
    })));
    await expect(resolveFactKeyArm({ ...newRetrievalArmOptions(), factKeys: 'page', factKeysMaxUsdExplicit: true }, client)).rejects.toThrow('host subscription');
    expect(armPins({ ...newRetrievalArmOptions(), factKeys: 'page' }).retrieval_arms).toMatchObject({ fact_keys_protocol: CODEX_FACT_KEYS_PROTOCOL });
    expect(f.calls().length).toBe(before);
  });
  test('production configuration read errors cannot select default extraction instructions', async () => {
    const owner = new Proxy(f.engine(), { get(target, key) {
      if (key === 'getConfig') return async (name: string) => {
        if (name === 'facts.extraction_prompt_appendix') throw new Error('synthetic database detail');
        return target.getConfig(name);
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const before = f.calls().length;
    await expect(f.run(() => paid(() => withSubscriptionScratch(scratch, () => apply('production'))), { engine: owner }))
      .rejects.toThrow('private_facts_config_unavailable');
    expect(f.calls().length).toBe(before); expect(embedded).toHaveLength(0);
  });
  test('a stale host fence rejects the batch after paid embedding without publishing it', async () => {
    let stale = false; intervene = async () => { stale = true; };
    await expect(f.run(() => paid(() => withSubscriptionScratch(scratch, () => apply())), {
      checkAuthorityInTransaction: async () => { if (stale) throw new Error('synthetic stale owner'); },
    })).rejects.toThrow('synthetic stale owner');
    expect(await hasVector()).toBe(false);
  });
  test('changed chunk assignment changes exact input proof without changing canonical text', async () => {
    const second = '**user:** I adopted a cat.';
    await scratch.putPage(slug, { type: 'note', title: 'Synthetic session', compiled_truth: body + '\n\n' + second });
    await installFixtureChunks(scratch, slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: second, chunk_source: 'compiled_truth' }]);
    f.reply({ items: [item, { fact: 'The user adopted a cat.', source_quote: 'I adopted a cat.' }] });
    await f.run(() => paid(() => withSubscriptionScratch(scratch, async () => {
      const { arm, spend } = (await configure())!;
      await applyFactKeyArm(scratch, [{ slug, content: body }], { ...arm, assignment: 'page' }, spend);
      const previous = await scratch.executeRaw('SELECT embedding_input_hash FROM content_chunks ORDER BY chunk_index');
      await applyFactKeyArm(scratch, [{ slug, content: body }], { ...arm, assignment: 'chunk' }, spend);
      expect(await scratch.executeRaw('SELECT embedding_input_hash FROM content_chunks ORDER BY chunk_index')).not.toEqual(previous);
      expect((await scratch.getChunks(slug, { sourceId: 'default' })).map(c => c.chunk_text)).toEqual([body, second]);
      expect(spend.calls).toBe(1); expect(spend.cacheHits).toBe(1);
    })));
  });
  test('real hybrid benchmark applies native fact keys and reports unknown subscription cost', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-fact-keys-')), dataset = join(root, 'input.jsonl'), output = join(root, 'output.jsonl');
    const configPath = join(f.root, '.gbrain', 'config.json'), config = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(config), embedding_disabled: false }));
    writeFileSync(dataset, JSON.stringify({ question_id: 'fact-key-q', question_type: 'single-session-user', question: 'Where did I move?',
      answer: 'Coast', question_date: '2026-07-01', answer_session_ids: ['s1'], haystack_dates: ['2026-06-01'],
      haystack_sessions: [{ session_id: 's1', turns: [{ role: 'user', content: 'I moved to the coast in June.' }] }] }));
    try {
      await f.run(() => paid(() => runEvalLongMemEval([dataset, '--mode', 'balanced', '--fact-keys', 'page', '--reranker', 'off',
        '--no-trajectory', '--retrieval-only', '--no-embed-cache', '--by-type', '--output', output], { engine: scratch, exitOnError: false })));
      const rows = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows[0].fact_keys).toMatchObject({ pages_keyed: 1, calls: 1, usd: null, protocol: CODEX_FACT_KEYS_PROTOCOL });
      expect(rows[0].search_meta.vector_enabled).toBe(true);
    } finally { writeFileSync(configPath, config); rmSync(root, { recursive: true, force: true }); }
  });
}); }
