import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { assertPrivateRoute, readPrivateCodexConfig } from '../core/ai/private-policy.ts';
import { createSubscriptionRun, SubscriptionAdmissionError } from '../core/ai/subscription-admission.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../core/ai/subscription-context.ts';
import { assertSubscriptionTarget } from '../core/ai/subscription-target.ts';
import { withSubscriptionAuxiliaryBudget } from '../core/ai/subscription-auxiliary.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../core/minions/subscription-jobs.ts';
import { declareDurablePersistence } from '../core/persistence/protocol.ts';
import { digest } from '../core/persistence/digest.ts';
import { isWriteRequestId } from '../core/persistence/types.ts';
import { intFlagValue, numberFlagValue } from '../cli/flag-values.ts';
import { usageError } from '../cli/cli-error.ts';
import { CODEX_EVAL_INPUT_TABLES } from '../core/schema-migrations/v290-codex-eval-input-clock.ts';

export interface EvalContradictionAllowance {
  maxAttempts?: string;
  maxTurns?: string;
  deadline?: string;
  requestId?: string;
  maxUsd?: string;
}
export interface EvalContradictionIdentity {
  queries: string[];
  judgeModel: string;
  topK: number;
  sampling: 'deterministic' | 'score-first';
  budgetUsd: number;
  maxPairChars: number;
  noCache: boolean;
  refreshCache: boolean;
  output?: string;
}

const hasFlags = (flags: EvalContradictionAllowance): boolean =>
  Object.values(flags).some(value => value !== undefined);

function parseAllowance(flags: EvalContradictionAllowance) {
  if (!flags.maxAttempts || !flags.maxTurns || !flags.deadline) {
    throw new SubscriptionAdmissionError('subscription_required');
  }
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
  const maxUsd = flags.maxUsd === undefined ? undefined : numberFlagValue(flags.maxUsd, '--max-usd', { min: 0.000001, example: 1 });
  return { maxAttempts, maxTurns, deadline, requestId: requestId.toLowerCase(), maxUsd };
}

async function sources(engine: BrainEngine): Promise<Array<{ id: string; incarnation: string; archived: boolean }>> {
  return engine.executeRaw('SELECT id,incarnation,archived FROM sources ORDER BY id');
}

/** Every page write advances this clock, including deletes and writes that later roll back. */
async function pageClock(engine: BrainEngine): Promise<string> {
  const [row] = await engine.executeRaw<{ value: string }>(
    'SELECT last_value::text AS value FROM page_generation_clock_seq');
  if (!row) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  return row.value;
}

/** Statement triggers advance this even when a transaction later rolls back. */
async function inputClock(engine: BrainEngine): Promise<string> {
  const [row] = await engine.executeRaw<{ value: string }>(
    'SELECT last_value::text AS value FROM codex_eval_input_clock_seq');
  if (!row) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  return row.value;
}

/** Close each clock check-to-write window, including new retrieval rows. */
async function lockCorpus(engine: BrainEngine): Promise<void> {
  await engine.executeRaw("SELECT set_config('lock_timeout','1s',true)");
  await engine.executeRaw(`LOCK TABLE sources,pages,${CODEX_EVAL_INPUT_TABLES.filter(table => table !== 'sources').join(',')} IN SHARE MODE`);
}

/** A local CLI allowance binds query, route, options, and source inventory before any private work. */
export async function withEvalContradictionSubscription<T>(engine: BrainEngine, flags: EvalContradictionAllowance,
  identity: EvalContradictionIdentity, run: () => Promise<T>): Promise<T> {
  const policy = readPrivateCodexConfig();
  const enclosing = codexSubscriptionContext();
  if (!policy) {
    if (hasFlags(flags)) throw usageError('Codex allowance flags require strict private configuration.', 'Configure private Codex before granting subscription calls.');
    return run();
  }
  assertPrivateRoute(identity.judgeModel, 'eval-contradictions:cli', policy);
  if (enclosing) {
    if (hasFlags(flags)) throw usageError('An enclosing host already owns the subscription allowance.', 'Reuse the host allowance without nested Codex flags.');
    await assertSubscriptionTarget(engine);
    await enclosing.checkAuthority?.();
    const [allowance] = await enclosing.engine.executeRaw<{ current: boolean }>(
      'SELECT deadline > now() AS current FROM codex_subscription_runs WHERE run_id=$1', [enclosing.runId]);
    if (!allowance) throw new SubscriptionAdmissionError('subscription_required');
    if (!allowance.current) throw new SubscriptionAdmissionError('subscription_exhausted');
    return run();
  }
  const grant = parseAllowance(flags);
  const snapshot = await sources(engine), clock = await pageClock(engine), retrievalClock = await inputClock(engine);
  const claim = { identity, sources: snapshot, pageClock: clock, inputClock: retrievalClock, model: policy.model, bin: policy.bin,
    auxiliaryUsd: grant.maxUsd ?? null };
  const prefix = `codex-eval:${grant.requestId}:`;
  const runId = prefix + digest(claim);
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    await tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    await lockCorpus(tx);
    await declareDurablePersistence(tx);
    if (digest({ ...claim, sources: await sources(tx), pageClock: await pageClock(tx), inputClock: await inputClock(tx) }) !== digest(claim)) {
      throw new SubscriptionAdmissionError('subscription_identity_conflict');
    }
    const prior = await tx.executeRaw<{ run_id: string }>('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1', [`${prefix}%`]);
    if (prior.some(row => row.run_id !== runId)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    await createSubscriptionRun(tx, { runId, accountLane: CODEX_JOB_ACCOUNT_LANE,
      maxAttempts: grant.maxAttempts, maxTurns: grant.maxTurns, deadline: grant.deadline });
  });
  const checkAuthority = async (db: BrainEngine = engine) => {
    const current = readPrivateCodexConfig();
    if (!current || current.model !== policy.model || current.bin !== policy.bin) {
      throw new SubscriptionAdmissionError('subscription_identity_conflict');
    }
    assertPrivateRoute(identity.judgeModel, 'eval-contradictions:cli', policy);
    if (digest({ ...claim, sources: await sources(db), pageClock: await pageClock(db), inputClock: await inputClock(db) }) !== digest(claim)) {
      throw new SubscriptionAdmissionError('subscription_identity_conflict');
    }
  };
  const checkAuthorityInTransaction = async (tx: BrainEngine) => {
    await lockCorpus(tx);
    await checkAuthority(tx);
  };
  process.stderr.write(`[eval suspected-contradictions] subscription request ${grant.requestId} ` +
    JSON.stringify({ billing: 'subscription', max_attempts: grant.maxAttempts, max_turns: grant.maxTurns,
      deadline: grant.deadline.toISOString(), auxiliary_cap_usd: grant.maxUsd ?? null }) + '\n');
  return withCodexSubscription({ engine, runId, checkAuthority, checkAuthorityInTransaction },
    () => withSubscriptionAuxiliaryBudget(engine, `group:${runId}`, grant.maxUsd, async () => {
      const result = await run();
      await checkAuthority();
      return result;
    }));
}
