import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../../core/engine.ts';
import { bindPrivateRoleScope } from '../../core/ai/private-role-scope.ts';
import { readPrivateCodexConfig } from '../../core/ai/private-policy.ts';
import { codexSubscriptionContext, withCodexSubscription, type CodexSubscriptionContext } from '../../core/ai/subscription-context.ts';
import { hasAIInvocationGuard, withAIInvocationPreflight } from '../../core/ai/invocation-guard.ts';
import { SubscriptionAdmissionError } from '../../core/ai/subscription-admission.ts';
import { withCodexProposalCache } from '../../core/ai/codex-proposal-cache.ts';
import { digest, sha256 } from '../../core/persistence/digest.ts';
import { fenceEvalRun, readEvalResult, retainEvalResult, releaseEvalRun, type EvalClaim, type EvalOutcome } from './codex-run-store.ts';
import { claimAuthorizedEvalRun } from './codex-local-grant.ts';
import { subscriptionAuxiliaryBudgets } from '../../core/ai/subscription-auxiliary.ts';

interface RunState { host: CodexSubscriptionContext; claim?: EvalClaim; questions?: Map<string, unknown>; replayText?: string }
const runs = new AsyncLocalStorage<RunState>();
const required = () => new SubscriptionAdmissionError('subscription_required');
export function needsPrivateEvalLifecycle(): boolean {
  return !!readPrivateCodexConfig() && !!codexSubscriptionContext() && !runs.getStore();
}
export function privateEvalReplayText(): string | undefined { return runs.getStore()?.replayText; }

/** The original host authority stays outside the derived run fence; no recursive hooks. */
export async function withPrivateEvalLifecycle<T>(run: () => Promise<T>): Promise<T> {
  const parent = codexSubscriptionContext();
  if (!readPrivateCodexConfig() || !parent) return run();
  const host = bindPrivateRoleScope(parent, []); // Selected roles are resolved before the run is bound.
  if (runs.getStore()) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const state: RunState = { host }, auxiliaryAuthorized = hasAIInvocationGuard();
  const transactionFence = async (tx: BrainEngine) => {
    if (!state.claim) throw required();
    await fenceEvalRun(tx, host, state.claim);
  };
  const checkAuthority = async () => {
    await host.checkAuthority?.();
    await host.engine.transaction(transactionFence);
  };
  return runs.run(state, async () => {
    try {
      const result = await withCodexSubscription({ ...host, checkAuthority, checkAuthorityInTransaction: transactionFence }, () =>
        withAIInvocationPreflight(async call => {
          await checkAuthority();
          if (['embedding','rerank'].includes(call.kind) && !auxiliaryAuthorized) throw new SubscriptionAdmissionError('subscription_auxiliary_budget_required');
          const [grant] = await host.engine.executeRaw<{ current: boolean }>('SELECT deadline>now() AS current FROM codex_subscription_runs WHERE run_id=$1', [host.runId]);
          if (!grant?.current) throw new SubscriptionAdmissionError('subscription_exhausted');
        }, run));
      if (state.claim) await releaseEvalRun(host, state.claim, true);
      return result;
    } catch (error) {
      if (state.claim) await releaseEvalRun(host, state.claim, false);
      throw error;
    }
  });
}

/** Capture all material options before reading a resume file or allocating a scratch brain. */
export async function bindPrivateEval(input: {
  datasetSha256: string; questions: ReadonlyArray<{ question_id: string }>; options: Record<string, unknown>;
  retrievalHash: string; readerHash: string; judgeHash: string; extractorModel: string; requiresResources: boolean;
}): Promise<void> {
  if (!readPrivateCodexConfig()) return;
  const state = runs.getStore();
  if (!state) { if (input.requiresResources) throw required(); return; }
  if (state.claim || new Set(input.questions.map(q => q.question_id)).size !== input.questions.length) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const { outputPath: _out, resumeFromPath: _resume, datasetPath: _dataset, questionIdsPath: _ids, ...options } = input.options;
  // Bind replay bytes, not their mutable pathname. Nothing from the file authorizes execution.
  if (typeof options.expansionReplayPath === 'string') {
    const bytes = readFileSync(options.expansionReplayPath);
    if (bytes.length > 4194304) throw new Error('private_eval_replay_too_large');
    state.replayText = bytes.toString('utf8');
    options.expansionReplayPath = sha256(bytes);
  }
  const auxiliary = [];
  for (const budget of subscriptionAuxiliaryBudgets()) {
    const [brain] = await budget.engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    if (!brain) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    auxiliary.push({ brainId:brain.brain_id, key:budget.budgetKey, capUsd:budget.capUsd });
  }
  const bindingHash = digest({ protocol: 'codex-longmemeval-run-v2', ...input, options, auxiliary,
    questions: input.questions.map(q => ({ id:q.question_id, hash:digest(q) })), policy: readPrivateCodexConfig() });
  state.questions = new Map(input.questions.map(q => [q.question_id, JSON.parse(JSON.stringify(q))]));
  state.claim = await claimAuthorizedEvalRun(state.host, bindingHash, input.questions.length, options.judge === true ? 'judged' : 'answer');
}

async function fenced<T>(state: RunState, run: (tx: BrainEngine, claim: EvalClaim) => Promise<T>): Promise<T> {
  await state.host.checkAuthority?.();
  return state.host.engine.transaction(async tx => {
    if (!state.claim) throw required();
    await fenceEvalRun(tx, state.host, state.claim);
    return run(tx, state.claim);
  });
}

/** Accepted reader work survives judge failure and file-output failure. */
export async function privateEvalAnswer<T extends EvalOutcome>(question: { question_id: string }, run: () => Promise<T>): Promise<T> {
  const state = runs.getStore();
  if (!state?.claim) return run();
  if (digest(state.questions?.get(question.question_id)) !== digest(question)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const prior = await fenced(state, async (tx, claim) => await readEvalResult<T>(tx, claim, question, claim.stage) ?? await readEvalResult<T>(tx, claim, question, 'answer'));
  if (prior) return prior;
  return withCodexProposalCache({ namespace:'longmemeval-run', bindingHash: digest([state.host.runId,state.claim.bindingHash]) }, async () => {
    const outcome = await run();
    return fenced(state, (tx, claim) => retainEvalResult(tx, claim, question, 'answer', outcome));
  });
}

export async function settlePrivateEvalQuestion(question: { question_id: string }, outcome: EvalOutcome): Promise<void> {
  const state = runs.getStore();
  if (!state?.claim) return;
  await fenced(state, (tx, claim) => retainEvalResult(tx, claim, question, claim.stage, outcome));
}

/** Use only canonical host receipts; an edited or legacy JSONL row is never a receipt. */
export async function privateEvalResume(rows: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const state = runs.getStore();
  if (!state?.claim) return rows;
  return fenced(state, async (tx, claim) => {
    const accepted: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      if (row.kind === 'by_type_summary' || typeof row.error === 'string') continue;
      const question = state.questions?.get(row.question_id as string);
      if (!question) throw new SubscriptionAdmissionError('subscription_identity_conflict');
      const complete = await readEvalResult(tx, claim, question, claim.stage);
      const outcome = complete ?? await readEvalResult(tx, claim, question, 'answer');
      if (!outcome || digest(row) !== digest(outcome.row)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
      if (complete) accepted.push(outcome.row);
    }
    return accepted;
  });
}
