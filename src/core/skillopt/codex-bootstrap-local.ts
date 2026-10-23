import { resolve } from 'node:path';
import type { GuardedBootstrapOpts } from './bootstrap-run.ts';
import type { EvalAllowance } from '../../eval/longmemeval/codex-allowance-flags.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { privatePolicyBinding, privatePolicyMatchesBinding, readPrivateCodexConfig } from '../ai/private-policy.ts';
import { digest } from '../persistence/digest.ts';
import { assertLegacySkillWriter } from '../skillpack/writer-guard.ts';
import { BOOTSTRAP_PENDING_REVIEW } from './types.ts';
import { localOptimizerAllowance, reportOptimizerAllowance } from './codex-local-grant.ts';
import { prepareCodexBootstrap } from './codex-bootstrap.ts';
import { proposeCodexBenchmark } from './codex-bootstrap-proposal.ts';
import { assertBootstrapFilesCurrent, readBootstrapFile, writeBootstrapDraft } from './codex-bootstrap-files.ts';
import { bootstrapConflict, readBootstrapRun, claimBootstrapRun, fenceBootstrapRun, saveBootstrapAccepted, completeBootstrapRun, releaseBootstrapRun } from './codex-bootstrap-store.ts';
type BootstrapAllowance = Omit<EvalAllowance, 'auxiliaryUsd'> & { auxiliaryUsd: number | null };

/** One explicit local allowance owns the original inputs, accepted draft and reconciliation. */
export async function runLocalCodexBootstrap(original: GuardedBootstrapOpts, modelPlan: unknown, workerAllowance?: BootstrapAllowance, expectedInputHash?: string) {
  const host = codexSubscriptionContext(), pendingAllowance = localOptimizerAllowance(),
    allowance = workerAllowance ?? (pendingAllowance ? { ...pendingAllowance, auxiliaryUsd: pendingAllowance.auxiliaryUsd } : undefined), policy = readPrivateCodexConfig();
  if (!host || !allowance || !policy || host.engine !== original.engine || original.operationContext?.engine !== original.engine ||
      original.operationContext.remote !== false || !original.operationContext.sourceId || original.chatFn)
    throw new SubscriptionAdmissionError('subscription_required');
  const { engine, operationContext, abortSignal, chatFn, ...values } = original, opts = structuredClone(values);
  const sourceId = operationContext.sourceId, prior = await readBootstrapRun(engine, host.runId);
  const prepared = await prepareCodexBootstrap({ skillsDir: resolve(opts.skillsDir), skillName: opts.skillName, optimizerModel: opts.optimizer.model,
    force: opts.force, taskCount: opts.taskCount, abortSignal }, opts.mode, prior ? { files: prior.input.files, output: prior.result?.output } : undefined);
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) bootstrapConflict();
  const input = { controls: { ...opts, skillsDir: resolve(opts.skillsDir), modelPlan, allowance }, files: prepared.files,
    sourceId, incarnation: source!.incarnation, ...privatePolicyBinding(policy) };
  if (expectedInputHash !== undefined && digest(input) !== expectedInputHash) bootstrapConflict();
  if (prior && digest(input) !== prior.input_hash) bootstrapConflict();
  if (opts.dryRun) return;
  const signal = abortSignal ? AbortSignal.any([...(host.signal ? [host.signal] : []), abortSignal]) : host.signal;
  const { claim, row } = await claimBootstrapRun({ ...host, signal }, input);
  const fence = async (tx: typeof engine, requireTime = true) => {
    await fenceBootstrapRun(tx, { ...host, signal }, claim, requireTime);
    const current = readPrivateCodexConfig();
    const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [sourceId]);
    if (!source || source.archived || source.incarnation !== input.incarnation || !current || !privatePolicyMatchesBinding(current, input)) bootstrapConflict();
  };
  try {
    reportOptimizerAllowance();
    const scope = { ...host, signal, checkAuthority: async () => { await host.checkAuthority?.(); await engine.transaction(tx => fence(tx)); },
      checkAuthorityInTransaction: (tx: typeof engine) => fence(tx) };
    return await withCodexSubscription(scope, async () => {
      let accepted = row.result;
      if (!accepted) {
        const { tasks, proposal } = await proposeCodexBenchmark(prepared.proposalInput);
        accepted = { output: [...tasks.map(t => JSON.stringify(t)), BOOTSTRAP_PENDING_REVIEW, ''].join('\n'),
          result: { outputPath: prepared.files.outputPath, rowsGenerated: tasks.length, rowsSkipped: 0, cacheHit: proposal.cacheHit, usage: proposal.usage, billing: proposal.billing } };
        await engine.transaction(async tx => { await fence(tx); await saveBootstrapAccepted(tx, claim, accepted!); });
      }
      await engine.transaction(async tx => {
        await fence(tx, false);
        await tx.executeRaw("SELECT pg_advisory_xact_lock(hashtext('codex-skillopt-publication:' || $1))", [prepared.files.outputPath]);
        await assertLegacySkillWriter(tx, prepared.files.outputPath); signal?.throwIfAborted();
        const current = readBootstrapFile(prepared.files.outputPath, true);
        assertBootstrapFilesCurrent({ ...prepared.files, priorOutput: current });
        if (current !== accepted!.output) {
          if (row.completed) bootstrapConflict();
          await fence(tx); writeBootstrapDraft(prepared.files, accepted!.output);
        }
        await completeBootstrapRun(tx, claim);
      });
      process.stderr.write('[skillopt] Draft benchmark retained. Review and strengthen its checks before --bootstrap-reviewed.\n');
      return { ...accepted.result, codex_request_id: allowance.requestId, replayed: row.result !== null };
    });
  } finally { await releaseBootstrapRun(host, claim); }
}
