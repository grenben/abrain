import { assertNativeOptimizerControls, preflightNativeOptimizer } from './codex-preflight.ts';
import type { SkillOptOpts, RunReceipt } from './types.ts';
import type { RunSkillOptResult } from './orchestrator.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { readPrivateCodexConfig } from '../ai/private-policy.ts';
import { assertLegacySkillWriter } from '../skillpack/writer-guard.ts';
import { digest } from '../persistence/digest.ts';
import { CODEX_READ_PROTOCOL, validateCodexReadJob } from '../minions/codex-action-contract.ts';
import { readOptimizerRun, claimOptimizerRun, fenceOptimizerRun, saveOptimizerResult, completeOptimizerRun, releaseOptimizerRun } from './codex-run-store.ts';
import { snapshotOptimizerFiles, publishOptimizerFile, type OptimizerFiles } from './codex-run-files.ts';
import { runOptimizerLoop } from './codex-run-loop.ts';
import { localOptimizerAllowance, reportOptimizerAllowance } from './codex-local-grant.ts';

/** Private optimizer: one durable root, native child evaluations, validated proposals and retained effects. */
export async function prepareCodexSkillOpt(original: SkillOptOpts) {
  const host = codexSubscriptionContext(), policy = readPrivateCodexConfig();
  if (!host || host.engine !== original.engine || !policy) throw new SubscriptionAdmissionError('subscription_required');
  assertNativeOptimizerControls(original);
  // Trusted objects stay host-owned; all caller-controlled material is snapshotted before awaits.
  const { engine, operationContext, ...values } = original;
  const opts: SkillOptOpts = { ...structuredClone(values), engine, operationContext: { ...operationContext! } };
  const sourceId = opts.operationContext!.sourceId!;
  validateCodexReadJob({ action_protocol: CODEX_READ_PROTOCOL, prompt: 'scope preflight', source_id: sourceId, no_self_fix: true,
    allowed_tools: opts.codex!.allowedTools, allowed_slug_prefixes: opts.codex!.allowedSlugPrefixes,
    ...(opts.codex!.readRegistry !== undefined ? { read_registry: opts.codex!.readRegistry } : {}), max_turns: 16 });
  const prior = await readOptimizerRun(engine, host.runId);
  const files = snapshotOptimizerFiles(opts, prior ? { files: prior.input.files as unknown as OptimizerFiles,
    finalText: prior.result?.outcome === 'accepted' ? prior.result.finalText : undefined, complete: prior.state === 'complete' } : undefined);
  await assertLegacySkillWriter(engine, files.outputPath);
  const { benchmark, heldOut, split, cap, modelsPlan, strict } = await preflightNativeOptimizer(opts, files, policy);
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const input = { protocol: 'codex-skillopt-run-v1', files, sourceId, sourceIncarnation: source.incarnation,
    skillName: opts.skillName, epochs: opts.epochs, batchSize: opts.batchSize, lr: opts.lr, lrSchedule: opts.lrSchedule,
    split: opts.split, mode: opts.mode, codex: opts.codex, optimizerModel: opts.optimizerModel, targetModel: opts.targetModel,
    judgeModel: opts.judgeModel, model: policy!.model, bin: policy!.bin, reflectCap: cap.maxTokens, maxRuntimeMin: opts.maxRuntimeMin,
    bootstrapReviewed: opts.bootstrapReviewed, modelsStrict: strict, modelsPlan,
    ...(localOptimizerAllowance() ? { localAllowance: localOptimizerAllowance() } : {}) };
  if (opts.codexExpectedInputHash !== undefined && digest(input) !== opts.codexExpectedInputHash)
    throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const receipt: RunReceipt = { run_id: host.runId, skill: opts.skillName, skill_sha8: digest(files.skillText).slice(0, 8),
    benchmark_sha8: benchmark.benchmark_sha8, optimizer_model: opts.optimizerModel, target_model: opts.targetModel, judge_model: opts.judgeModel,
    epochs: opts.epochs, batch_size: opts.batchSize, lr: opts.lr, lr_schedule: opts.lrSchedule, max_cost_usd: opts.maxCostUsd,
    started_at: prior ? new Date(prior.created_at).toISOString() : new Date().toISOString(), reflect_max_tokens: cap.maxTokens,
    reflect_max_tokens_source: cap.source, final_cost_usd: null, models_plan: modelsPlan, models_strict: strict };
  return { host, policy, opts, sourceId, source, input, receipt, prior, files, benchmark, heldOut, split, cap };
}

export async function runCodexSkillOpt(original: SkillOptOpts): Promise<RunSkillOptResult> {
  const { host, policy, opts, sourceId, source, input, receipt, files, benchmark, heldOut, split, cap } = await prepareCodexSkillOpt(original);
  const engine = opts.engine;
  if (opts.dryRun) return { outcome: 'aborted', finalText: files.skillText, mutatedSkillFile: false, receipt: { ...receipt, outcome: 'aborted' } };
  const { claim, row } = await claimOptimizerRun(host, input, files.skillText, opts.maxRuntimeMin * 60000);
  try {
    reportOptimizerAllowance();
    if (row.state === 'complete') return row.result!;
    const signal = AbortSignal.any([...(host.signal ? [host.signal] : []), AbortSignal.timeout(Math.max(0, Math.min(2147483647, claim.deadline - Date.now())))]);
    const fence = async (tx: typeof engine) => {
      await fenceOptimizerRun(tx, host, claim);
      const currentPolicy = readPrivateCodexConfig();
      if (!currentPolicy || currentPolicy.model !== policy!.model || currentPolicy.bin !== policy!.bin) throw new SubscriptionAdmissionError('subscription_identity_conflict');
      const [current] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [sourceId]);
      if (!current || current.archived || current.incarnation !== source.incarnation) throw new SubscriptionAdmissionError('subscription_identity_conflict');
      signal.throwIfAborted();
    };
    const scope = { ...host, signal, checkAuthority: async () => { await host.checkAuthority?.(); await engine.transaction(fence); }, checkAuthorityInTransaction: fence };
    return await withCodexSubscription(scope, async () => {
      const result = row.result ?? await runOptimizerLoop({ opts, baseline: files.skillText, benchmark, split, heldOut, reflectCap: cap.maxTokens }, scope, claim, row.checkpoint, receipt);
      if (!row.result) {
        const [allowance] = await engine.executeRaw<{ attempts: number; accepted_turns: number; max_attempts: number; max_turns: number }>('SELECT attempts,accepted_turns,max_attempts,max_turns FROM codex_subscription_runs WHERE run_id=$1', [host.runId]);
        const [usage] = await engine.executeRaw<{ measured_input_tokens: string; measured_cached_input_tokens: string; measured_output_tokens: string; unmeasured_attempts: string }>(`SELECT
          COALESCE(sum(a.input_tokens),0)::text AS measured_input_tokens,COALESCE(sum(a.cached_input_tokens),0)::text AS measured_cached_input_tokens,
          COALESCE(sum(a.output_tokens),0)::text AS measured_output_tokens,count(*) FILTER (WHERE a.input_tokens IS NULL)::text AS unmeasured_attempts
          FROM codex_subscription_attempts a JOIN codex_subscription_runs r USING(run_id) WHERE r.run_id=$1 OR r.parent_run_id=$1`, [host.runId]);
        result.receipt.subscription = { cost_usd: null, remaining_quota: null, ...allowance!,
          measured_input_tokens: Number(usage!.measured_input_tokens), measured_cached_input_tokens: Number(usage!.measured_cached_input_tokens),
          measured_output_tokens: Number(usage!.measured_output_tokens), unmeasured_attempts: Number(usage!.unmeasured_attempts) };
        await saveOptimizerResult(scope, claim, result);
      }
      await engine.transaction(async tx => {
        await fence(tx);
        await tx.executeRaw("SELECT pg_advisory_xact_lock(hashtext('codex-skillopt-publication:' || $1))", [files.outputPath]);
        if (result.outcome === 'accepted') {
          await publishOptimizerFile(tx, files, result.finalText);
          result.mutatedSkillFile = files.mutate;
          if (!files.mutate) result.proposedPath = files.outputPath;
        }
        await completeOptimizerRun(tx, host, claim, result);
      });
      return result;
    });
  } finally { await releaseOptimizerRun(host, claim); }
}
