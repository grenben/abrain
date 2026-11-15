import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { privatePolicyBinding, privatePolicyFingerprint, readPrivateCodexConfig, resolvePrivateModel } from '../core/ai/private-policy.ts';
import { createSubscriptionRun, SubscriptionAdmissionError } from '../core/ai/subscription-admission.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../core/ai/subscription-context.ts';
import { assertSubscriptionTarget } from '../core/ai/subscription-target.ts';
import { withSubscriptionAuxiliaryBudget } from '../core/ai/subscription-auxiliary.ts';
import { hasAIInvocationGuard } from '../core/ai/invocation-guard.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../core/minions/subscription-jobs.ts';
import { declareDurablePersistence } from '../core/persistence/protocol.ts';
import { digest } from '../core/persistence/digest.ts';
import { isWriteRequestId } from '../core/persistence/types.ts';
import { intFlagValue } from '../cli/flag-values.ts';
import { usageError } from '../cli/cli-error.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import type { MinionJob } from '../core/minions/types.ts';
import type { SpendAuthorization } from '../core/minions/spend-record.ts';

export interface EnrichAllowanceFlags {
  maxAttempts?: string;
  maxTurns?: string;
  deadline?: string;
  requestId?: string;
}
export interface EnrichRunIdentity {
  sourceIds: string[];
  params: Record<string, unknown>;
  auxiliaryMaxUsd?: number;
}

const hasFlags = (flags: EnrichAllowanceFlags) => Object.values(flags).some(value => value !== undefined);

function parseGrant(flags: EnrichAllowanceFlags) {
  if (!flags.maxAttempts || !flags.maxTurns || !flags.deadline) throw new SubscriptionAdmissionError('subscription_required');
  const maxAttempts = intFlagValue(flags.maxAttempts, '--codex-max-attempts', { min: 1, max: 1000, example: 10 });
  const maxTurns = intFlagValue(flags.maxTurns, '--codex-max-turns', { min: 1, max: maxAttempts, example: 10 });
  const deadline = new Date(flags.deadline);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(flags.deadline) ||
      !Number.isFinite(deadline.getTime()) || deadline.toISOString().replace('.000Z', 'Z') !== flags.deadline.replace('.000Z', 'Z') ||
      deadline.getTime() <= Date.now() || deadline.getTime() > Date.now() + 86_400_000) {
    throw usageError('--codex-deadline must be a future UTC ISO timestamp within 24 hours.', 'Use the same absolute deadline when retrying a request ID.');
  }
  const requestId = flags.requestId ?? randomUUID();
  if (!isWriteRequestId(requestId)) throw usageError('--codex-request-id must be a UUID.', 'Supply a UUID or omit it to generate a new request.');
  return { maxAttempts, maxTurns, deadline, requestId: requestId.toLowerCase() };
}

async function selectedSources(engine: BrainEngine, ids: string[]) {
  const rows = await engine.executeRaw<{ id: string; incarnation: string; archived: boolean }>(
    'SELECT id,incarnation,archived FROM sources ORDER BY id');
  const selected = rows.filter(row => ids.includes(row.id));
  if (selected.length !== new Set(ids).size || selected.some(row => row.archived)) {
    throw new SubscriptionAdmissionError('subscription_identity_conflict');
  }
  return selected;
}

async function lockSources(tx: BrainEngine, ids: string[]) {
  await tx.executeRaw('SELECT id FROM sources WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE', [ids]);
}

/** Local CLI admission for a fixed source set; page revisions guard each write. */
export async function withEnrichSubscription<T>(engine: BrainEngine, flags: EnrichAllowanceFlags,
  identity: EnrichRunIdentity, run: (model: string | undefined) => Promise<T>, dryRun = false): Promise<T> {
  const policy = readPrivateCodexConfig();
  if (!policy || dryRun) {
    if (hasFlags(flags)) throw usageError('Codex allowance flags require private, non-dry-run enrichment.', 'Remove the flags or enable strict private Codex.');
    return run(identity.params.model as string | undefined);
  }
  if (identity.auxiliaryMaxUsd !== undefined && (!Number.isFinite(identity.auxiliaryMaxUsd) || identity.auxiliaryMaxUsd <= 0)) {
    throw new SubscriptionAdmissionError('subscription_auxiliary_budget_required');
  }
  const model = (await resolvePrivateModel(engine, { privateRole: 'enrichment', cliFlag: identity.params.model as string | undefined,
    configKey: 'models.chat', tier: 'reasoning', fallback: 'unused' }, policy)).model;
  const sourceIds = [...identity.sourceIds].sort();
  const bound = await selectedSources(engine, sourceIds);
  const sourceCheck = async (db: BrainEngine) => {
    const current = readPrivateCodexConfig();
    if (!current || privatePolicyFingerprint(current) !== privatePolicyFingerprint(policy) ||
        digest(await selectedSources(db, sourceIds)) !== digest(bound)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    await resolvePrivateModel(db, { privateRole: 'enrichment', cliFlag: identity.params.model as string | undefined,
      configKey: 'models.chat', tier: 'reasoning', fallback: 'unused' }, current);
  };
  const enclosing = codexSubscriptionContext();
  if (enclosing) {
    if (hasFlags(flags)) throw usageError('An enclosing host already owns the subscription allowance.', 'Reuse the host allowance without nested Codex flags.');
    if (await assertSubscriptionTarget(engine)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    await enclosing.checkAuthority?.();
    const [allowance] = await enclosing.engine.executeRaw<{ current: boolean }>(
      'SELECT deadline > now() AS current FROM codex_subscription_runs WHERE run_id=$1', [enclosing.runId]);
    if (!allowance) throw new SubscriptionAdmissionError('subscription_required');
    if (!allowance.current) throw new SubscriptionAdmissionError('subscription_exhausted');
    const nested = { ...enclosing,
      checkAuthority: async () => { await enclosing.checkAuthority?.(); await sourceCheck(engine); },
      checkAuthorityInTransaction: async (tx: BrainEngine) => {
        await enclosing.checkAuthorityInTransaction?.(tx); await lockSources(tx, sourceIds); await sourceCheck(tx);
      },
    };
    const runBound = async () => {
      const result = await run(model);
      await nested.checkAuthority();
      return result;
    };
    return withCodexSubscription(nested, () => hasAIInvocationGuard() ? runBound() :
      withSubscriptionAuxiliaryBudget(engine, `group:${enclosing.runId}:enrich`, identity.auxiliaryMaxUsd, runBound));
  }
  const grant = parseGrant(flags);
  const claim = { protocol: 'codex-enrich-cli-v1', identity, sourceIds, sources: bound,
    ...privatePolicyBinding(policy), auxiliaryMaxUsd: identity.auxiliaryMaxUsd ?? null };
  const prefix = `codex-enrich:${grant.requestId}:`;
  const runId = prefix + digest(claim);
  await engine.transaction(async tx => {
    await tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    await lockSources(tx, sourceIds);
    await declareDurablePersistence(tx);
    await sourceCheck(tx);
    const prior = await tx.executeRaw<{ run_id: string }>('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1', [`${prefix}%`]);
    if (prior.some(row => row.run_id !== runId)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    await createSubscriptionRun(tx, { runId, accountLane: CODEX_JOB_ACCOUNT_LANE,
      maxAttempts: grant.maxAttempts, maxTurns: grant.maxTurns, deadline: grant.deadline });
  });
  const checkAuthority = async (db: BrainEngine = engine) => sourceCheck(db);
  const checkAuthorityInTransaction = async (tx: BrainEngine) => { await lockSources(tx, sourceIds); await sourceCheck(tx); };
  process.stderr.write(`[enrich] subscription request ${grant.requestId} ` + JSON.stringify({ billing: 'subscription',
    max_attempts: grant.maxAttempts, max_turns: grant.maxTurns, deadline: grant.deadline.toISOString(),
    auxiliary_cap_usd: identity.auxiliaryMaxUsd ?? null }) + '\n');
  return withCodexSubscription({ engine, runId, checkAuthority, checkAuthorityInTransaction },
    () => withSubscriptionAuxiliaryBudget(engine, `group:${runId}`, identity.auxiliaryMaxUsd, async () => {
      const result = await run(model);
      await checkAuthority();
      return result;
    }));
}

/** One durable parent allowance and one paid cap across the entire source fan-out. */
export async function queuePrivateEnrich(engine: BrainEngine, flags: EnrichAllowanceFlags,
  identity: EnrichRunIdentity, paramsForSource: (sourceId: string) => Record<string, unknown>,
  keyForSource: (sourceId: string) => string, spendAuthorization?: SpendAuthorization): Promise<{
    jobs: MinionJob[]; requestId: string; spendAuthorization?: SpendAuthorization;
  }> {
  const policy = readPrivateCodexConfig();
  if (!policy || codexSubscriptionContext()) throw new SubscriptionAdmissionError('subscription_required');
  if (identity.auxiliaryMaxUsd !== undefined && (!Number.isFinite(identity.auxiliaryMaxUsd) || identity.auxiliaryMaxUsd <= 0)) {
    throw new SubscriptionAdmissionError('subscription_auxiliary_budget_required');
  }
  const grant = parseGrant(flags);
  await resolvePrivateModel(engine, { privateRole: 'enrichment', cliFlag: identity.params.model as string | undefined,
    configKey: 'models.chat', tier: 'reasoning', fallback: 'unused' }, policy);
  const sourceIds = [...new Set(identity.sourceIds)].sort();
  const paid = spendAuthorization ? { ...spendAuthorization, group_id: grant.requestId } : undefined;
  if (paid?.uncapped || identity.auxiliaryMaxUsd !== undefined && (!paid || paid.cap_usd !== identity.auxiliaryMaxUsd)) {
    throw new SubscriptionAdmissionError('subscription_auxiliary_budget_required');
  }
  const jobs = await engine.transaction(async tx => {
    await tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    await declareDurablePersistence(tx);
    await lockSources(tx, sourceIds);
    const sources = await selectedSources(tx, sourceIds);
    const current = readPrivateCodexConfig();
    if (!current || privatePolicyFingerprint(current) !== privatePolicyFingerprint(policy)) {
      throw new SubscriptionAdmissionError('subscription_identity_conflict');
    }
    const prefix = `codex-enrich-batch:${grant.requestId}:`;
    const runId = prefix + digest({ protocol: 'codex-enrich-batch-v1', identity, sources,
      ...privatePolicyBinding(policy), auxiliaryMaxUsd: identity.auxiliaryMaxUsd ?? null });
    const prior = await tx.executeRaw<{ run_id: string }>('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1', [`${prefix}%`]);
    if (prior.some(row => row.run_id !== runId)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    await createSubscriptionRun(tx, { ...grant, runId, accountLane: CODEX_JOB_ACCOUNT_LANE });
    const queue = new MinionQueue(tx);
    const submitted: MinionJob[] = [];
    for (const sourceId of sourceIds) {
      submitted.push(await queue.add('enrich', paramsForSource(sourceId),
        { idempotency_key: `${keyForSource(sourceId)}:${grant.requestId}` },
        { codexSubscription: { maxAttempts: grant.maxAttempts, maxTurns: grant.maxTurns,
          deadline: grant.deadline, parentRunId: runId }, ...(paid ? { spendAuthorization: paid } : {}) }));
    }
    return submitted;
  });
  process.stderr.write(`[enrich] subscription batch ${grant.requestId} ` + JSON.stringify({ billing: 'subscription',
    jobs: jobs.length, max_attempts: grant.maxAttempts, max_turns: grant.maxTurns,
    deadline: grant.deadline.toISOString(), auxiliary_cap_usd: identity.auxiliaryMaxUsd ?? null }) + '\n');
  return { jobs, requestId: grant.requestId, ...(paid ? { spendAuthorization: paid } : {}) };
}
