import type { RunLlmCallOpts } from './llm-base.ts';
import { chat } from '../ai/gateway.ts';
import { assertPrivateRoute, readPrivateCodexConfig, privatePolicyFingerprint } from '../ai/private-policy.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { CodexProposalError, isRecord } from '../ai/providers/codex-contract.ts';
import { prepareCodexSchema } from '../ai/providers/codex-schema.ts';
import { resolveModel } from '../model-config.ts';
import { digest } from '../persistence/digest.ts';

/** Native proposals only. Cache raw validated responses per brain, never across processes/brains. */
export async function runPrivateParserCall<T>(opts: RunLlmCallOpts<T>): Promise<T> {
  const policy = readPrivateCodexConfig()!;
  const role = opts.shape === 'polish' ? 'parser-polish' : 'parser-fallback';
  assertPrivateRoute(opts.modelStr, 'conversation-parser:model', policy, role);
  await resolveModel(opts.engine ?? codexSubscriptionContext()?.engine ?? null, { privateRole: role, cliFlag: opts.modelStr, tier: 'utility', fallback: 'unused' });
  const policyIdentity = privatePolicyFingerprint(policy);
  if (opts.chatTransport || !opts.cacheVersion || !opts.responseSchema ||
    Buffer.byteLength(opts.content + opts.system) > 131072) throw new CodexProposalError('invalid_input');
  const contract = prepareCodexSchema(opts.responseSchema);
  const context = codexSubscriptionContext();
  const signal = opts.signal && context?.signal ? AbortSignal.any([opts.signal, context.signal]) : opts.signal ?? context?.signal;
  const assertPolicy = () => {
    if (signal?.aborted) throw new CodexProposalError('aborted');
    const current = readPrivateCodexConfig();
    if (!current || privatePolicyFingerprint(current) !== policyIdentity) throw new CodexProposalError('invalid_input');
    assertPrivateRoute(opts.modelStr, 'conversation-parser:model', current, role);
  };
  const assertCurrent = async () => {
    assertPolicy();
    await context?.checkAuthority?.();
    assertPolicy();
  };
  await assertCurrent();
  const engine = opts.engine ?? context?.engine;
  const key = digest({ protocol: 'private-parser-cache-v2', role, policyIdentity, version: opts.cacheVersion,
    system: opts.system, schema: contract.schema, content: opts.content, maxTokens: opts.maxTokens ?? 4000 });
  const parse = (raw: string): T => {
    try {
      if (Buffer.byteLength(raw) > 524288 || !contract.validate(JSON.parse(raw))) throw new Error();
      const value = opts.parse(raw);
      if (value === null) throw new Error();
      return value;
    } catch { throw new CodexProposalError('invalid_output'); }
  };
  // Cache IO errors propagate: a damaged or unavailable required cache must not
  // silently spend another allowance. Old parsed-value caches have different keys.
  if (engine) {
    const [row] = await engine.executeRaw<{ value_json: unknown }>(
      'SELECT value_json FROM conversation_parser_llm_cache WHERE content_sha256=$1 AND model_id=$2 AND call_shape=$3',
      [key, opts.modelStr, opts.shape]);
    if (row) {
      const value = row.value_json;
      if (!isRecord(value) || value.protocol !== 'private-parser-cache-v2' || typeof value.raw !== 'string') throw new CodexProposalError('invalid_output');
      const parsed = parse(value.raw);
      await assertCurrent();
      return parsed;
    }
  }
  const result = await chat({ privateRole: role, model: opts.modelStr, allowFallback: false, timeoutMs: 120000,
    system: opts.system, messages: [{ role: 'user', content: opts.content }], maxTokens: opts.maxTokens ?? 4000,
    abortSignal: signal, responseSchema: { name: opts.cacheVersion, schema: contract.schema, validateCodexProposal: raw => { parse(raw); } } });
  if (result.stopReason !== 'end') throw new CodexProposalError('invalid_output');
  const parsed = parse(result.text);
  await assertCurrent();
  if (engine) await engine.executeRaw(
    `INSERT INTO conversation_parser_llm_cache(content_sha256,model_id,call_shape,value_json)
     VALUES($1,$2,$3,$4::text::jsonb) ON CONFLICT(content_sha256,model_id,call_shape) DO NOTHING`,
    [key, opts.modelStr, opts.shape, JSON.stringify({ protocol: 'private-parser-cache-v2', raw: result.text })]);
  await assertCurrent();
  return parsed;
}
