import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { readPrivateCodexConfig, type PrivateCodexConfig } from '../core/ai/private-policy.ts';
import { createSubscriptionRun, SubscriptionAdmissionError } from '../core/ai/subscription-admission.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../core/ai/subscription-context.ts';
import { withSubscriptionAuxiliaryBudget } from '../core/ai/subscription-auxiliary.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../core/minions/subscription-jobs.ts';
import { declareDurablePersistence } from '../core/persistence/protocol.ts';
import { digest, sha256 } from '../core/persistence/digest.ts';
import { resolveNightlyProbeModelRoutes } from '../core/cycle/nightly-probe-routes.ts';
import { resolveNightlyProbeSearchConfigSnapshot } from '../core/cycle/nightly-probe-search-config.ts';
import type { NightlyProbeResult, NightlyProbeRunScope } from '../core/cycle/nightly-quality-probe.ts';

/** A UTC-day occurrence is immutable; a restart reuses its deadline and counters. */
export async function withScheduledNightlyProbe(engine: BrainEngine, input: NightlyProbeRunScope,
  run: () => Promise<NightlyProbeResult>): Promise<NightlyProbeResult> {
  const policy = readPrivateCodexConfig();
  if (!policy) return run();
  if (codexSubscriptionContext()) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const limits = policy.scheduled_jobs?.['nightly-quality-probe'];
  if (!limits) throw new SubscriptionAdmissionError('subscription_required');
  if (!limits.auxiliaryMaxUsd) throw new SubscriptionAdmissionError('subscription_auxiliary_budget_required');
  if (!Number.isFinite(input.startedAt.getTime()) || Math.abs(Date.now() - input.startedAt.getTime()) > 300_000 ||
      !input.modelRoutes || !Number.isFinite(input.maxUsd) || input.maxUsd <= 0) {
    throw new SubscriptionAdmissionError('subscription_identity_conflict');
  }
  const fixtureHash = sha256(readFileSync(input.fixturePath));
  const routeAndSearch = async (db: BrainEngine) => ({
    modelRoutes: await resolveNightlyProbeModelRoutes(db),
    searchConfigSnapshot: await resolveNightlyProbeSearchConfigSnapshot(db),
  });
  const selected = { modelRoutes: input.modelRoutes, searchConfigSnapshot: input.searchConfigSnapshot ?? {} };
  if (digest(await routeAndSearch(engine)) !== digest(selected)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const occurrence = input.startedAt.toISOString().slice(0, 10);
  const prefix = `codex-nightly-quality:${occurrence}:`;
  const policyIdentity = (value: PrivateCodexConfig) => ({ model: value.model, bin: value.bin,
    limits: value.scheduled_jobs?.['nightly-quality-probe'] });
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  if (!brain) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const claim = { protocol: 'codex-nightly-quality-v1', brainId: brain.brain_id,
    fixtureHash, maxUsd: input.maxUsd, ...selected, policy: policyIdentity(policy) };
  const runId = prefix + digest(claim);
  const checkIdentity = async (db: BrainEngine) => {
    const current = readPrivateCodexConfig();
    if (!current || digest(policyIdentity(current)) !== digest(policyIdentity(policy)) ||
        sha256(readFileSync(input.fixturePath)) !== fixtureHash ||
        digest(await routeAndSearch(db)) !== digest(selected)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    const [owner] = await db.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    if (owner?.brain_id !== brain.brain_id) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  };
  await engine.transaction(async tx => {
    await tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    await declareDurablePersistence(tx);
    await checkIdentity(tx);
    const prior = await tx.executeRaw<{ run_id: string; deadline: Date | string }>(
      'SELECT run_id,deadline FROM codex_subscription_runs WHERE run_id LIKE $1 FOR UPDATE', [`${prefix}%`]);
    if (prior.some(row => row.run_id !== runId)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    const deadline = prior.length ? new Date(prior[0]!.deadline) : new Date(Date.now() + limits.windowMs);
    if (deadline.getTime() <= Date.now()) throw new SubscriptionAdmissionError('subscription_exhausted');
    await createSubscriptionRun(tx, { runId, accountLane: CODEX_JOB_ACCOUNT_LANE,
      maxAttempts: limits.maxAttempts, maxTurns: limits.maxTurns, deadline });
  });
  process.stderr.write(`[nightly-quality-probe] subscription occurrence ${occurrence} ` + JSON.stringify({
    billing: 'subscription', max_attempts: limits.maxAttempts, max_turns: limits.maxTurns,
    auxiliary_cap_usd: limits.auxiliaryMaxUsd, monetary_cost_usd: null }) + '\n');
  return withCodexSubscription({ engine, runId, checkAuthority: () => checkIdentity(engine),
    checkAuthorityInTransaction: tx => checkIdentity(tx) },
  () => withSubscriptionAuxiliaryBudget(engine, `group:${runId}`, limits.auxiliaryMaxUsd, run));
}
