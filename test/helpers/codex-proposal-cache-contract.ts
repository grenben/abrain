import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { CodexSubscriptionContext } from '../../src/core/ai/subscription-context.ts';
import { withCodexSubscription } from '../../src/core/ai/subscription-context.ts';
import { withCodexProposalCache, cachedCodexProposal } from '../../src/core/ai/codex-proposal-cache.ts';
import { codexSynopsis } from '../../src/core/ai/codex-synopsis.ts';
import { digest } from '../../src/core/persistence/digest.ts';
import { v328 } from '../../src/core/schema-migrations/v328-codex-proposal-cache.ts';
import { CodexValidationError, type CodexValidationCode } from '../../src/core/ai/providers/codex-contract.ts';
interface Fixture {
  engine(): BrainEngine;
  run<T>(fn: (id: string) => Promise<T>, hooks?: Partial<CodexSubscriptionContext>, maxAttempts?: number): Promise<T>;
  reply(value: unknown): void; calls(): any[];
}
export function codexProposalCacheContract(f: Fixture) { describe('durable native proposal cache', () => {
  const chunk = 'Nebula launched in June.';
  const valid = { synopsis: chunk, source_quote: chunk };
  const scope = () => ({ namespace: `fixture-${randomUUID()}`, bindingHash: digest({ corpus: 'synthetic-v1', incarnation: 'fixture' }) });
  const synopsis = (text = chunk) => codexSynopsis({ model: 'codex-cli:gpt-test', system: 'Summarize the supplied chunk.',
    messages: [{ role: 'user', content: text }], maxTokens: 512 }, text);
  const rows = (namespace: string) => f.engine().executeRaw<{ response_text: string; request_hash: string; run_id: string }>(
    'SELECT response_text,request_hash,run_id FROM codex_proposal_cache WHERE namespace=$1', [namespace]);
  test('real native synopsis is cached only after acceptance; replays do not charge tokens or attempts', async () => {
    const s = scope(), before = f.calls().length; f.reply(valid);
    await withCodexProposalCache(s, () => f.run(async id => {
      expect(await synopsis()).toMatchObject({ kind: 'success', synopsis: chunk, cacheHit: false, usage: { input_tokens: 21, output_tokens: 9 } });
      expect(await synopsis()).toEqual({ kind: 'success', synopsis: chunk, cacheHit: true, usage: undefined });
      const [run] = await f.engine().executeRaw<{ attempts: number; accepted_turns: number }>('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [id]);
      expect(Number(run!.attempts)).toBe(1); expect(Number(run!.accepted_turns)).toBe(1);
      expect((await rows(s.namespace))[0]!.run_id).toBe(id);
    }, {}, 1));
    expect(f.calls().length - before).toBe(1);
    const wire = f.calls().at(-1)!; expect(wire.args).toContain('--output-schema'); expect(wire.mode).toBe(0o600);
    expect(wire.schema.required).toContain('source_quote'); expect(wire.prompt).toContain(chunk);
    // A fresh authorized run can reuse the same evidence, preserving original provenance.
    await withCodexProposalCache(s, () => f.run(async () => { expect((await synopsis()).cacheHit).toBe(true); }));
    expect(f.calls().length - before).toBe(1);
  });
  test('without a cache scope every call retains normal admission', async () => {
    f.reply(valid); const before = f.calls().length;
    await f.run(async () => { await synopsis(); await synopsis(); }); expect(f.calls().length - before).toBe(2);
  });
  test.each(['typed', 'unknown-code', 'plain-error'])('validation diagnostics cannot relay provider content (%s)', async kind => {
    const s = scope(), secret = 'synthetic-private-output-marker'; f.reply(valid);
    await withCodexProposalCache(s, () => f.run(async id => {
      await synopsis();
      const wire = f.calls().at(-1)!, prompt = JSON.parse(wire.prompt);
      const error = kind === 'plain-error' ? new Error(secret) : new CodexValidationError(
        kind === 'typed' ? 'extractor_source_quote' : secret as CodexValidationCode);
      error.message = secret; Object.assign(error, { cause: secret, rejectedText: secret });
      let rejected: unknown;
      try {
        await cachedCodexProposal({ ...prompt, model: 'codex-cli:gpt-test', maxTokens: 512,
          responseSchema: { name: 'diagnostic-privacy', schema: wire.schema, validateCodexProposal: () => { throw error; } } });
      } catch (failure) { rejected = failure; }
      expect(rejected).toMatchObject({ reason: 'invalid_output', message: 'codex-cli proposal failed: invalid_output' });
      expect((rejected as CodexValidationError).validationCode).toBe(kind === 'typed' ? 'extractor_source_quote' : undefined);
      expect(JSON.stringify(rejected)).not.toContain(secret);
      expect((rejected as Error).stack).not.toContain(secret);
      expect(await rows(s.namespace)).toHaveLength(1); // only the accepted synopsis
      const [ledger] = await f.engine().executeRaw<{ attempts: number; accepted_turns: number }>(
        'SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [id]);
      expect(Number(ledger!.attempts)).toBe(2); expect(Number(ledger!.accepted_turns)).toBe(1);
    }));
  });
  test.each([{ raw: 'malformed' }, { refusal: true }, { missingCompletion: true }, { ...valid, source_quote: 'invented' },
    { ...valid, evidence_hash: 'forged' }, { ...valid, synopsis: '' }])('failed proposals never create cache entries', async value => {
    const s = scope(); f.reply(value);
    await withCodexProposalCache(s, () => f.run(async () => { await expect(synopsis()).rejects.toThrow(); }));
    expect(await rows(s.namespace)).toHaveLength(0);
  });
  test('changed prompt, binding, namespace or semantic version cannot reuse a prior result', async () => {
    const s = scope(); f.reply(valid); const before = f.calls().length;
    await f.run(async () => {
      await withCodexProposalCache(s, () => synopsis());
      await withCodexProposalCache(s, () => synopsis(`${chunk} Additional evidence.`));
      await withCodexProposalCache({ ...s, bindingHash: digest('replacement incarnation') }, () => synopsis());
      await withCodexProposalCache({ ...s, namespace: `${s.namespace}-new` }, () => synopsis());
    }); expect(f.calls().length - before).toBe(4);
    const original = f.calls().at(-1)!;
    const prompt = JSON.parse(original.prompt);
    await withCodexProposalCache({ ...s, namespace: `${s.namespace}-new` }, () => f.run(async () => {
      await cachedCodexProposal({ model: 'codex-cli:gpt-test', ...prompt, maxTokens: 512,
        responseSchema: { name: 'changed-semantic-version', schema: original.schema, validateCodexProposal: () => {} } });
    })); expect(f.calls().length - before).toBe(5);
  });
  test.each(['hash', 'schema', 'semantic'])('every cache read rejects corrupt or invalid retained output (%s)', async kind => {
    const s = scope(); f.reply(valid);
    await withCodexProposalCache(s, () => f.run(async () => { await synopsis(); }));
    const [row] = await rows(s.namespace), body = JSON.parse(row!.response_text);
    if (kind === 'schema') body.operation_id = 'forged';
    else body.source_quote = 'absent from source';
    const text = JSON.stringify(body), hash = kind === 'hash' ? '0'.repeat(64) : digest({ requestHash: row!.request_hash, text });
    await f.engine().executeRaw('UPDATE codex_proposal_cache SET response_text=$2,response_hash=$3 WHERE namespace=$1', [s.namespace, text, hash]);
    const before = f.calls().length;
    await withCodexProposalCache(s, () => f.run(async () => { await expect(synopsis()).rejects.toMatchObject({ reason: 'invalid_output' }); }));
    expect(f.calls().length).toBe(before);
  });
  test('cache hits require current host authority, a real grant, and an unexpired run', async () => {
    const s = scope(); f.reply(valid);
    await withCodexProposalCache(s, () => f.run(async () => { await synopsis(); })); const before = f.calls().length;
    await withCodexProposalCache(s, async () => {
      await expect(synopsis()).rejects.toMatchObject({ code: 'subscription_required' });
      await withCodexSubscription({ engine: f.engine(), runId: 'missing-cache-run' }, async () => {
        await expect(synopsis()).rejects.toMatchObject({ code: 'subscription_required' });
      });
      await f.run(async id => {
        await f.engine().executeRaw("UPDATE codex_subscription_runs SET deadline=now()-interval '1 second' WHERE run_id=$1", [id]);
        await expect(synopsis()).rejects.toMatchObject({ code: 'subscription_exhausted' });
      });
      await f.run(async () => { await expect(synopsis()).rejects.toThrow('fixture ownership lost'); },
        { checkAuthority: async () => { throw new Error('fixture ownership lost'); } });
      await f.run(async () => { await expect(synopsis()).rejects.toThrow('fixture fence lost'); },
        { checkAuthorityInTransaction: async () => { throw new Error('fixture fence lost'); } });
      await f.run(async () => { await expect(synopsis()).rejects.toMatchObject({ reason: 'aborted' }); }, { signal: AbortSignal.abort() });
    }); expect(f.calls().length).toBe(before);
  });
  test('ownership loss after native acceptance prevents cache publication without refunding the call', async () => {
    const s = scope(); f.reply(valid); let fences = 0;
    await withCodexProposalCache(s, () => f.run(async id => {
      await expect(synopsis()).rejects.toThrow('fixture post-call fence lost');
      const [run] = await f.engine().executeRaw<{ attempts: number; accepted_turns: number }>('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [id]);
      expect(Number(run!.attempts)).toBe(1); expect(Number(run!.accepted_turns)).toBe(1);
    }, { checkAuthorityInTransaction: async () => { if (++fences === 2) throw new Error('fixture post-call fence lost'); } }));
    expect(await rows(s.namespace)).toHaveLength(0);
  });
  test('cache lookup cannot bypass forbidden routes or unsupported schemas', async () => {
    const s = scope(); f.reply(valid);
    await withCodexProposalCache(s, () => f.run(async () => { await synopsis(); }));
    const wire = f.calls().at(-1)!, before = f.calls().length, prompt = JSON.parse(wire.prompt);
    await withCodexProposalCache(s, () => f.run(async () => {
      const base = { ...prompt, model: 'codex-cli:gpt-test', maxTokens: 512,
        responseSchema: { name: 'codex-grounded-synopsis-v2', schema: wire.schema, validateCodexProposal: () => {} } };
      await expect(cachedCodexProposal({ ...base, model: 'anthropic:fixture' })).rejects.toMatchObject({ code: 'private_route_conflict' });
      await expect(cachedCodexProposal({ ...base, responseSchema: { ...base.responseSchema, schema: { ...wire.schema, not: {} } } }))
        .rejects.toMatchObject({ reason: 'unsupported_schema' });
      await expect(cachedCodexProposal({ ...base, responseSchema: { ...base.responseSchema, validateCodexProposal: undefined } }))
        .rejects.toMatchObject({ reason: 'invalid_input' });
      await expect(cachedCodexProposal({ ...base, timeoutMs: 0 })).rejects.toMatchObject({ reason: 'invalid_input' });
    })); expect(f.calls().length).toBe(before);
  });
  test('migration replay preserves cached raw output and enforces bounded storage', async () => {
    const s = scope(); f.reply(valid);
    await withCodexProposalCache(s, () => f.run(async () => { await synopsis(); })); const before = await rows(s.namespace);
    for (let i = 0; i < 2; i++) for (const sql of v328.sql!.split(';').filter(s => s.trim())) await f.engine().executeRaw(sql);
    expect(await rows(s.namespace)).toEqual(before);
    await expect(f.engine().executeRaw('UPDATE codex_proposal_cache SET response_text=$2 WHERE namespace=$1', [s.namespace, 'a'.repeat(262145)])).rejects.toThrow();
    const [table] = await f.engine().executeRaw<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE relname='codex_proposal_cache'");
    expect(table!.relrowsecurity).toBe(true);
  });
}); }
