import { AsyncLocalStorage } from 'node:async_hooks';
import { chat, type ChatOpts, type ChatResult } from './gateway.ts';
import { assertPrivateRoute, readPrivateCodexConfig, requirePrivateRole, privateModelForRole, privatePolicyFingerprint, PrivateRoutingError } from './private-policy.ts';
import { codexSubscriptionContext } from './subscription-context.ts';
import { SubscriptionAdmissionError } from './subscription-admission.ts';
import { prepareCodexSchema } from './providers/codex-schema.ts';
import { CodexProposalError, CodexValidationError } from './providers/codex-contract.ts';
import { digest } from '../persistence/digest.ts';
import type { BrainEngine } from '../engine.ts';

export interface CodexProposalCacheScope {
  namespace: string;
  /** Host-computed identity of the authorized corpus/source incarnation and protocol. */
  bindingHash: string;
}
export interface CachedCodexProposal {
  text: string;
  /** A cache hit has no new provider usage. Never copy the original call's tokens. */
  usage?: ChatResult['usage'];
  cacheHit: boolean;
  billing: { kind: 'subscription'; costUsd: null; remainingQuota: null };
}
const scopes = new AsyncLocalStorage<Readonly<CodexProposalCacheScope>>();
export function withCodexProposalCache<T>(scope: CodexProposalCacheScope, run: () => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(scope.namespace) || !/^[a-f0-9]{64}$/.test(scope.bindingHash))
    throw new CodexProposalError('invalid_input');
  return scopes.run(Object.freeze({ ...scope }), run);
}

/** Native proposals retain full schema and semantic checks, including on every cache read. */
export async function cachedCodexProposal(original: ChatOpts): Promise<CachedCodexProposal> {
  const policy = readPrivateCodexConfig();
  if (!policy) throw new SubscriptionAdmissionError('subscription_required');
  const role = requirePrivateRole(policy, original.privateRole), model = privateModelForRole(policy, role);
  const policyFingerprint = privatePolicyFingerprint(policy);
  assertPrivateRoute(original.model ?? model, 'proposal_cache:model', policy, role);
  const spec = original.responseSchema;
  if (!spec?.validateCodexProposal || !/^[A-Za-z0-9._:-]{1,120}$/.test(spec.name) || original.tools?.length ||
      original.providerOptions || original.messages.some(m => typeof m.content !== 'string')) throw new CodexProposalError('invalid_input');
  const prepared = prepareCodexSchema(spec.schema);
  const validateSemantic = spec.validateCodexProposal;
  // Snapshot all wire inputs before an asynchronous lookup. Host semantics remain mandatory.
  const opts: ChatOpts = { ...original, privateRole: role, model, allowFallback: false,
    messages: JSON.parse(JSON.stringify(original.messages)), responseSchema: { ...spec, schema: prepared.schema } };
  if (Buffer.byteLength(JSON.stringify([opts.system, opts.messages])) > 180000 ||
      opts.maxTokens !== undefined && (!Number.isSafeInteger(opts.maxTokens) || opts.maxTokens < 16 || opts.maxTokens > 8192) ||
      opts.timeoutMs !== undefined && (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs < 1 || opts.timeoutMs > 600000))
    throw new CodexProposalError('invalid_input');
  const validate = (text: string): void => {
    try {
      if (Buffer.byteLength(text) > 262144 || !prepared.validate(JSON.parse(text))) throw new Error();
      validateSemantic(text);
    } catch (error) {
      // Reconstruct only an allowlisted host code; do not relay messages, causes,
      // stacks or arbitrary properties that might contain rejected source text.
      if (error instanceof CodexValidationError && error.validationCode)
        throw new CodexValidationError(error.validationCode);
      throw new CodexProposalError('invalid_output');
    }
  };
  opts.responseSchema!.validateCodexProposal = validate;
  const context = codexSubscriptionContext();
  if (!context) throw new SubscriptionAdmissionError('subscription_required');
  const assertPolicy = () => {
    if (context.signal?.aborted || opts.abortSignal?.aborted) throw new CodexProposalError('aborted');
    const current = readPrivateCodexConfig();
    if (!current || privatePolicyFingerprint(current) !== policyFingerprint) throw new PrivateRoutingError('proposal_cache:policy_changed');
    assertPrivateRoute(opts.model!, 'proposal_cache:model', current, role);
  };
  const assertAuthority = async () => {
    assertPolicy();
    await context.checkAuthority?.();
    assertPolicy();
  };
  const fence = async (tx: BrainEngine) => {
    await context.checkAuthorityInTransaction?.(tx);
    const [run] = await tx.executeRaw<{ current: boolean }>(
      'SELECT deadline > now() AS current FROM codex_subscription_runs WHERE run_id=$1 FOR SHARE', [context.runId]);
    if (!run) throw new SubscriptionAdmissionError('subscription_required');
    if (!run.current) throw new SubscriptionAdmissionError('subscription_exhausted');
    assertPolicy();
  };
  await assertAuthority();
  const scope = scopes.getStore();
  const billing = { kind: 'subscription' as const, costUsd: null, remainingQuota: null };
  if (!scope) {
    const result = await chat(opts);
    validate(result.text);
    await assertAuthority();
    return { text: result.text, usage: result.usage, cacheHit: false, billing };
  }
  const requestHash = digest({ protocol: 'codex-proposal-cache-v2', role, policyFingerprint, model: opts.model, system: opts.system,
    messages: opts.messages, schema: prepared.schema, version: opts.responseSchema!.name, maxTokens: opts.maxTokens,
    temperature: opts.temperature, thinking: opts.thinking });
  const keys = [scope.namespace, scope.bindingHash, requestHash];
  const read = async (tx: BrainEngine) => {
    const [row] = await tx.executeRaw<{ response_text: string; response_hash: string }>(
      'SELECT response_text,response_hash FROM codex_proposal_cache WHERE namespace=$1 AND binding_hash=$2 AND request_hash=$3', keys);
    if (!row) return undefined;
    if (row.response_hash !== digest({ requestHash, text: row.response_text })) throw new CodexProposalError('invalid_output');
    validate(row.response_text);
    return row.response_text;
  };
  const cached = await context.engine.transaction(async tx => { await fence(tx); return read(tx); });
  await assertAuthority();
  if (cached !== undefined) return { text: cached, cacheHit: true, billing };
  const result = await chat(opts);
  validate(result.text);
  await assertAuthority();
  const text = await context.engine.transaction(async tx => {
    await fence(tx);
    await tx.executeRaw(`INSERT INTO codex_proposal_cache(namespace,binding_hash,request_hash,run_id,response_text,response_hash)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(namespace,binding_hash,request_hash) DO NOTHING`,
    [...keys, context.runId, result.text, digest({ requestHash, text: result.text })]);
    // A concurrent writer's already accepted proposal is canonical; never overwrite it.
    return (await read(tx))!;
  });
  await assertAuthority();
  return { text, usage: result.usage, cacheHit: false, billing };
}
