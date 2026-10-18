import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchAllOpts, BatchAllResult } from './batch.ts';
import { collectSkillsWithBenchmarks } from './batch.ts';
import type { SkillOptOpts } from './types.ts';
import { runSkillOpt } from './orchestrator.ts';
import { prepareCodexSkillOpt } from './codex-run.ts';
import { localOptimizerAllowance, withoutLocalOptimizerAllowance } from './codex-local-grant.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../ai/subscription-context.ts';
import { subscriptionAuxiliaryBudgets, withSubscriptionAuxiliaryBudget } from '../ai/subscription-auxiliary.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { digest } from '../persistence/digest.ts';
import { claimOptimizerBatch, fenceOptimizerBatch, completeOptimizerBatch, releaseOptimizerBatch, type BatchInput } from './codex-batch-store.ts';
import { withOptimizerBatchMember } from './codex-batch-context.ts';
const invalid = (): never => { throw new CodexProposalError('invalid_input'); };
const changedExpectedInputs = (): never => { throw new SubscriptionAdmissionError('subscription_identity_conflict'); };

/** Prevalidate the entire batch, retain its manifest, then run one fenced optimizer at a time. */
export async function runCodexSkillOptBatch(original: BatchAllOpts): Promise<BatchAllResult> {
  const host = codexSubscriptionContext();
  if (!host || host.engine !== original.engine) throw new SubscriptionAdmissionError('subscription_required');
  if (original.operationContext?.engine !== original.engine || original.operationContext.remote !== false || !original.operationContext.sourceId || !original.codex) invalid();
  const { engine, operationContext, filter, ...values } = original;
  const opts = { ...structuredClone(values), engine, operationContext: { ...operationContext! } };
  opts.skillsDir = realpathSync(opts.skillsDir);
  if (!statSync(opts.skillsDir).isDirectory()) invalid();
  const names = collectSkillsWithBenchmarks(opts.skillsDir).filter(s => !filter || filter(s));
  if (opts.codexExpectedSkills && digest(names) !== digest(opts.codexExpectedSkills)) invalid();
  if (names.length > 20) invalid();
  const local = localOptimizerAllowance();
  const [saved] = await engine.executeRaw<{ max_attempts: number; max_turns: number; deadline: Date | string }>('SELECT max_attempts,max_turns,deadline FROM codex_subscription_runs WHERE run_id=$1', [host.runId]);
  const grant = local ? { maxAttempts: local.maxAttempts, maxTurns: local.maxTurns, deadline: local.deadline, auxiliaryUsd: local.auxiliaryUsd } : saved ?
    { maxAttempts: saved.max_attempts, maxTurns: saved.max_turns, deadline: new Date(saved.deadline).toISOString(), auxiliaryUsd: null } : undefined;
  if (!grant) throw new SubscriptionAdmissionError('subscription_required');
  const perSkill = opts.codexPerSkill ?? { maxAttempts: grant.maxAttempts, maxTurns: grant.maxTurns };
  if (![perSkill.maxAttempts, perSkill.maxTurns].every(n => Number.isSafeInteger(n) && n >= 1) || perSkill.maxTurns > perSkill.maxAttempts ||
      perSkill.maxAttempts > grant.maxAttempts || perSkill.maxTurns > grant.maxTurns) invalid();
  const budgets = subscriptionAuxiliaryBudgets();
  if (budgets.some(b => b.engine !== engine)) invalid();
  const input: BatchInput = { protocol: 'codex-skillopt-batch-v1', entries: [], grant, perSkill,
    auxiliary: budgets.map(b => ({ budgetKey: b.budgetKey, capUsd: b.capUsd })),
    scope: { sourceId: opts.operationContext.sourceId, codex: opts.codex, skillsDir: opts.skillsDir } };
  const prepared: Array<{ runId: string; opts: SkillOptOpts; inputHash: string }> = [];
  for (const skillName of names) {
    const runId = `codex-batch-member:${digest({ runId: host.runId, skillName })}`;
    const child: SkillOptOpts = { engine, operationContext: opts.operationContext, codex: opts.codex, skillName,
      skillsDir: opts.skillsDir, benchmarkPath: join(opts.skillsDir, skillName, 'skillopt-benchmark.jsonl'),
      epochs: opts.epochs, batchSize: opts.batchSize, lr: opts.lr, lrSchedule: opts.lrSchedule, split: opts.split,
      optimizerModel: opts.optimizerModel, targetModel: opts.targetModel, judgeModel: opts.judgeModel,
      models: opts.models, modelsStrict: opts.modelsStrict, modelsBannerBaseline: opts.modelsBannerBaseline, reflectMaxTokens: opts.reflectMaxTokens,
      mode: opts.mode ?? 'patch', heldOutPath: opts.heldOutPath, dryRun: opts.dryRun, noMutate: opts.noMutate, allowMutateBundled: opts.allowMutateBundled,
      bootstrapReviewed: opts.bootstrapReviewed ?? false, json: true, maxCostUsd: opts.perSkillMaxCostUsd, maxCostSource: opts.maxCostSource,
      maxRuntimeMin: opts.maxRuntimeMin ?? 30, force: opts.force };
    const plan = await withoutLocalOptimizerAllowance(() => withCodexSubscription({ ...host, runId }, () => prepareCodexSkillOpt(child)));
    const inputHash = digest(plan.input);
    input.entries.push({ skill: skillName, runId, inputHash, input: plan.input }); prepared.push({ runId, opts: child, inputHash });
  }
  if (opts.codexExpectedEntries && digest(prepared.map(p => ({ skill: p.opts.skillName, inputHash: p.inputHash }))) !== digest(opts.codexExpectedEntries)) changedExpectedInputs();
  const empty = (): BatchAllResult => ({ skills_scanned: names.length, skills_run: 0, accepted: 0, no_improvement: 0, errored: 0,
    brain_wide_cap_reached: false, cumulative_cost_usd: null, per_skill: [], billing: 'subscription', remaining_quota: null });
  if (opts.dryRun) return { ...empty(), dry_run: true };
  const { claim, row } = await claimOptimizerBatch(host, input);
  try {
    if (row.state === 'complete') return row.result!;
    const out = empty();
    const scope = { ...host,
      checkAuthority: async () => { await host.checkAuthority?.(); await engine.transaction(tx => fenceOptimizerBatch(tx, host, claim)); },
      checkAuthorityInTransaction: (tx: typeof engine) => fenceOptimizerBatch(tx, host, claim) };
    const execute = async () => {
      for (const child of prepared) {
        await scope.checkAuthority();
        const result = await withOptimizerBatchMember(claim, child.runId, child.inputHash, () => withoutLocalOptimizerAllowance(() =>
          withCodexSubscription({ ...scope, runId: child.runId }, () => runSkillOpt({ ...child.opts, codexExpectedInputHash: child.inputHash }))));
        if (!['accepted', 'no_improvement'].includes(result.outcome)) invalid();
        out.skills_run++;
        if (result.outcome === 'accepted') out.accepted++; else out.no_improvement++;
        out.per_skill.push({ skill: child.opts.skillName, outcome: result.outcome as 'accepted' | 'no_improvement', cost_usd: null, receipt: result.receipt });
      }
      const [usage] = await engine.executeRaw<Record<string, number | string>>(`WITH RECURSIVE tree AS (
        SELECT run_id FROM codex_subscription_runs WHERE run_id=$1 UNION ALL SELECT r.run_id FROM codex_subscription_runs r JOIN tree ON r.parent_run_id=tree.run_id)
        SELECT count(*)::int AS attempts,count(*) FILTER (WHERE a.accepted)::int AS accepted_turns,
          COALESCE(sum(input_tokens),0)::text AS measured_input_tokens,COALESCE(sum(output_tokens),0)::text AS measured_output_tokens,
          COALESCE(sum(cached_input_tokens),0)::text AS measured_cached_input_tokens,count(*) FILTER (WHERE input_tokens IS NULL)::int AS unmeasured_attempts
        FROM codex_subscription_attempts a JOIN tree USING(run_id)`, [host.runId]);
      out.subscription = Object.fromEntries(Object.entries(usage!).map(([k, v]) => [k, Number(v)]));
      await completeOptimizerBatch(host, claim, out);
      return out;
    };
    return await (budgets.length ? execute() : withSubscriptionAuxiliaryBudget(engine, `group:${host.runId}`, undefined, execute));
  } finally { await releaseOptimizerBatch(host, claim); }
}
