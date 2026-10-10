import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import type { SkillOptOpts } from './types.ts';
import { loadConfig, loadConfigWithEngine } from '../config.ts';
import { resolveSourceWithTier } from '../source-resolver.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../ai/subscription-context.ts';
import { withSubscriptionAuxiliaryBudget } from '../ai/subscription-auxiliary.ts';
import { readPrivateCodexConfig } from '../ai/private-policy.ts';
import { createSubscriptionRun, SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../minions/subscription-jobs.ts';
import { CODEX_READ_PROTOCOL, validateCodexReadJob } from '../minions/codex-action-contract.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { splitEvalAllowance, type EvalAllowance } from '../../eval/longmemeval/codex-allowance-flags.ts';
import { splitSharedOptimizerFlags } from './codex-shared-cli.ts';
import { usageError } from '../../cli/cli-error.ts';

const pending = new AsyncLocalStorage<Readonly<EvalAllowance>>();
export type LocalOptimizerScope = Pick<SkillOptOpts, 'operationContext' | 'codex' | 'sharedSkill'> & { backgroundAllowance?: Readonly<EvalAllowance> };
const bad = (message: string): never => { throw usageError(message, 'Use explicit Codex limits, --source ID and one or more --read-prefix slug-or-prefix/* flags for a single optimizer run.'); };

/** Local CLI authority only. No grant is persisted until all workflow inputs pass validation. */
export async function withSkillOptAllowance<T>(engine: BrainEngine, args: string[], run: (args: string[], scope: LocalOptimizerScope) => Promise<T>): Promise<T> {
  const split = splitEvalAllowance(args), shared = splitSharedOptimizerFlags(split.args), rest: string[] = [], prefixes: string[] = [];
  let source: string | undefined;
  for (let i = 0; i < shared.args.length; i++) {
    const flag = shared.args[i]!;
    if (flag !== '--source' && flag !== '--read-prefix') { rest.push(flag); continue; }
    const value = shared.args[++i];
    if (!value || value.startsWith('--')) bad(`${flag} requires a value.`);
    if (flag === '--source') { if (source !== undefined) bad('Duplicate --source.'); source = value; }
    else prefixes.push(value!);
  }
  const policy = readPrivateCodexConfig();
  if (!policy) {
    if (shared.target || split.allowance || source !== undefined || prefixes.length) bad('Codex optimizer flags require explicit private mode.');
    return run(rest, {});
  }
  // These producers have separate material-input/recovery requirements; never reinterpret a grant.
  if (rest.some(a => ['--all', '--target-models', '--bootstrap-from-skill', '--bootstrap-from-routing', '--resume'].includes(a)))
    bad('This private CLI grant currently supports a single optimizer run.');
  if (rest.includes('--follow') && !rest.includes('--background')) bad('--follow requires --background.');
  if (!source || !prefixes.length || new Set(prefixes).size !== prefixes.length) bad('Private optimizer reads need an explicit source and distinct read prefixes.');
  validateCodexReadJob({ action_protocol: CODEX_READ_PROTOCOL, prompt: 'scope preflight', source_id: source,
    allowed_tools: ['get_page'], allowed_slug_prefixes: prefixes, max_turns: 16, no_self_fix: true });
  const grant = split.allowance;
  if (!grant || codexSubscriptionContext()) bad('Supply one complete subscription allowance without an enclosing grant.');
  const sourceId = (await resolveSourceWithTier(engine, source)).source_id;
  const config = await loadConfigWithEngine(engine, loadConfig() ?? { engine: engine.kind });
  if (!config) bad('A readable local configuration is required.');
  const scope: LocalOptimizerScope = { ...(shared.target ? { sharedSkill: { ...shared.target, source_id: sourceId, request_id: grant!.requestId } } : {}), operationContext: { engine, sourceId, remote: false, config: config!,
    logger: { info: console.log, warn: console.warn, error: console.error }, dryRun: rest.includes('--dry-run') },
    codex: { allowedTools: ['get_page'], allowedSlugPrefixes: prefixes } };
  const runId = `codex-skillopt:${grant!.requestId}`, saved = Object.freeze({ ...grant!, deadline: new Date(grant!.deadline) });
  if (rest.includes('--background') && engine.kind !== 'pglite' && !rest.includes('--dry-run')) return run(rest, { ...scope, backgroundAllowance: saved });
  const abort = new AbortController(), cancel = () => abort.abort(new SubscriptionAdmissionError('subscription_owner_lost'));
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    return await pending.run(saved, () => withCodexSubscription({ engine, runId, signal: abort.signal }, () =>
      withSubscriptionAuxiliaryBudget(engine, `group:${runId}`, saved.auxiliaryUsd, () => run(rest, scope))));
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}

/** Part of the immutable workflow input, including the independent auxiliary cap. */
export function localOptimizerAllowance() {
  const grant = pending.getStore();
  return grant ? { requestId: grant.requestId, maxAttempts: grant.maxAttempts, maxTurns: grant.maxTurns,
    deadline: grant.deadline.toISOString(), auxiliaryUsd: grant.auxiliaryUsd ?? null } : null;
}

/** Same transaction as the optimizer input binding; failed preflight cannot leave an orphan grant. */
export async function ensureLocalOptimizerGrant(tx: BrainEngine, runId: string): Promise<void> {
  const grant = pending.getStore(); if (!grant) return;
  if (runId !== `codex-skillopt:${grant.requestId}`) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  await tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
  await declareDurablePersistence(tx);
  if ((await tx.executeRaw('SELECT request_id FROM codex_skillopt_submissions WHERE request_id=$1::uuid', [grant.requestId])).length)
    throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const [prior] = await tx.executeRaw<{ account_lane: string; max_attempts: number; max_turns: number; deadline: Date | string; parent_run_id: string | null }>(
    'SELECT account_lane,max_attempts,max_turns,deadline,parent_run_id FROM codex_subscription_runs WHERE run_id=$1 FOR UPDATE', [runId]);
  if (prior) {
    if (prior.account_lane !== CODEX_JOB_ACCOUNT_LANE || prior.parent_run_id !== null || prior.max_attempts !== grant.maxAttempts ||
        prior.max_turns !== grant.maxTurns || new Date(prior.deadline).getTime() !== grant.deadline.getTime()) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  } else await createSubscriptionRun(tx, { ...grant, runId, accountLane: CODEX_JOB_ACCOUNT_LANE });
}

export function reportOptimizerAllowance(): void {
  const grant = localOptimizerAllowance(); if (!grant) return;
  process.stderr.write(`[skillopt] subscription request ${grant.requestId} ${JSON.stringify({ ...grant, monetary_cost_usd: null, remaining_quota: null })}\n`);
}
