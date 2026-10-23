import { resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { EvalAllowance } from '../../eval/longmemeval/codex-allowance-flags.ts';
import type { GuardedBootstrapOpts, GuardedBootstrapResult } from './bootstrap-run.ts';
import type { ModelsPlanEntry, StrictVerdict } from './models-plan.ts';
import { MinionQueue } from '../minions/queue.ts';
import { APPLICATION_AUTHORITY } from '../minions/submission-authority.ts';
import type { MinionJobContext } from '../minions/types.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { digest } from '../persistence/digest.ts';
import { isWriteRequestId } from '../persistence/types.ts';
import { loadConfig, loadConfigWithEngine } from '../config.ts';
import { resolveSourceWithTier } from '../source-resolver.ts';
import { privatePolicyBinding, readPrivateCodexConfig } from '../ai/private-policy.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../minions/subscription-jobs.ts';
import { prepareCodexBootstrap } from './codex-bootstrap.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { runLocalCodexBootstrap } from './codex-bootstrap-local.ts';
import { bootstrapConflict, readBootstrapRun, type BootstrapInput, type BootstrapRun } from './codex-bootstrap-store.ts';
import { CODEX_BOOTSTRAP_JOB_PROTOCOL, validateCodexBootstrapJob, type CodexBootstrapJobData } from './codex-bootstrap-job-contract.ts';

const conflict = (): never => { throw new SubscriptionAdmissionError('subscription_identity_conflict'); };
const payloadHash = (data: Record<string, unknown>) => { const { __param_hash, ...value } = data; return digest(value); };
type BootstrapAllowance = Omit<EvalAllowance, 'auxiliaryUsd'> & { auxiliaryUsd: number | null };
export interface CodexBootstrapJobReceipt { id: number; name: 'skillopt'; status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'dead' | 'cancelled' | 'waiting-children' | 'paused' }

function allowanceSnapshot(value: BootstrapAllowance): CodexBootstrapJobData['bootstrap_allowance'] {
  return { requestId: value.requestId.toLowerCase(), maxAttempts: value.maxAttempts, maxTurns: value.maxTurns,
    deadline: value.deadline.toISOString(), auxiliaryUsd: value.auxiliaryUsd ?? null };
}

function privateScope(engine: BrainEngine, sourceId: string, config: Awaited<ReturnType<typeof loadConfigWithEngine>>) {
  if (!config) throw new SubscriptionAdmissionError('subscription_required');
  return { engine, config, remote: false as const, sourceId, dryRun: false,
    logger: { info: console.log, warn: console.warn, error: console.error } };
}

async function prepareInput(engine: BrainEngine, opts: GuardedBootstrapOpts, modelPlan: { plan: ModelsPlanEntry[]; strict: StrictVerdict },
  sourceId: string, allowance: BootstrapAllowance, prior?: BootstrapRun): Promise<BootstrapInput> {
  const policy = readPrivateCodexConfig(); if (!policy) throw new SubscriptionAdmissionError('subscription_required');
  const { engine: _engine, operationContext: _operationContext, abortSignal: _abortSignal, chatFn: _chatFn, ...controls } = opts;
  const normalized = { ...structuredClone(controls), skillsDir: resolve(opts.skillsDir), taskCount: opts.taskCount ?? 15,
    force: opts.force === true, modelsStrict: opts.modelsStrict === true, maxCostSource: opts.maxCostSource ?? 'default' };
  let prepared;
  try {
    prepared = await withCodexSubscription({ engine, runId: `codex-bootstrap-preflight:${allowance.requestId}` }, () =>
      prepareCodexBootstrap({ skillsDir: normalized.skillsDir, skillName: normalized.skillName, optimizerModel: normalized.optimizer.model,
        force: normalized.force, taskCount: normalized.taskCount, abortSignal: undefined }, normalized.mode,
      prior ? { files: prior.input.files, output: prior.result?.output } : undefined));
  } catch (error) {
    if (prior && error instanceof CodexProposalError && error.reason === 'invalid_input') conflict();
    throw error;
  }
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) bootstrapConflict();
  return { controls: { ...normalized, skillsDir: normalized.skillsDir, modelPlan, allowance: structuredClone(allowance) },
    files: prepared.files, sourceId, incarnation: source.incarnation, ...privatePolicyBinding(policy) };
}

/** Queue a prevalidated standalone draft under the same durable bootstrap plan used by foreground runs. */
export async function submitCodexBootstrapJob(engine: BrainEngine, original: GuardedBootstrapOpts,
  modelPlan: { plan: ModelsPlanEntry[]; strict: StrictVerdict }, scope: { sourceId: string; allowedTools: string[]; allowedSlugPrefixes: string[]; readRegistry?: 'codex-discovery-v1' },
  allowance: EvalAllowance): Promise<CodexBootstrapJobReceipt> {
  if (!readPrivateCodexConfig() || codexSubscriptionContext() || original.engine !== engine || original.operationContext?.engine !== engine ||
      original.operationContext.remote !== false || original.operationContext.sourceId !== scope.sourceId || original.chatFn || original.dryRun ||
      !isWriteRequestId(allowance.requestId)) throw new SubscriptionAdmissionError('subscription_required');
  if (modelPlan.strict.enabled && !modelPlan.strict.ok) throw new SubscriptionAdmissionError('subscription_invalid');
  const grant = structuredClone(allowance); grant.requestId = grant.requestId.toLowerCase();
  const storedAllowance: BootstrapAllowance = { ...grant, auxiliaryUsd: grant.auxiliaryUsd ?? null };
  const requestId = grant.requestId;
  const [prior] = await engine.executeRaw<BootstrapRun>('SELECT * FROM codex_skillopt_bootstraps WHERE request_id=$1::uuid', [requestId]);
  if (prior && (!prior.job_id || !prior.input)) conflict();
  const source = await resolveSourceWithTier(engine, scope.sourceId);
  const canonicalScope = { sourceId: source.source_id, allowedTools: scope.allowedTools, allowedSlugPrefixes: scope.allowedSlugPrefixes,
    ...(scope.readRegistry ? { readRegistry: scope.readRegistry } : {}) };
  const input = await prepareInput(engine, original, modelPlan, source.source_id, storedAllowance, prior);
  const inputHash = digest(input);
  if (prior && prior.input_hash !== inputHash) conflict();
  const data: CodexBootstrapJobData = {
    bootstrap_protocol: CODEX_BOOTSTRAP_JOB_PROTOCOL, bootstrap_request_id: requestId, bootstrap_input_hash: inputHash,
    bootstrap_options: { mode: original.mode, skillsDir: resolve(original.skillsDir), skillName: original.skillName,
      optimizer: structuredClone(original.optimizer), taskCount: original.taskCount ?? 15, force: original.force === true,
      dryRun: false, modelsStrict: original.modelsStrict === true, maxCostUsd: original.maxCostUsd,
      maxCostSource: original.maxCostSource ?? 'default' }, bootstrap_models_plan: structuredClone(modelPlan.plan), bootstrap_strict: { ...structuredClone(modelPlan.strict) },
    bootstrap_allowance: allowanceSnapshot(storedAllowance), source_id: canonicalScope.sourceId, allowed_tools: [...canonicalScope.allowedTools],
    allowed_slug_prefixes: [...canonicalScope.allowedSlugPrefixes], ...(canonicalScope.readRegistry ? { read_registry: canonicalScope.readRegistry } : {}) };
  validateCodexBootstrapJob(data);
  const dataHash = payloadHash(data);
  if (prior) {
    const [job] = await engine.executeRaw<{ id: number; name: string; status: CodexBootstrapJobReceipt['status']; data: Record<string, unknown> }>(
      'SELECT id,name,status,data FROM minion_jobs WHERE id=$1', [prior.job_id]);
    if (!job || job.name !== 'skillopt' || payloadHash(job.data ?? {}) !== dataHash) conflict();
    return { id: Number(job.id), name: 'skillopt', status: job.status };
  }
  const queued = await engine.transaction(async tx => {
    await declareDurablePersistence(tx); await tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    await tx.executeRaw('SELECT gbrain_codex_subscription_lock_path($1)', [`codex-skillopt:${requestId}`]);
    const collisions = await tx.executeRaw(`SELECT request_id::text AS id FROM codex_skillopt_submissions WHERE request_id=$1::uuid
      UNION ALL SELECT request_id::text FROM codex_skillopt_batch_submissions WHERE request_id=$1::uuid
      UNION ALL SELECT run_id FROM codex_subscription_runs WHERE run_id=$2
      UNION ALL SELECT run_id FROM codex_skillopt_runs WHERE run_id=$2
      UNION ALL SELECT run_id FROM codex_skillopt_bootstraps WHERE run_id<>$2 AND input->'controls'->'allowance'->>'requestId'=$1::text`,
    [requestId, `codex-skillopt:${requestId}`]);
    if (collisions.length) conflict();
    const [existing] = await tx.executeRaw<BootstrapRun>('SELECT * FROM codex_skillopt_bootstraps WHERE request_id=$1::uuid FOR UPDATE', [requestId]);
    if (existing) conflict();
    const job = await new MinionQueue(tx).add('skillopt', data, { queue: 'default', idempotency_key: `codex-skillopt-bootstrap:${requestId}`,
      max_attempts: 1, max_stalled: 5, remove_on_complete: false, remove_on_fail: false, lock_duration_ms: 900000,
      timeout_ms: Math.max(1, Math.min(600000, grant.deadline.getTime() - Date.now())) },
    { submissionAuthority: APPLICATION_AUTHORITY, allowProtectedSubmit: true,
      codexSubscription: { maxAttempts: grant.maxAttempts, maxTurns: grant.maxTurns, deadline: grant.deadline } });
    if (job.coalesced) conflict();
    const roots = await tx.executeRaw<{ run_id: string }>('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1', [`codex-job:${job.id}:%`]);
    if (roots.length !== 1) conflict();
    await tx.executeRaw(`INSERT INTO codex_skillopt_bootstraps(run_id,protocol,input,input_hash,request_id,job_id)
      VALUES($1,1,$2::text::jsonb,$3,$4::uuid,$5)`, [roots[0]!.run_id, JSON.stringify(input), inputHash, requestId, job.id]);
    return job;
  });
  return { id: Number(queued.id), name: 'skillopt', status: queued.status };
}

/** Rebuild only from the application-bound job, its persisted allowance and retained preflight plan. */
export async function runCodexBootstrapJob(engine: BrainEngine, raw: Record<string, unknown>, context: MinionJobContext) {
  const host = codexSubscriptionContext(); validateCodexBootstrapJob(raw);
  const data = structuredClone(raw) as CodexBootstrapJobData;
  if (!host || host.engine !== engine || !context || context.submission_authority?.kind !== 'application' ||
      host.publicationFence?.jobId !== context.id || !host.checkAuthority || !host.checkAuthorityInTransaction) throw new SubscriptionAdmissionError('subscription_required');
  await host.checkAuthority();
  const [plan] = await engine.executeRaw<BootstrapRun>('SELECT * FROM codex_skillopt_bootstraps WHERE run_id=$1 AND request_id=$2::uuid AND job_id=$3',
    [host.runId, data.bootstrap_request_id, context.id]);
  if (!plan || plan.protocol !== 1 || plan.input_hash !== data.bootstrap_input_hash || digest(plan.input) !== plan.input_hash || plan.run_id !== host.runId) conflict();
  const [grantRow] = await engine.executeRaw<{ account_lane: string; max_attempts: number; max_turns: number; deadline: Date | string; parent_run_id: string | null }>(
    'SELECT account_lane,max_attempts,max_turns,deadline,parent_run_id FROM codex_subscription_runs WHERE run_id=$1', [host.runId]);
  const requested = data.bootstrap_allowance;
  if (!grantRow || grantRow.account_lane !== CODEX_JOB_ACCOUNT_LANE || grantRow.parent_run_id !== null ||
      grantRow.max_attempts !== requested.maxAttempts || grantRow.max_turns !== requested.maxTurns ||
      new Date(grantRow.deadline).toISOString() !== new Date(requested.deadline).toISOString()) conflict();
  const options = data.bootstrap_options;
  const config = await loadConfigWithEngine(engine, loadConfig() ?? { engine: engine.kind });
  const operationContext = privateScope(engine, data.source_id, config);
  const allowance: BootstrapAllowance = { requestId: requested.requestId, maxAttempts: requested.maxAttempts, maxTurns: requested.maxTurns,
    deadline: new Date(requested.deadline), auxiliaryUsd: requested.auxiliaryUsd };
  const result = await runLocalCodexBootstrap({ engine, operationContext, mode: options.mode as 'routing' | 'skill',
    skillsDir: options.skillsDir as string, skillName: options.skillName as string,
    optimizer: options.optimizer as GuardedBootstrapOpts['optimizer'], taskCount: Number(options.taskCount), force: options.force === true,
    dryRun: false, modelsStrict: options.modelsStrict === true, maxCostUsd: Number(options.maxCostUsd), maxCostSource: options.maxCostSource as 'user' | 'default' },
  { plan: data.bootstrap_models_plan as ModelsPlanEntry[], strict: data.bootstrap_strict as unknown as StrictVerdict }, allowance, plan.input_hash);
  if (result === undefined) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const guarded: GuardedBootstrapResult = { dry_run: false, models_plan: data.bootstrap_models_plan as ModelsPlanEntry[],
    strict: data.bootstrap_strict as unknown as StrictVerdict, result, cost_usd: null };
  return { billing: 'subscription', remaining_quota: null, ...guarded };
}
