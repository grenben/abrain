import type { SkilloptPhaseOpts, SkilloptPhaseResult } from './cycle-phase.ts';
import { collectSkillsWithBenchmarks, runBatchAll } from './batch.ts';
import { resolveSkillOptModels, skillOptModelOpts } from './models-plan.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { OperationError } from '../ops/contract.ts';
import { loadConfig, loadConfigWithEngine } from '../config.ts';
import { digest } from '../persistence/digest.ts';
import { readCodexCycleConfig } from './codex-cycle-config.ts';
import { withOptimizerCycle } from './codex-cycle-context.ts';
import { acceptOptimizerCycle, fenceOptimizerCycle, finishOptimizerCycle, failUnstartedOptimizerCycle, type OptimizerCycle } from './codex-cycle-store.ts';

/** The scheduled host supplies the existing subscription grant; USD caps cannot create one. */
export async function runCodexCycleSkillopt(opts: SkilloptPhaseOpts): Promise<SkilloptPhaseResult> {
  const start = Date.now(), host = codexSubscriptionContext();
  const report = (status: SkilloptPhaseResult['status'], summary: string, details: Record<string, unknown> = {}): SkilloptPhaseResult =>
    ({ phase: 'skillopt', status, summary, duration_ms: Date.now() - start, details: { billing: 'subscription', cost_usd: null, remaining_quota: null, ...details } });
  let row: OptimizerCycle | undefined;
  const signal = AbortSignal.any([...(host?.signal ? [host.signal] : []), ...(opts.signal ? [opts.signal] : []),
    ...(opts.deadlineAtMs == null ? [] : [AbortSignal.timeout(Math.max(0, Math.min(2147483647, opts.deadlineAtMs - Date.now())))])]);
  const scope = host ? { ...host, signal } : undefined;
  try {
    const config = await readCodexCycleConfig(opts.engine, opts.sourceId);
    const models = await resolveSkillOptModels(opts.engine);
    const names = collectSkillsWithBenchmarks(config.skillsDir).sort();
    if (opts.dryRun) return report('skipped', 'Dry run: directory and read scope checked; no allowance, benchmark execution or publication.', { candidates: names.length, max_skills_per_cycle: config.maxSkillsPerCycle });
    if (!scope || scope.engine !== opts.engine) throw new SubscriptionAdmissionError('subscription_required');
    const [source] = await opts.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived', [config.sourceId]);
    if (!source) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    const binding = { config, models }, inputHash = digest(binding);
    return await withOptimizerCycle(scope.runId, inputHash, async () => {
      row = await acceptOptimizerCycle(scope, { run_id: scope.runId, protocol: 1, source_id: config.sourceId, source_incarnation: source.incarnation,
        binding, input_hash: inputHash, selection: [], selection_hash: digest([]), state: 'pending', result_hash: null }, names);
      const selected = row;
      const authority = { ...scope, checkAuthority: async () => { await scope.checkAuthority?.(); await opts.engine.transaction(tx => fenceOptimizerCycle(tx, scope, selected)); },
        checkAuthorityInTransaction: (tx: typeof opts.engine) => fenceOptimizerCycle(tx, scope, selected) };
      const local = await loadConfigWithEngine(opts.engine, loadConfig() ?? { engine: opts.engine.kind });
      const result = await withCodexSubscription(authority, () => runBatchAll({ engine: opts.engine, skillsDir: config.skillsDir,
        operationContext: { engine: opts.engine, sourceId: config.sourceId, remote: false, config: local!, dryRun: false,
          logger: { info: () => {}, warn: () => {}, error: () => {} } },
        codex: config.codex, codexPerSkill: config.perSkill, codexExpectedSkills: selected.selection, filter: name => selected.selection.includes(name),
        ...skillOptModelOpts(models), epochs: 1, batchSize: 4, lr: 4, lrSchedule: 'cosine', split: [4, 1, 5],
        mode: 'patch', optimizerMode: 'reflect', dryRun: false, noMutate: true, allowMutateBundled: false, bootstrapReviewed: false, force: false,
        perSkillMaxCostUsd: 0.5, brainWideMaxCostUsd: 2, maxCostSource: 'default', maxRuntimeMin: 10 }));
      await finishOptimizerCycle(scope, selected);
      return report('ok', `${result.skills_run} skills completed; proposals require review.`, { ...result, cycle_run_id: scope.runId });
    });
  } catch (error) {
    // A cancellation or lost fence cannot erase pending effects or create a success stamp.
    if (row && scope && !signal.aborted) await failUnstartedOptimizerCycle(scope, row).catch(() => {});
    const reason = signal.aborted ? 'cancelled' : error instanceof SubscriptionAdmissionError ? error.code :
      error instanceof OperationError ? error.code : error instanceof CodexProposalError ? error.reason : 'generation_failed';
    return report('fail', `Scheduled skill optimization stopped (${reason}); no completion stamp.`, { reason, ...(scope ? { cycle_run_id: scope.runId } : {}) });
  }
}
