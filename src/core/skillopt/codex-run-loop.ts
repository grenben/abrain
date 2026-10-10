import type { SkillOptOpts, Benchmark, BenchmarkTask, BenchmarkSplit, RunReceipt, EditOp } from './types.ts';
import type { RunSkillOptResult } from './orchestrator.ts';
import type { OptimizerCheckpoint, OptimizerClaim } from './codex-run-store.ts';
import { saveOptimizerCheckpoint } from './codex-run-store.ts';
import type { CodexSubscriptionContext } from '../ai/subscription-context.ts';
import { runValidationGate } from './validate-gate.ts';
import { runReflect, runOneShotRewrite, describeJudges } from './reflect.ts';
import { splitFrontmatter, applyEdit } from './apply-edits.ts';
import { resolveLrSchedule } from './lr-schedule.ts';
import { isRejected, makeRejectedEntry } from './rejected-buffer.ts';
import { ROLLOUT_SUCCESS_THRESHOLD } from './types.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { lintCandidate } from './candidate.ts';

export interface OptimizerLoopInput { opts: SkillOptOpts; baseline: string; benchmark: Benchmark; split: BenchmarkSplit; heldOut: BenchmarkTask[]; reflectCap: number }
/** Reuse the existing algorithm's split, LR, body-only edits, median/epsilon and held-out rules. */
export async function runOptimizerLoop(input: OptimizerLoopInput, host: CodexSubscriptionContext, claim: OptimizerClaim, checkpoint: OptimizerCheckpoint, receipt: RunReceipt): Promise<RunSkillOptResult> {
  const { opts, baseline, split, heldOut } = input, state = structuredClone(checkpoint);
  const stepsPerEpoch = Math.ceil(split.train.length / opts.batchSize), totalSteps = stepsPerEpoch * opts.epochs;
  const score = (id: string, candidate: string, tasks: BenchmarkTask[], bestScore: number, runsPerTask = 3) => runValidationGate({
    engine: opts.engine, operationContext: opts.operationContext, candidateSkillText: candidate, selSet: tasks, bestScore,
    targetModel: opts.targetModel, judgeModel: opts.judgeModel, runsPerTask, deadlineMs: claim.deadline, abortSignal: host.signal,
    codex: { evaluationId: id, allowedTools: opts.codex!.allowedTools, allowedSlugPrefixes: opts.codex!.allowedSlugPrefixes } });
  if (state.baselineScore === null) {
    state.baselineScore = state.bestScore = (await score('baseline', baseline, split.sel, -1)).selScore;
    await saveOptimizerCheckpoint(host, claim, state);
  }
  const lr = resolveLrSchedule(opts.lrSchedule);
  for (let index = state.nextStep; index < totalSteps; index++) {
    host.signal?.throwIfAborted();
    const step = index % stepsPerEpoch, batch = split.train.slice(step * opts.batchSize, (step + 1) * opts.batchSize);
    const forward = await score(`train:${index}`, state.bestText, batch, -1, 1);
    const reflectOpts = { skillBodyText: splitFrontmatter(state.bestText).body,
      successes: forward.scoredRollouts.filter(r => r.score >= ROLLOUT_SUCCESS_THRESHOLD),
      failures: forward.scoredRollouts.filter(r => r.score < ROLLOUT_SUCCESS_THRESHOLD), rejected: state.rejected,
      criteria: describeJudges(input.benchmark.tasks), optimizerModel: opts.optimizerModel, maxTokens: input.reflectCap,
      abortSignal: host.signal };
    let candidate = state.bestText, edits: EditOp[] = [];
    if (opts.mode === 'rewrite') {
      const parts = splitFrontmatter(state.bestText), result = await runOneShotRewrite({ ...reflectOpts, skillBodyText: parts.body });
      if (result.error || !result.newBody) throw new CodexProposalError('invalid_output');
      candidate = state.bestText.slice(0, parts.bodyStart) + result.newBody;
    } else {
      const result = await runReflect(reflectOpts);
      if (result.errors.length) throw new CodexProposalError('invalid_output');
      // Validate the full native batch before applying a bounded LR prefix. Never salvage invalid edits.
      const proposed = [...result.failureEdits, ...result.successEdits];
      let validated = state.bestText;
      for (const edit of proposed) {
        const applied = applyEdit(validated, edit);
        if (applied.outcome !== 'applied') throw new CodexProposalError('invalid_output');
        validated = applied.newText;
      }
      edits = proposed.filter(e => !isRejected(state.rejected, state.bestText, [e])).slice(0, lr(opts.lr, index + 1, totalSteps));
      for (const edit of edits) {
        const applied = applyEdit(candidate, edit);
        if (applied.outcome !== 'applied') throw new CodexProposalError('invalid_output');
        candidate = applied.newText;
      }
    }
    let accepted = false, reason = 'no_edits_proposed', candidateScore: number | undefined;
    if (candidate !== state.bestText) {
      lintCandidate(state.bestText, candidate);
      const gate = await score(`candidate:${index}`, candidate, split.sel, state.bestScore!);
      accepted = gate.accepted; candidateScore = gate.selScore; reason = gate.reason ?? 'accepted';
      if (accepted && heldOut.length) {
        const before = await score('heldout:baseline', baseline, heldOut, -1);
        const after = await score(`heldout:candidate:${index}`, candidate, heldOut, -1);
        if (after.selScore < before.selScore) { accepted = false; reason = 'held_out_regression'; }
      }
      if (accepted) { state.bestText = candidate; state.bestScore = gate.selScore; state.acceptedSteps++; }
      else state.rejected = [...state.rejected, ...edits.map(e => makeRejectedEntry(state.bestText, [e], reason))].slice(-100);
    }
    state.decisions.push({ step: index, accepted, reason, ...(candidateScore !== undefined ? { score: candidateScore } : {}) });
    state.nextStep = index + 1;
    await saveOptimizerCheckpoint(host, claim, state);
  }
  const baselineTest = split.test.length ? (await score('test:baseline', baseline, split.test, -1)).selScore : undefined;
  const finalTest = split.test.length ? (await score('test:best', state.bestText, split.test, -1)).selScore : undefined;
  const outcome = state.acceptedSteps ? 'accepted' : 'no_improvement';
  return { outcome, finalText: state.bestText, mutatedSkillFile: false, receipt: { ...receipt, outcome, stop_reason: 'completed',
    baseline_sel_score: state.baselineScore!, best_sel_score: state.bestScore!, total_steps: state.nextStep,
    epochs_completed: opts.epochs, baseline_test_score: baselineTest, test_score: finalTest, ended_at: new Date().toISOString(), final_cost_usd: null } };
}
