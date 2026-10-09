import type { BrainEngine } from '../engine.ts';
import { createSubscriptionRun, SubscriptionAdmissionError, type SubscriptionEnvelope } from '../ai/subscription-admission.ts';
import { withCodexSubscription, hasAdmittedCodexAttempt } from '../ai/subscription-context.ts';
import { withAIInvocationGuard } from '../ai/invocation-guard.ts';
import { readPrivateCodexConfig, assertPrivateRoute, resolvePrivateModel, PrivateRoutingError } from '../ai/private-policy.ts';
import { authorityDigest, authorizeJobExecution } from './submission-authority.ts';
import { rowToMinionJob, type MinionJob, type MinionJobContext } from './types.ts';

/** Only a trusted host argument can grant this allowance. No USD conversion or quota estimate. */
export type JobSubscriptionAuthorization = Pick<SubscriptionEnvelope, 'maxAttempts' | 'maxTurns' | 'deadline'>;
export const CODEX_JOB_ACCOUNT_LANE = 'codex-subscription';
// This is a queue boundary inventory, not proof of all feature semantics.
export const CODEX_GENERATIVE_JOBS = new Set([
  'subagent', 'skillopt', 'extract-conversation-facts', 'enrich', 'facts-absorb',
  'contextual_reindex_per_chunk', 'autopilot-cycle', 'synthesize', 'patterns',
  'consolidate', 'extract_facts', 'extract-atoms-drain', 'extract-takes-from-pages',
  'chronicle_extract', 'loops_extract',
]);

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
  if (name === 'subagent') throw new PrivateRoutingError('job:subagent', 'private_native_loop_unsupported');
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
  const sourceId = data.source_id ?? data.sourceId;
  let sourceCreatedAt: string | null = null;
  if (sourceId !== undefined) {
    if (typeof sourceId !== 'string' || !sourceId ||
      (data.source_id !== undefined && data.sourceId !== undefined && data.source_id !== data.sourceId)) {
      throw new SubscriptionAdmissionError('subscription_identity_conflict');
    }
    const [source] = await engine.executeRaw<{ created_at: Date | string; archived: boolean }>(
      'SELECT created_at, archived FROM sources WHERE id=$1', [sourceId]);
    if (!source || source.archived) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    sourceCreatedAt = new Date(source.created_at).toISOString();
  }
  return `codex-job:${job.id}:v1:${authorityDigest({ name: job.name, data, authority: job.submission_authority,
    model: policy.model, bin: policy.bin, sourceCreatedAt })}`;
}

/** Must run inside the queue insertion transaction, including every coalescing path. */
export async function bindJobSubscription(engine: BrainEngine, job: MinionJob, grant?: JobSubscriptionAuthorization): Promise<void> {
  if (!grant) return;
  if (!readPrivateCodexConfig() || job.submission_authority?.kind !== 'application') {
    throw new SubscriptionAdmissionError('subscription_required');
  }
  if (Object.keys(grant).some(k => !['maxAttempts', 'maxTurns', 'deadline'].includes(k))) {
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
  // Avoid adding any model/config dependency to deterministic job handlers.
  if (!CODEX_GENERATIVE_JOBS.has(job.name)) return run();
  const policy = readPrivateCodexConfig();
  const rows = await engine.executeRaw<{ run_id: string }>('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1', [`codex-job:${job.id}:%`]);
  if (!policy && rows.length === 0) return run();
  await preflightSubscriptionJob(engine, job.name, job.data ?? {});
  if (!policy || rows.length !== 1) throw new SubscriptionAdmissionError('subscription_required');
  const runId = await runIdentity(engine, job);
  if (rows[0]!.run_id !== runId) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const checkAuthority = async () => {
    if (ctx.signal?.aborted || ctx.shutdownSignal?.aborted) throw new SubscriptionAdmissionError('subscription_owner_lost');
    const [row] = await engine.executeRaw<Record<string, unknown>>(
      `SELECT * FROM minion_jobs WHERE id=$1 AND lock_token=$2 AND status='active' AND lock_until>now()`, [job.id, job.lock_token]);
    if (!row) throw new SubscriptionAdmissionError('subscription_owner_lost');
    const current = rowToMinionJob(row);
    if (await runIdentity(engine, current) !== runId) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    await authorizeJobExecution(engine, current);
    await preflightSubscriptionJob(engine, current.name, current.data ?? {});
  };
  await checkAuthority();
  const signals = [ctx.signal, ctx.shutdownSignal].filter((s): s is AbortSignal => s !== undefined);
  return withCodexSubscription({ engine, runId, checkAuthority, signal: signals.length ? AbortSignal.any(signals) : undefined }, async () => {
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
