import { resolve, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { EvalAllowance } from '../../eval/longmemeval/codex-allowance-flags.ts';
import type { SkillOptJobInput } from './job.ts';
import { buildSkillOptJobData, skillOptJobOptions } from './job.ts';
import { collectSkillsWithBenchmarks } from './batch.ts';
import { prepareCodexSkillOpt } from './codex-run.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../ai/subscription-context.ts';
import { readPrivateCodexConfig } from '../ai/private-policy.ts';
import { loadConfig, loadConfigWithEngine } from '../config.ts';
import { resolveSourceWithTier } from '../source-resolver.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { isWriteRequestId } from '../persistence/types.ts';
import { digest } from '../persistence/digest.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { MinionQueue } from '../minions/queue.ts';
import { APPLICATION_AUTHORITY } from '../minions/submission-authority.ts';
import { CODEX_OPTIMIZER_JOB_PROTOCOL, CODEX_SKILLOPT_BATCH_JOB_PROTOCOL, validateCodexOptimizerJob } from './codex-job-contract.ts';
const conflict = (): never => { throw new SubscriptionAdmissionError('subscription_identity_conflict'); };
const payloadHash = (data: Record<string, unknown>) => { const { __param_hash, ...value } = data; return digest(value); };
interface Binding { request_id: string; protocol: number; request_hash: string; data_hash: string; job_id: number }
export type CodexSkillOptBatchInput = Omit<SkillOptJobInput, 'skillName' | 'benchmarkPath' | 'sharedSkill'>;
export type CodexSkillOptBatchScope = {
  sourceId: string;
  allowedTools: string[];
  allowedSlugPrefixes: string[];
  readRegistry?: 'codex-discovery-v1';
};
export type CodexSkillOptBatchAllowance = EvalAllowance;
export type SkillOptBatchJobInput = CodexSkillOptBatchInput;
export interface CodexSkillOptBatchJobReceipt {
  id: number;
  name: 'skillopt';
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'dead' | 'cancelled' | 'waiting-children' | 'paused';
}

function commonData(input: SkillOptBatchJobInput, skillsDir: string, names: string[], entries: Array<{ skill: string; inputHash: string }>, scope: CodexSkillOptBatchScope, requestId: string) {
  const placeholder: SkillOptJobInput = { ...input, skillName: 'batch-placeholder', benchmarkPath: join(skillsDir, '.codex-batch-placeholder'), models: input.models, modelFlags: input.modelFlags };
  const data = buildSkillOptJobData(placeholder);
  Object.assign(data, { optimizer_protocol: CODEX_OPTIMIZER_JOB_PROTOCOL, optimizer_batch_protocol: CODEX_SKILLOPT_BATCH_JOB_PROTOCOL,
    optimizer_request_id: requestId, optimizer_input_hash: digest(entries), optimizer_batch_entries: entries, optimizer_batch_selection: names,
    source_id: scope.sourceId, ...(scope.readRegistry !== undefined ? { read_registry: scope.readRegistry } : {}),
    allowed_tools: scope.allowedTools, allowed_slug_prefixes: scope.allowedSlugPrefixes });
  validateCodexOptimizerJob(data);
  return data;
}
function requestHash(input: SkillOptBatchJobInput, scope: CodexSkillOptBatchScope, grant: EvalAllowance): string {
  return digest({ protocol: CODEX_SKILLOPT_BATCH_JOB_PROTOCOL, input, sourceId: scope.sourceId,
    readRegistry: scope.readRegistry ?? null, allowedTools: scope.allowedTools, allowedSlugPrefixes: scope.allowedSlugPrefixes,
    grant: { requestId: grant.requestId.toLowerCase(), maxAttempts: grant.maxAttempts, maxTurns: grant.maxTurns, deadline: grant.deadline.toISOString(), auxiliaryUsd: grant.auxiliaryUsd ?? null } });
}

/** Preflight every selected skill before queue admission; the worker must match these immutable hashes. */
export async function submitCodexSkillOptBatch(engine: BrainEngine, original: CodexSkillOptBatchInput, scope: CodexSkillOptBatchScope, allowance: CodexSkillOptBatchAllowance): Promise<CodexSkillOptBatchJobReceipt> {
  if (!readPrivateCodexConfig() || codexSubscriptionContext())
    throw new SubscriptionAdmissionError('subscription_required');
  if (!isWriteRequestId(allowance.requestId) || original.dryRun || Object.hasOwn(original, 'sharedSkill')) throw new SubscriptionAdmissionError('subscription_invalid');
  const grant = structuredClone(allowance); grant.requestId = grant.requestId.toLowerCase();
  const input = { ...structuredClone(original), skillsDir: resolve(original.skillsDir) };
  const config = await loadConfigWithEngine(engine, loadConfig() ?? { engine: engine.kind });
  if (!config) throw new SubscriptionAdmissionError('subscription_required');
  const source = await resolveSourceWithTier(engine, scope.sourceId);
  const originalScope = { engine, config, remote: false as const, sourceId: source.source_id, dryRun: false,
    logger: { info: console.log, warn: console.warn, error: console.error } };
  const codex = structuredClone({ ...(scope.readRegistry ? { readRegistry: scope.readRegistry } : {}),
    allowedTools: scope.allowedTools, allowedSlugPrefixes: scope.allowedSlugPrefixes });
  const trustedScope = { operationContext: originalScope, codex };
  const canonicalScope = { sourceId: source.source_id, ...codex };
  const reqHash = requestHash(input, canonicalScope, grant);
  const [prior] = await engine.executeRaw<Binding>('SELECT * FROM codex_skillopt_batch_submissions WHERE request_id=$1::uuid', [grant.requestId]);
  if (prior) {
    const job = await new MinionQueue(engine).getJob(Number(prior.job_id));
    if (prior.protocol !== 1 || prior.request_hash !== reqHash || !job || payloadHash(job.data ?? {}) !== prior.data_hash) conflict();
    if (!job) return conflict();
    return { id: Number(job.id), name: 'skillopt', status: job.status };
  }
  const names = collectSkillsWithBenchmarks(input.skillsDir).sort();
  if (names.length > 20) throw new SubscriptionAdmissionError('subscription_invalid');
  const requestRunId = `codex-batch-submit:${grant.requestId}`;
  const entries: Array<{ skill: string; inputHash: string }> = [];
  let sourceIncarnation: string | undefined, boundPolicy: ReturnType<typeof readPrivateCodexConfig>;
  for (const skillName of names) {
    const childData = buildSkillOptJobData({ ...input, skillName, benchmarkPath: join(input.skillsDir, skillName, 'skillopt-benchmark.jsonl') } as SkillOptJobInput);
    const childOpts = { ...await skillOptJobOptions(engine, childData), operationContext: originalScope, codex };
    const prepared = await withCodexSubscription({ engine, runId: requestRunId }, () => prepareCodexSkillOpt(childOpts));
    if (sourceIncarnation !== undefined && sourceIncarnation !== prepared.source.incarnation) conflict();
    sourceIncarnation = prepared.source.incarnation; boundPolicy = prepared.policy;
    entries.push({ skill: skillName, inputHash: digest(prepared.input) });
  }
  const data = commonData(input, input.skillsDir, names, entries, canonicalScope, grant.requestId);
  const dataHash = payloadHash(data);
  const queued = await engine.transaction(async tx => {
    await declareDurablePersistence(tx); await tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    const [saved] = await tx.executeRaw<Binding>('SELECT * FROM codex_skillopt_batch_submissions WHERE request_id=$1::uuid FOR UPDATE', [grant.requestId]);
    if (saved) {
      const job = await new MinionQueue(tx).getJob(Number(saved.job_id));
      if (saved.protocol !== 1 || saved.request_hash !== reqHash || saved.data_hash !== dataHash || !job || payloadHash(job.data ?? {}) !== dataHash) conflict();
      return job!;
    }
    const policy = readPrivateCodexConfig();
    if (!policy || boundPolicy && (policy.model !== boundPolicy.model || policy.bin !== boundPolicy.bin)) conflict();
    if (sourceIncarnation) {
      const [currentSource] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [originalScope.sourceId]);
      if (!currentSource || currentSource.archived || currentSource.incarnation !== sourceIncarnation) conflict();
    }
    const job = await new MinionQueue(tx).add('skillopt', data, { queue: 'default', idempotency_key: `codex-skillopt-batch:${grant.requestId}`,
      max_attempts: 1, max_stalled: 5, remove_on_complete: false, remove_on_fail: false, lock_duration_ms: 900000,
      timeout_ms: Math.max(1, grant.deadline.getTime() - Date.now()) },
    { submissionAuthority: APPLICATION_AUTHORITY, allowProtectedSubmit: true, codexSubscription: { maxAttempts: grant.maxAttempts, maxTurns: grant.maxTurns, deadline: grant.deadline } });
    if (job.coalesced) conflict();
    await tx.executeRaw('INSERT INTO codex_skillopt_batch_submissions(request_id,protocol,request_hash,data_hash,job_id) VALUES($1::uuid,1,$2,$3,$4)',
      [grant.requestId, reqHash, dataHash, job.id]);
    return job;
  });
  return { id: Number(queued.id), name: 'skillopt', status: queued.status };
}

/** Rebuild the worker batch only from its permanent host submission and current job lease. */
export async function runCodexSkillOptBatchJob(engine: BrainEngine, data: Record<string, unknown>, context: import('../minions/types.ts').MinionJobContext) {
  const host = codexSubscriptionContext(); validateCodexOptimizerJob(data);
  if (!host || host.engine !== engine || !context || context.submission_authority?.kind !== 'application' || host.publicationFence?.jobId !== context.id)
    throw new SubscriptionAdmissionError('subscription_required');
  await host.checkAuthority?.();
  const [binding] = await engine.executeRaw<Binding>('SELECT * FROM codex_skillopt_batch_submissions WHERE request_id=$1::uuid', [data.optimizer_request_id]);
  if (!binding || binding.protocol !== 1 || Number(binding.job_id) !== Number(context.id) || binding.data_hash !== payloadHash(data)) conflict();
  const config = await (await import('../config.ts')).loadConfigWithEngine(engine, (await import('../config.ts')).loadConfig() ?? { engine: engine.kind });
  if (!config) throw new SubscriptionAdmissionError('subscription_required');
  const operationContext = { engine, config, remote: false as const, sourceId: data.source_id as string, dryRun: false,
    logger: { info: console.log, warn: console.warn, error: console.error } };
  const codex = { ...(data.read_registry !== undefined ? { readRegistry: data.read_registry as 'codex-discovery-v1' } : {}),
    allowedTools: structuredClone(data.allowed_tools as string[]), allowedSlugPrefixes: structuredClone(data.allowed_slug_prefixes as string[]) };
  const opts = await skillOptJobOptions(engine, data);
  const [grant] = await engine.executeRaw<{ max_attempts: number; max_turns: number }>('SELECT max_attempts,max_turns FROM codex_subscription_runs WHERE run_id=$1', [host.runId]);
  if (!grant) throw new SubscriptionAdmissionError('subscription_required');
  const result = await (await import('./batch.ts')).runBatchAll({ engine, skillsDir: String(data.skills_dir), operationContext, codex,
    codexPerSkill: { maxAttempts: grant.max_attempts, maxTurns: grant.max_turns },
    codexExpectedSkills: structuredClone(data.optimizer_batch_selection as string[]), codexExpectedEntries: structuredClone(data.optimizer_batch_entries as Array<{ skill: string; inputHash: string }>),
    perSkillMaxCostUsd: opts.maxCostUsd, brainWideMaxCostUsd: opts.maxCostUsd, maxCostSource: 'default',
    optimizerModel: String(data.optimizer_model), targetModel: String(data.target_model), judgeModel: String(data.judge_model),
    models: await (await import('./job.ts')).resolveJobModels(engine, data), modelsStrict: data.models_strict === true, reflectMaxTokens: opts.reflectMaxTokens,
    epochs: opts.epochs, batchSize: opts.batchSize, lr: opts.lr, lrSchedule: opts.lrSchedule, split: opts.split,
    dryRun: false, noMutate: opts.noMutate, allowMutateBundled: opts.allowMutateBundled, force: opts.force,
    mode: opts.mode, heldOutPath: opts.heldOutPath, maxRuntimeMin: opts.maxRuntimeMin });
  return { billing: 'subscription', cost_usd: null, remaining_quota: null, ...result };
}
