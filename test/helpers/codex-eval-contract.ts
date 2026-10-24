import { createBenchmarkBrain } from '../../src/eval/longmemeval/harness.ts';
import { beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import type { CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { makeGatewayThinkClient } from '../../src/eval/longmemeval/gateway-client.ts';
import { generateAnswer } from '../../src/eval/longmemeval/reader.ts';
import { extractAndInsertClaims, makeAliasMap } from '../../src/eval/longmemeval/extract.ts';
import { CODEX_READER_ABSTENTION, CODEX_READER_PROTOCOL, CODEX_JUDGE_PROTOCOL } from '../../src/eval/longmemeval/codex-protocols.ts';
import { withCodexProposalCache } from '../../src/core/ai/codex-proposal-cache.ts';
import { digest } from '../../src/core/persistence/digest.ts';
import { chat } from '../../src/core/ai/gateway.ts';
import { runJudge, BudgetLedger } from '../../src/eval/shared/judge-runner.ts';
import { judgeRow, classifyJudgeResponse } from '../../src/eval/longmemeval/judge.ts';
import { buildQaAccuracy } from '../../src/eval/longmemeval/qa-accuracy.ts';
import { runEvalLongMemEval } from '../../src/commands/eval-longmemeval.ts';
import { configPath } from '../../src/core/config-path.ts';
import { resolveEvalModels } from '../../src/eval/longmemeval/codex-config.ts';

interface Fixture {
  engine(): BrainEngine; sourceId: string;
  run<T>(fn: (id: string) => Promise<T>, hooks?: Partial<CodexSubscriptionContext>, maxAttempts?: number): Promise<T>;
  reply(value: unknown): void; calls(): any[];
}
export function codexEvalContract(f: Fixture) { describe('native evaluation roles', () => {
  const model = 'codex-cli:gpt-test', body = 'On 2026-06-02, Aster moved to the coast.', client = makeGatewayThinkClient();
  let slug: string, sessionId: string;
  const validReader = () => ({ answer: 'Aster moved to the coast.', status: 'answered', citations: [{ session_id: sessionId, quote: body }] });
  const claim = { entity: 'Aster', metric: null, value: null, unit: null, period: null,
    event_type: 'location_change', valid_from: '2026-06-02', text: body };
  const read = (c = client, question = 'Where did Aster move?', m = model) => generateAnswer(c, { question },
    [{ slug, chunk_text: body, title: 'Synthetic session', score: 1 } as SearchResult], [{ slug, content: body }], new Map(), m);
  const extract = (extra: Partial<Parameters<typeof extractAndInsertClaims>[0]> = {}) => extractAndInsertClaims({
    engine: f.engine(), client, model, sessionSlug: slug, sessionId, sessionBody: body, sourceId: f.sourceId, aliasMap: makeAliasMap(), ...extra });
  const facts = () => f.engine().executeRaw<{ fact: string; source_session: string; source_id: string }>(
    'SELECT fact,source_session,source_id FROM facts WHERE source_markdown_slug=$1 AND source_id=$2', [slug, f.sourceId]);
  const judge = () => runJudge({ client: chat, model, prompt: 'Does the candidate answer match the supplied reference?', maxTokens: 16,
    temperature: 0, parse: classifyJudgeResponse, retries: 5 });
  const cache = <T>(run: () => Promise<T>) => withCodexProposalCache({ namespace: 'eval-contract', bindingHash: digest(slug) }, run);
  const benchmark = () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-eval-')), dataset = join(root, 'fixture.jsonl'), output = join(root, 'result.jsonl');
    const questions = [1, 2].map(i => ({ question_id: `native-reader-${i}`, question_type: 'single-session-user',
      question: 'Where did Aster move?', answer: 'The coast', question_date: '2026-06-03', answer_session_ids: ['s1'],
      haystack_dates: ['2026-06-02'], haystack_sessions: [{ session_id: 's1', turns: [{ role: 'user', content: body }] }] }));
    writeFileSync(dataset, questions.map(q => JSON.stringify(q)).join('\n'));
    f.reply({ byRole: { reader: { ...validReader(), citations: [{ session_id: '__first_session__', quote: body }] }, judge: { answer: 'yes' } } });
    return { root, dataset, output };
  };
  beforeEach(async () => {
    sessionId = `s-${randomUUID()}`; slug = `chat/${sessionId}`;
    await f.engine().putPage(slug, { type: 'note', title: 'Synthetic session', compiled_truth: body }, { sourceId: f.sourceId });
  });
  test('reader uses native evidence schema, preserves usage and retains validated citations', async () => {
    f.reply(validReader()); const before = f.calls().length;
    await f.run(async () => {
      const answer = await read(); expect(answer).toMatchObject({ text: 'Aster moved to the coast.', finish_reason: 'end_turn',
        usage: { total_input_tokens: 21, output_tokens: 9 }, native: { protocol: CODEX_READER_PROTOCOL, citations: validReader().citations } });
    });
    expect(f.calls().length - before).toBe(1); const wire = f.calls().at(-1)!;
    expect(wire.args).toContain('--output-schema'); expect(wire.mode).toBe(0o600); expect(wire.schema.required).toContain('citations');
    expect(wire.prompt).toContain(body);
  });
  test('reader abstention is explicit and distinct from a malformed empty answer', async () => {
    f.reply({ answer: CODEX_READER_ABSTENTION, status: 'abstained', citations: [] });
    await f.run(async () => { expect((await read()).native?.status).toBe('abstained'); });
    f.reply({ answer: '', status: 'abstained', citations: [] });
    await f.run(async () => { await expect(read()).rejects.toMatchObject({ reason: 'invalid_output' }); });
  });
  test.each(['foreign', 'question', 'duplicate', 'missing', 'forged', 'refusal', 'completion'])('reader rejects unsupported evidence/lifecycle (%s)', async kind => {
    const v: any = validReader();
    if (kind === 'foreign') v.citations[0].session_id = 'foreign';
    if (kind === 'question') v.citations[0].quote = 'Secret invented fact';
    if (kind === 'duplicate') v.citations.push(v.citations[0]);
    if (kind === 'missing') v.citations = [];
    if (kind === 'forged') v.evidence_hash = 'forged';
    if (kind === 'refusal') v.refusal = true;
    if (kind === 'completion') v.missingCompletion = true;
    f.reply(v); await f.run(async id => {
      await expect(read(client, 'Secret invented fact')).rejects.toThrow();
      const [r] = await f.engine().executeRaw<{ accepted_turns: number }>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [id]);
      expect(Number(r!.accepted_turns)).toBe(0);
    });
  });
  test('reader refuses injected clients, conflicting models, absent grants and oversized requests', async () => {
    f.reply(validReader()); const before = f.calls().length;
    await expect(read()).rejects.toMatchObject({ code: 'subscription_required' });
    await f.run(async () => {
      await expect(read({ create: async () => { throw new Error('forbidden injected inference'); } })).rejects.toMatchObject({ reason: 'invalid_input' });
      await expect(read(client, 'Where?', 'anthropic:fixture')).rejects.toMatchObject({ code: 'private_route_conflict' });
      await expect(read(client, 'x'.repeat(180001))).rejects.toMatchObject({ reason: 'invalid_input' });
    }); expect(f.calls().length).toBe(before);
  });
  test('reader cache revalidates raw evidence without charging tokens twice', async () => {
    f.reply(validReader()); const before = f.calls().length;
    await cache(() => f.run(async () => {
      await read(); expect(await read()).toMatchObject({ usage: null, native: { cache_hit: true } });
    }, {}, 1)); expect(f.calls().length - before).toBe(1);
  });
  test('extractor validates all rows before source-scoped insertion with transcript provenance', async () => {
    f.reply({ claims: [claim] }); await f.run(async () => { expect(await extract()).toEqual({ inserted: 1, parsed: 1, cacheHit: false }); });
    expect(await facts()).toEqual([{ fact: body, source_session: sessionId, source_id: f.sourceId }]);
    expect(f.calls().at(-1)!.schema.required).toContain('claims');
  });
  test.each(['malformed', 'quote', 'entity', 'date', 'numeric', 'both', 'duplicate', 'authority'])('invalid extraction never inserts a partial batch (%s)', async kind => {
    const c: any = { ...claim };
    if (kind === 'quote') c.text = 'Invented assertion';
    if (kind === 'entity') c.entity = 'Unrelated';
    if (kind === 'date') c.valid_from = '2026-02-30';
    if (kind === 'numeric') Object.assign(c, { metric: 'team_size', value: 99, event_type: null });
    if (kind === 'both') Object.assign(c, { metric: 'team_size', value: 2 });
    if (kind === 'authority') c.source_id = 'forged';
    f.reply(kind === 'malformed' ? { raw: 'bad JSON' } : { claims: [claim, c] });
    await f.run(async () => { await expect(extract()).rejects.toMatchObject({ reason: 'invalid_output' }); });
    expect(await facts()).toHaveLength(0);
  });
  test('valid empty extraction can be reused but refusal cannot become zero facts', async () => {
    f.reply({ claims: [] }); const before = f.calls().length;
    await cache(() => f.run(async () => {
      expect(await extract()).toEqual({ inserted: 0, parsed: 0, cacheHit: false });
      expect(await extract()).toEqual({ inserted: 0, parsed: 0, cacheHit: true });
    })); expect(f.calls().length - before).toBe(1);
    f.reply({ refusal: true }); await f.run(async () => { await expect(extract()).rejects.toMatchObject({ reason: 'refusal' }); });
  });
  test('extractor accepts an explicitly supplied session date and refuses stale publication', async () => {
    f.reply({ claims: [{ ...claim, text: 'Aster moved to the coast.' }] });
    await f.run(async () => { expect((await extract({ sessionBody: 'Aster moved to the coast.', sessionDate: '2026/06/02 (Tue) 10:00' })).inserted).toBe(1); });
    await f.engine().executeRaw('DELETE FROM facts WHERE source_markdown_slug=$1 AND source_id=$2', [slug, f.sourceId]);
    f.reply({ claims: [claim] });
    await f.run(async () => { await expect(extract()).rejects.toThrow('fixture stale publication'); },
      { checkAuthorityInTransaction: async () => { throw new Error('fixture stale publication'); } });
    expect(await facts()).toHaveLength(0);
  });
  test('entity lookup failure cannot become a guessed attribution', async () => {
    f.reply({ claims: [claim] });
    const broken = new Proxy(f.engine(), { get(target, key) {
      if (key === 'executeRaw') return async (...args: Parameters<BrainEngine['executeRaw']>) => {
        if (args[0].includes('AS connection_count')) throw new Error('synthetic private database detail');
        return target.executeRaw(...args);
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await f.run(async () => { await expect(extract({ engine: broken })).rejects.toThrow('private_eval_entity_resolution_failed'); });
    expect(await facts()).toHaveLength(0);
  });
  test('source changes and cancellation at the publication fence roll back all facts', async () => {
    f.reply({ claims: [claim] });
    await f.run(async () => { await expect(extract()).rejects.toMatchObject({ code: 'subscription_identity_conflict' }); }, {
      checkAuthorityInTransaction: async tx => { await tx.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [f.sourceId]); },
    });
    expect(await facts()).toHaveLength(0);
    const abort = new AbortController();
    await f.run(async () => { await expect(extract()).rejects.toMatchObject({ reason: 'aborted' }); }, {
      signal: abort.signal, checkAuthorityInTransaction: async () => { abort.abort(); },
    }); expect(await facts()).toHaveLength(0);
  });
  test('valid empty extraction still requires the current publication fence', async () => {
    f.reply({ claims: [] });
    await f.run(async () => { await expect(extract()).rejects.toThrow('fixture empty fence lost'); }, {
      checkAuthorityInTransaction: async () => { throw new Error('fixture empty fence lost'); },
    }); expect(await facts()).toHaveLength(0);
  });
  test('judge uses a native verdict and preserves unknown subscription cost', async () => {
    f.reply({ answer: 'yes' });
    await f.run(async () => { expect(await judge()).toMatchObject({ kind: 'verdict', verdict: 'correct', raw: 'yes',
      cost_usd: null, attempts: 1, usage: { input_tokens: 21, output_tokens: 9 }, native: { protocol: CODEX_JUDGE_PROTOCOL } }); });
    expect(f.calls().at(-1)!.schema.properties.answer.enum).toEqual(['yes', 'no']);
  });
  test.each([{ raw: 'yes' }, { answer: 'maybe' }, { refusal: true }, { missingCompletion: true }])('judge failures remain errors with no automatic retry', async value => {
    f.reply(value); const before = f.calls().length;
    await f.run(async () => { const out = await judge(); expect(out.kind).toBe('error'); expect(out.cost_usd).toBeNull(); expect(out.usage).toBeNull(); expect(out.attempts).toBeNull(); });
    expect(f.calls().length - before).toBe(1);
  });
  test('real judge row and aggregate retain errors, unknown total and known paid subtotal', async () => {
    const ledger = new BudgetLedger(1, null), input = { question_id: 'synthetic-q', question_type: 'multi-session', question: 'Where?', answer: 'Coast', hypothesis: 'Coast' };
    f.reply({ answer: 'no' }); const good = await f.run(() => judgeRow(input, { client: chat, model, ledger, configHashFor: () => 'fixture-hash' }));
    expect(good).toMatchObject({ judge_correct: false, judge_cost_usd: null });
    f.reply({ raw: 'not-json' }); const bad = await f.run(() => judgeRow(input, { client: chat, model, ledger, configHashFor: () => 'fixture-hash' }));
    expect(bad.judge_correct).toBeUndefined(); expect(bad.judge_error).toBe('malformed');
    const qa = buildQaAccuracy([{ ...input, ...good }, { ...input, ...bad, question_id: 'bad' },
      { question_id: 'paid', hypothesis: 'Paid', judge_correct: true, judge_cost_usd: 0.125 }], {
      judgeModel: model, judgePromptVersion: 'fixture', judgeConfigHash: 'fixture', estCostUsd: null, runCostUsd: ledger.costUsd, methodologyNote: 'synthetic', resamples: 10,
    });
    expect(qa).toMatchObject({ actual_cost_usd: null, known_priced_cost_usd: 0.125, unpriced_judge_rows: 2, run_cost_usd: null, complete: false, judge_errors: 1 });
    expect(ledger.snapshot()).toMatchObject({ actual_usd: null, unpriced_calls: 2 });
  });
  test('a reader-only benchmark does not require disabled judge or extractor roles', async () => {
    const path = configPath(), saved = readFileSync(path, 'utf8'), config = JSON.parse(saved);
    const { root, dataset, output } = benchmark(), before = f.calls().length;
    config.private_codex.enabled_roles = ['longmemeval-reader'];
    try {
      writeFileSync(path, JSON.stringify(config));
      await f.run(() => runEvalLongMemEval([dataset, '--keyword-only', '--no-trajectory', '--no-embed-cache', '--output', output], { exitOnError: false }));
      expect(f.calls().length - before).toBe(2);
      await f.run(async () => {
        await expect(runEvalLongMemEval([dataset, '--keyword-only', '--no-trajectory', '--no-embed-cache', '--judge', '--output', output], { exitOnError: false }))
          .rejects.toMatchObject({ code: 'private_role_disabled' });
      });
      expect(f.calls().length - before).toBe(2);
    } finally { writeFileSync(path, saved); rmSync(root, { recursive: true, force: true }); }
  });
  test('real keyword benchmark preserves external admission across question database resets', async () => {
    const { root, dataset, output } = benchmark();
    const before = f.calls().length;
    try {
      await f.run(async id => {
        await runEvalLongMemEval([dataset, '--keyword-only', '--no-trajectory', '--no-embed-cache', '--by-type', '--judge', '--output', output], { exitOnError: false });
        const [run] = await f.engine().executeRaw<{ attempts: number; accepted_turns: number }>('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [id]);
        expect(Number(run!.attempts)).toBe(4); expect(Number(run!.accepted_turns)).toBe(4);
      });
      const rows = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows).toHaveLength(3);
      for (const row of rows.slice(0, 2)) expect(row).toMatchObject({ reader_model: model, reader_native: { protocol: CODEX_READER_PROTOCOL },
        judge_model: model, judge_correct: true, judge_cost_usd: null, judge_native: { protocol: CODEX_JUDGE_PROTOCOL } });
      expect(rows[2].qa_accuracy).toMatchObject({ complete: true, actual_cost_usd: null, run_cost_usd: null, unpriced_judge_rows: 2 });
      expect(f.calls().length - before).toBe(4);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('real benchmark extracts source-scoped facts across resets with host admission intact', async () => {
    const { root, dataset, output } = benchmark(), scratch = await createBenchmarkBrain(), before = f.calls().length;
    f.reply({ byRole: { extractor: { claims: [claim] }, reader: { ...validReader(), citations: [{ session_id: '__first_session__', quote: body }] }, judge: { answer: 'yes' } } });
    try {
      await f.run(async id => {
        await runEvalLongMemEval([dataset, '--keyword-only', '--no-embed-cache', '--by-type', '--judge', '--output', output], { engine: scratch, exitOnError: false });
        const [run] = await f.engine().executeRaw<{ attempts: number; accepted_turns: number }>('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [id]);
        expect(Number(run!.attempts)).toBe(6); expect(Number(run!.accepted_turns)).toBe(6);
      }, {}, 6);
      const rows = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows[2].qa_accuracy.complete).toBe(true);
      expect(await scratch.executeRaw('SELECT fact,source_id,source_session FROM facts')).toEqual([{ fact: body, source_id: 'default', source_session: 's-edb2d7971f' }]);
      expect(await scratch.executeRaw('SELECT run_id FROM codex_subscription_runs')).toEqual([]);
      expect(f.calls().length - before).toBe(6);
    } finally { await scratch.disconnect(); rmSync(root, { recursive: true, force: true }); }
  });
  test('partially answered private benchmark fails honestly when its allowance is exhausted', async () => {
    const { root, dataset, output } = benchmark(), before = f.calls().length;
    try {
      await f.run(async id => {
        await expect(runEvalLongMemEval([dataset, '--keyword-only', '--no-trajectory', '--no-embed-cache', '--by-type', '--output', output],
          { exitOnError: false })).rejects.toThrow('exit 1');
        const [run] = await f.engine().executeRaw<{ attempts: number }>('SELECT attempts FROM codex_subscription_runs WHERE run_id=$1', [id]);
        expect(Number(run!.attempts)).toBe(1);
      }, {}, 1);
      const rows = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows[0].hypothesis).toBe('Aster moved to the coast.'); expect(rows[1].error).toContain('subscription_exhausted');
      expect(rows[1].hypothesis).toBe(''); expect(f.calls().length - before).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('explicit and database eval pins reject forbidden models before dispatch', async () => {
    const before = f.calls().length;
    await f.run(async () => {
      await expect(resolveEvalModels({ judgeModel: 'openai:fixture', judgeConcurrency: 1 }, {})).rejects.toMatchObject({ code: 'private_route_conflict' });
      await f.engine().setConfig('models.eval.longmemeval_judge', 'anthropic:fixture');
      try { await expect(resolveEvalModels({ judgeModel: '', judgeConcurrency: 1 }, {})).rejects.toMatchObject({ code: 'private_route_conflict', source: 'db:models.eval.longmemeval_judge' }); }
      finally { await f.engine().setConfig('models.eval.longmemeval_judge', ''); }
    }); expect(f.calls().length).toBe(before);
  });
  test.each(['reader', 'extractor', 'judge'] as const)('direct %s entry cannot bypass its database pin', async role => {
    const key = role === 'reader' ? 'models.eval.longmemeval' : role === 'extractor' ? 'models.tier.utility' : 'models.eval.longmemeval_judge';
    const before = f.calls().length;
    await f.engine().setConfig(key, 'anthropic:fixture');
    try {
      await f.run(async () => {
        const call = role === 'reader' ? read : role === 'extractor' ? () => extract() : () => judgeRow({
          question_id: 'direct-pin', question_type: 'multi-session', question: 'Where?', answer: 'Coast', hypothesis: 'Coast',
        }, { client: chat, model, ledger: new BudgetLedger(1, null), configHashFor: () => 'fixture' });
        await expect(call()).rejects.toMatchObject({ code: 'private_route_conflict', source: `db:${key}` });
      });
    } finally { await f.engine().setConfig(key, ''); }
    expect(f.calls().length).toBe(before);
  });
}); }
