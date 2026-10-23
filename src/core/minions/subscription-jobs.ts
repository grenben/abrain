import type { BrainEngine } from '../engine.ts';
import { createSubscriptionRun, SubscriptionAdmissionError, type SubscriptionEnvelope } from '../ai/subscription-admission.ts';
import { withCodexSubscription, hasAdmittedCodexAttempt, codexSubscriptionContext } from '../ai/subscription-context.ts';
import { withAIInvocationGuard } from '../ai/invocation-guard.ts';
import { privatePolicyBinding, readPrivateCodexConfig, assertPrivateRoute, resolvePrivateModel, PrivateRoutingError } from '../ai/private-policy.ts';
import { authorityDigest, authorizeJobExecution } from './submission-authority.ts';
import { rowToMinionJob, type MinionJob, type MinionJobContext } from './types.ts';
import { jobMayGenerate } from './subscription-job-kinds.ts';
import { validateCodexReadJob, CODEX_SKILLOPT_JOB_PROTOCOL } from './codex-action-contract.ts';
import { validateCodexBootstrapJob } from '../skillopt/codex-bootstrap-job-contract.ts';
export { CODEX_GENERATIVE_JOBS, jobMayGenerate } from './subscription-job-kinds.ts';

/** Only a trusted host argument can grant this allowance. No USD conversion or quota estimate. */
export type JobSubscriptionAuthorization = Pick<SubscriptionEnvelope, 'maxAttempts' | 'maxTurns' | 'deadline' | 'parentRunId'>;
export const CODEX_JOB_ACCOUNT_LANE = 'codex-subscription';

/** Refuse explicit job pins before insertion or handler construction. No discovery. */
export async function preflightSubscriptionJob(engine: BrainEngine, name: string, data: Record<string, unknown>) {
  const policy = readPrivateCodexConfig();
  if (!policy) return;
  for (const key of ['model', 'model_id', 'modelId'] as const) {
    if (data[key] !== undefined) {
      if (typeof data[key] !== 'string' || !data[key].trim()) throw new PrivateRoutingError(`job:${key}`);
      assertPrivateRoute(data[key], `job:${key}`, policy);
    }
  }
  await resolvePrivateModel(engine, { fallback: 'unused' }, policy);
  if (name === 'contextual_reindex_per_chunk') {
    const source = data.expected_source_id;
    if (typeof source !== 'string' || !source || [data.source_id, data.sourceId].some(value => value !== undefined && value !== source)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    await resolvePrivateModel(engine, { configKey: 'models.contextual_synopsis', deprecatedConfigKey: 'contextual_retrieval.haiku_model', envVar: 'GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL', tier: 'utility', fallback: 'unused' }, policy);
  }
  if (name === 'subagent') {
    validateCodexReadJob(data);
    await resolvePrivateModel(engine, { tier: 'subagent', configKey: 'models.subagent', fallback: 'unused' }, policy);
  }
  if (name === 'skillopt') {
    if (data.bootstrap_protocol !== undefined) {
      validateCodexBootstrapJob(data);
      const options = data.bootstrap_options as { optimizer: { model: string } };
      await resolvePrivateModel(engine, { cliFlag: options.optimizer.model, tier: 'deep', fallback: 'unused' }, policy);
    } else {
      const { validateCodexOptimizerJob } = await import('../skillopt/codex-job-contract.ts');
      validateCodexOptimizerJob(data);
      await resolvePrivateModel(engine, { tier: 'deep', fallback: 'unused' }, policy);
      await resolvePrivateModel(engine, { tier: 'subagent', configKey: 'models.subagent', fallback: 'unused' }, policy);
      await resolvePrivateModel(engine, { tier: 'reasoning', fallback: 'unused' }, policy);
    }
  }
}

/** Do not enqueue unfenced private work that an older worker could claim. */
export async function preflightSubscriptionSubmit(engine: BrainEngine, name: string, data: Record<string, unknown>, grant?: JobSubscriptionAuthorization) {
  await preflightSubscriptionJob(engine, name, data);
  if (readPrivateCodexConfig() && !grant) throw new SubscriptionAdmissionError('subscription_required');
}

/** Versioned identity includes the durable payload, authority, route and source incarnation. */
async function runIdentity(engine: BrainEngine, job: MinionJob): Promise<string> {
  const policy = readPrivateCodexConfig();
  if (!policy) throw new SubscriptionAdmissionError('subscription_required');
  const data = job.data ?? {};
  const contextual = job.name === 'contextual_reindex_per_chunk';
  const sourceId = contextual ? data.expected_source_id : data.source_id ?? data.sourceId;
  let sourceCreatedAt: string | null = null;
  let sourceIncarnation: string | null = null;
  if (sourceId !== undefined) {
    if (typeof sourceId !== 'string' || !sourceId ||
      (data.source_id !== undefined && data.sourceId !== undefined && data.source_id !== data.sourceId)) {
      throw new SubscriptionAdmissionError('subscription_identity_conflict');
    }
    const [source] = await engine.executeRaw<{ created_at: Date | string; archived: boolean; incarnation: string }>(
      'SELECT created_at, archived, incarnation FROM sources WHERE id=$1', [sourceId]);
    if (!source || source.archived) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    sourceCreatedAt = new Date(source.created_at).toISOString();
    sourceIncarnation = source.incarnation;
  }
  return `codex-job:${job.id}:${contextual ? 'v2' : 'v1'}:${authorityDigest({ name: job.name, data, authority: job.submission_authority,
    ...privatePolicyBinding(policy), sourceCreatedAt, sourceIncarnation })}`;
}

/** Must run inside the queue insertion transaction, including every coalescing path. */
export async function bindJobSubscription(engine: BrainEngine, job: MinionJob, grant?: JobSubscriptionAuthorization): Promise<void> {
  if (!grant) return;
  if (!readPrivateCodexConfig() || job.submission_authority?.kind !== 'application') {
    throw new SubscriptionAdmissionError('subscription_required');
  }
  if (Object.keys(grant).some(k => !['maxAttempts', 'maxTurns', 'deadline', 'parentRunId'].includes(k))) {
    throw new SubscriptionAdmissionError('subscription_invalid');
  }
  const runId = await runIdentity(engine, job);
  const rows = await engine.executeRaw<{ run_id: string }>('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1', [`codex-job:${job.id}:%`]);
  // Legacy rows need an explicit new submission, never adoption during coalescing.
  if (!rows.length && job.coalesced) throw new SubscriptionAdmissionError('subscription_required');
  if (rows.some(row => row.run_id !== runId)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  await createSubscriptionRun(engine, { ...grant, runId, accountLane: CODEX_JOB_ACCOUNT_LANE });
}

/** Shared by inline and isolated worker children through runWithJobSpend. */
export async function runWithJobSubscription<T>(engine: BrainEngine, job: MinionJob, ctx: MinionJobContext, run: () => Promise<T>): Promise<T> {
  const rows = await engine.executeRaw<{ run_id: string }>('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1', [`codex-job:${job.id}:%`]);
  // A changed payload cannot evade a pre-existing binding by looking deterministic.
  if (!jobMayGenerate(job.name, job.data ?? {}) && rows.length === 0) return run();
  const policy = readPrivateCodexConfig();
  if (!policy && rows.length === 0) return run();
  await preflightSubscriptionJob(engine, job.name, job.data ?? {});
  if (!policy || rows.length !== 1) throw new SubscriptionAdmissionError('subscription_required');
  // Optimizer child jobs are driven only by their enclosing host, never an ordinary queue worker.
  const [rollout] = await engine.executeRaw<{ run_id: string }>('SELECT run_id FROM codex_skillopt_rollouts WHERE job_id=$1', [job.id]);
  if (!!rollout !== (job.data?.optimizer_protocol === CODEX_SKILLOPT_JOB_PROTOCOL)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const parent = rollout ? codexSubscriptionContext() : undefined;
  if (rollout && (!parent || parent.engine !== engine || parent.runId !== rollout.run_id)) throw new SubscriptionAdmissionError('subscription_required');
  const runId = await runIdentity(engine, job);
  if (rows[0]!.run_id !== runId) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const checkAuthority = async (tx = engine, lock = false) => {
    parent?.signal?.throwIfAborted();
    if (lock) await parent?.checkAuthorityInTransaction?.(tx); else await parent?.checkAuthority?.();
    if (ctx.signal?.aborted || ctx.shutdownSignal?.aborted) throw new SubscriptionAdmissionError('subscription_owner_lost');
    const [row] = await tx.executeRaw<Record<string, unknown>>(
      `SELECT * FROM minion_jobs WHERE id=$1 AND lock_token=$2 AND status='active' AND lock_until>now()${lock ? ' FOR UPDATE' : ''}`, [job.id, job.lock_token]);
    if (!row) throw new SubscriptionAdmissionError('subscription_owner_lost');
    const current = rowToMinionJob(row);
    if (await runIdentity(tx, current) !== runId) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    await authorizeJobExecution(tx, current);
    await preflightSubscriptionJob(tx, current.name, current.data ?? {});
  };
  await checkAuthority();
  const signals = [ctx.signal, ctx.shutdownSignal].filter((s): s is AbortSignal => s !== undefined);
  return withCodexSubscription({ engine, runId, publicationFence: { jobId: job.id, lockToken: job.lock_token!, jobDigest: authorityDigest({ data: job.data, authority: job.submission_authority }) }, checkAuthority, checkAuthorityInTransaction: tx => checkAuthority(tx, true), signal: signals.length ? AbortSignal.any(signals) : undefined }, async () => {
    const result = await withAIInvocationGuard(async call => {
      if (!hasAdmittedCodexAttempt(call.model) && !job.spend_authorization) {
        throw new SubscriptionAdmissionError('subscription_auxiliary_budget_required');
      }
      return { settle: async () => {} };
    }, run, { inherit: true });
    await checkAuthority();
    return result;
  });
}
