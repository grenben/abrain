import { prepareCodexInput } from './providers/codex-input.ts';
import { createHash, randomUUID } from 'node:crypto';
import { runCodexProposal, CodexProposalError, type CodexProposalInput, type CodexProposalResult } from './providers/codex-proposal.ts';
import { assertCodexRuntimeQualified } from './providers/codex-qualification.ts';
import { codexSubscriptionContext, withAdmittedCodexAttempt } from './subscription-context.ts';
import { reserveSubscriptionAttempt, settleSubscriptionAttempt, SubscriptionAdmissionError, acceptSubscriptionTurn, type SubscriptionAttempt } from './subscription-admission.ts';
import { invokeAI, isAIInvocationPolicyError } from './invocation-guard.ts';
import { assertSubscriptionAuxiliaryHealthy } from './subscription-auxiliary.ts';
import { readPrivateCodexConfig, requirePrivateRole, assertPrivateRoute, privatePolicyFingerprint, PrivateRoutingError } from './private-policy.ts';
import type { PrivateRole } from './private-roles.ts';

interface PrivateDispatchIdentity { role: PrivateRole; policyFingerprint: string }

/** Production admission seam shared by bounded proposals and the host action loop. */
export async function dispatchCodexProposal(original: CodexProposalInput & { role?: PrivateRole }): Promise<CodexProposalResult & { attempt: SubscriptionAttempt } & PrivateDispatchIdentity> {
  const policy = readPrivateCodexConfig();
  if (!policy) throw new SubscriptionAdmissionError('subscription_required');
  const role = requirePrivateRole(policy, original.role), policyFingerprint = privatePolicyFingerprint(policy);
  assertPrivateRoute(`codex-cli:${original.model}`, 'dispatch:model', policy, role);
  if (original.bin !== policy.bin) throw new PrivateRoutingError('dispatch:bin');
  const checkPolicy = () => {
    const current = readPrivateCodexConfig();
    if (!current || privatePolicyFingerprint(current) !== policyFingerprint) throw new PrivateRoutingError('dispatch:policy_changed');
    assertPrivateRoute(`codex-cli:${original.model}`, 'dispatch:model', current, role);
  };
  const context = codexSubscriptionContext();
  if (!context) throw new SubscriptionAdmissionError('subscription_required');
  const signals = [original.signal, context.signal].filter((s): s is AbortSignal => s !== undefined);
  const { input } = await prepareCodexInput({ ...original, signal: signals.length ? AbortSignal.any(signals) : undefined });
  await context.checkAuthority?.();
  checkPolicy();
  assertSubscriptionAuxiliaryHealthy();
  await assertCodexRuntimeQualified(input.bin);
  const requestHash = createHash('sha256').update(JSON.stringify({protocol:'codex-proposal-v2',role,policyFingerprint,bin:input.bin,model:input.model,prompt:input.prompt,schema:input.schema,timeoutMs:input.timeoutMs,maxOutputBytes:input.maxOutputBytes,
    images:input.images?.map(image=>({mime:image.mime,sha256:createHash('sha256').update(image.bytes).digest('hex')}))})).digest('hex');
  const attempt = await reserveSubscriptionAttempt(context.engine, {runId:context.runId,attemptId:randomUUID(),requestHash,
    repair:context.repair,timeoutMs:input.timeoutMs ?? 120_000});
  let result: CodexProposalResult;
  let enteredRuntime = false;
  try {
    result = await withAdmittedCodexAttempt(attempt, () => invokeAI({operation:'gateway.codex',kind:'chat',model:`codex-cli:${input.model}`},
      async () => { await context.checkAuthority?.(); checkPolicy(); enteredRuntime = true; return runCodexProposal(input); }, r => r.usage ? {inputTokens:r.usage.inputTokens-r.usage.cachedInputTokens,
        outputTokens:r.usage.outputTokens,cacheReadTokens:r.usage.cachedInputTokens} : null));
  } catch (error) {
    // A stopped local process does not prove the remote attempt settled. Never refund.
    const knownNotDispatched = !enteredRuntime || isAIInvocationPolicyError(error) || error instanceof CodexProposalError && ['invalid_input','unsupported_schema','runtime_unqualified','spawn'].includes(error.reason);
    await settleSubscriptionAttempt(context.engine,attempt,{state:knownNotDispatched || error instanceof CodexProposalError && error.terminalCompletion ? 'failed':'unresolved',
      usage:error instanceof CodexProposalError?error.terminalCompletion?.usage:undefined,
      failureCode:error instanceof CodexProposalError?error.reason:'provider_failure'});
    throw error;
  }
  // Persistence failure holds the lane and prevents another call. No successful return before this write.
  await settleSubscriptionAttempt(context.engine,attempt,{state:'succeeded',usage:result.usage});
  return { ...result, attempt, role, policyFingerprint };
}

export async function acceptCodexProposal(result: { attempt: SubscriptionAttempt } & PrivateDispatchIdentity): Promise<void> {
  const policy = readPrivateCodexConfig();
  if (!policy || privatePolicyFingerprint(policy) !== result.policyFingerprint) throw new PrivateRoutingError('dispatch:policy_changed');
  requirePrivateRole(policy, result.role);
  const context = codexSubscriptionContext();
  if (!context || context.runId !== result.attempt.runId) throw new SubscriptionAdmissionError('subscription_required');
  await context.checkAuthority?.();
  assertSubscriptionAuxiliaryHealthy();
  const current = readPrivateCodexConfig();
  if (!current || privatePolicyFingerprint(current) !== result.policyFingerprint) throw new PrivateRoutingError('dispatch:policy_changed');
  await acceptSubscriptionTurn(context.engine,result.attempt);
}
