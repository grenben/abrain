import { declareDurablePersistence } from '../core/persistence/protocol.ts';
import { digest } from '../core/persistence/digest.ts';
import { randomUUID } from 'node:crypto';
import type { OperationContext } from '../core/ops/contract.ts';
import { privatePolicyBinding, readPrivateCodexConfig } from '../core/ai/private-policy.ts';
import { createSubscriptionRun, SubscriptionAdmissionError } from '../core/ai/subscription-admission.ts';
import { codexSubscriptionContext, withCodexSubscription, hasAdmittedCodexAttempt } from '../core/ai/subscription-context.ts';
import { withAIInvocationGuard } from '../core/ai/invocation-guard.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../core/minions/subscription-jobs.ts';
import { runPhaseCalibrationProfile } from '../core/cycle/calibration-profile.ts';
import { isWriteRequestId } from '../core/persistence/types.ts';
import { resolveModel } from '../core/model-config.ts';
import { usageError } from '../cli/cli-error.ts';
import { prepareCodexJobSubmit, codexSubmitSummary } from './jobs/subscription.ts';

/** Local command consent uses the same explicit allowance parser and shared account lane as jobs. */
export async function regenerateCalibration(ctx: OperationContext, args: string[], holder: string) {
  const policy = readPrivateCodexConfig();
  if (!policy) {
    if (args.some(arg => arg.startsWith('--codex-'))) throw usageError('Codex allowances require strict private configuration.', 'Configure private Codex explicitly before authorizing subscription generation.');
    return runPhaseCalibrationProfile(ctx, { holder });
  }
  if (codexSubscriptionContext()) {
    if (args.some(arg => arg.startsWith('--codex-'))) throw usageError('An enclosing host already owns this subscription allowance.', 'Reuse the host allowance without nested Codex flags.');
    return runPhaseCalibrationProfile(ctx, { holder });
  }
  if (ctx.remote !== false) throw new SubscriptionAdmissionError('subscription_required');
  await resolveModel(ctx.engine, { configKey: 'models.chat', tier: 'reasoning', fallback: 'sonnet' });
  await resolveModel(ctx.engine, { tier: 'utility', fallback: 'haiku' });
  const { codexSubscription } = await prepareCodexJobSubmit(ctx.engine, 'autopilot-cycle', { phases: ['calibration_profile'], source_id: ctx.sourceId }, args);
  if (!codexSubscription) throw new SubscriptionAdmissionError('subscription_required');
  const flags = args.flatMap((arg,index) => arg === '--codex-request-id' ? [index] : []);
  if (flags.length > 1 || args.some(arg => arg.startsWith('--codex-request-id='))) throw usageError('Use one --codex-request-id UUID.', 'Reuse the same request ID and allowance to reconcile a prior run.');
  const requestId = flags.length ? args[flags[0]!+1] : randomUUID();
  if (!isWriteRequestId(requestId)) throw usageError('--codex-request-id must be a UUID.', 'Supply a UUID or omit it to generate a new request.');
  const runId = await ctx.engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    // Take the exclusive lock first; upgrading two shared locks would deadlock.
    // Serialize UUID binding across processes, including requests with different inputs.
    await tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    await declareDurablePersistence(tx);
    const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived FOR SHARE', [ctx.sourceId ?? 'default']);
    if (!source) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    const prefix = `codex-calibration:${requestId.toLowerCase()}:`;
    const id = `${prefix}${digest({ holder, sourceId: ctx.sourceId ?? 'default', sourceIncarnation: source.incarnation, ...privatePolicyBinding(policy) })}`;
    const prior = await tx.executeRaw<{ run_id: string }>('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1', [`${prefix}%`]);
    if (prior.some(row => row.run_id !== id)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    await createSubscriptionRun(tx, { ...codexSubscription, runId: id, accountLane: CODEX_JOB_ACCOUNT_LANE });
    return id;
  });
  process.stderr.write(`[calibration] subscription request ${requestId.toLowerCase()} ${codexSubmitSummary(codexSubscription)}\n`);
  return withCodexSubscription({ engine: ctx.engine, runId }, () => withAIInvocationGuard(async call => {
    if (!hasAdmittedCodexAttempt(call.model)) throw new SubscriptionAdmissionError('subscription_auxiliary_budget_required');
    return { settle: async () => {} };
  }, () => runPhaseCalibrationProfile(ctx, { holder }), { inherit: true }));
}
