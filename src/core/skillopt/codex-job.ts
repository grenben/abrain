import { resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { MinionJobContext } from '../minions/types.ts';
import type { EvalAllowance } from '../../eval/longmemeval/codex-allowance-flags.ts';
import { loadConfig, loadConfigWithEngine } from '../config.ts';
import { readPrivateCodexConfig } from '../ai/private-policy.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { MinionQueue } from '../minions/queue.ts';
import { APPLICATION_AUTHORITY } from '../minions/submission-authority.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { isWriteRequestId } from '../persistence/types.ts';
import { digest } from '../persistence/digest.ts';
import { buildSkillOptJobData, skillOptJobOptions, type SkillOptJobInput } from './job.ts';
import { prepareCodexSkillOpt } from './codex-run.ts';
import type { LocalOptimizerScope } from './codex-local-grant.ts';
import { CODEX_OPTIMIZER_JOB_PROTOCOL, validateCodexOptimizerJob } from './codex-job-contract.ts';
const conflict = (): never => { throw new SubscriptionAdmissionError('subscription_identity_conflict'); };
interface Binding { request_id: string; protocol: number; input_hash: string; data_hash: string; job_id: number }
const payloadHash = (data: Record<string, unknown>) => { const { __param_hash, ...value } = data; return digest(value); };

/** Trusted local producer. A repeated UUID cannot create a second job or reset its allowance. */
export async function submitCodexSkillOpt(engine: BrainEngine, input: SkillOptJobInput, scope: LocalOptimizerScope, allowance: EvalAllowance) {
  if (!readPrivateCodexConfig() || codexSubscriptionContext() || scope.operationContext?.engine !== engine || scope.operationContext.remote !== false || !scope.codex)
    throw new SubscriptionAdmissionError('subscription_required');
  if (!isWriteRequestId(allowance.requestId) || input.dryRun) throw new SubscriptionAdmissionError('subscription_invalid');
  const grant = structuredClone(allowance), requestId = grant.requestId.toLowerCase();
  const data = buildSkillOptJobData({ ...structuredClone(input), skillsDir: resolve(input.skillsDir), benchmarkPath: resolve(input.benchmarkPath),
    ...(input.heldOutPath ? { heldOutPath: resolve(input.heldOutPath) } : {}) });
  const original = { ...scope.operationContext }, codex = structuredClone(scope.codex);
  const [prior] = await engine.executeRaw<Binding>('SELECT * FROM codex_skillopt_submissions WHERE request_id=$1::uuid', [requestId]);
  const roots = prior ? await engine.executeRaw<{ run_id: string }>('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1', [`codex-job:${prior.job_id}:%`]) : [];
  if (prior && roots.length !== 1) conflict();
  const runId = roots[0]?.run_id ?? `codex-skillopt-submit:${requestId}`;
  const opts = await skillOptJobOptions(engine, data);
  const prepared = await withCodexSubscription({ engine, runId }, () => prepareCodexSkillOpt({ ...opts, operationContext: original, codex }));
  Object.assign(data, { optimizer_protocol: CODEX_OPTIMIZER_JOB_PROTOCOL, optimizer_request_id: requestId,
    optimizer_input_hash: digest(prepared.input), source_id: original.sourceId, allowed_tools: codex.allowedTools, allowed_slug_prefixes: codex.allowedSlugPrefixes });
  validateCodexOptimizerJob(data);
  const dataHash = payloadHash(data), inputHash = digest({ dataHash, grant: { ...grant, requestId } });
  return engine.transaction(async tx => {
    await declareDurablePersistence(tx);
    await tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    if ((await tx.executeRaw('SELECT run_id FROM codex_subscription_runs WHERE run_id=$1', [`codex-skillopt:${requestId}`])).length) conflict();
    const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [original.sourceId]);
    if (!source || source.archived || source.incarnation !== prepared.source.incarnation) conflict();
    const policy = readPrivateCodexConfig();
    if (!policy || policy.model !== prepared.policy.model || policy.bin !== prepared.policy.bin) conflict();
    const [saved] = await tx.executeRaw<Binding>('SELECT * FROM codex_skillopt_submissions WHERE request_id=$1::uuid FOR UPDATE', [requestId]);
    const queue = new MinionQueue(tx);
    if (saved) {
      const job = await queue.getJob(Number(saved.job_id));
      if (saved.protocol !== 1 || saved.input_hash !== inputHash || saved.data_hash !== dataHash || !job || payloadHash(job.data ?? {}) !== dataHash) conflict();
      return job!;
    }
    const job = await queue.add('skillopt', data, { queue: 'default', idempotency_key: `codex-skillopt:${requestId}`,
      max_attempts: 1, max_stalled: 5, remove_on_complete: false, remove_on_fail: false, lock_duration_ms: 900000,
      timeout_ms: Math.max(1, Math.min(input.maxRuntimeMin * 60000, grant.deadline.getTime() - Date.now())) },
    { submissionAuthority: APPLICATION_AUTHORITY, allowProtectedSubmit: true, codexSubscription: { maxAttempts: grant.maxAttempts, maxTurns: grant.maxTurns, deadline: grant.deadline } });
    if (job.coalesced) conflict();
    await tx.executeRaw('INSERT INTO codex_skillopt_submissions(request_id,protocol,input_hash,data_hash,job_id) VALUES($1::uuid,1,$2,$3,$4)',
      [requestId, inputHash, dataHash, job.id]);
    return job;
  });
}

/** Worker scope is reconstructed only from the durable, application-authorized submission. */
export async function codexOptimizerJobScope(engine: BrainEngine, data: Record<string, unknown>, context?: MinionJobContext) {
  const host = codexSubscriptionContext();
  if (!readPrivateCodexConfig() || !host || host.engine !== engine || !context || context.submission_authority?.kind !== 'application' ||
      host.publicationFence?.jobId !== context.id || !host.checkAuthority || !host.checkAuthorityInTransaction)
    throw new SubscriptionAdmissionError('subscription_required');
  validateCodexOptimizerJob(data); await host.checkAuthority();
  const [binding] = await engine.executeRaw<Binding>('SELECT * FROM codex_skillopt_submissions WHERE request_id=$1::uuid', [data.optimizer_request_id]);
  if (!binding || binding.protocol !== 1 || Number(binding.job_id) !== Number(context.id) || binding.data_hash !== payloadHash(data)) conflict();
  const config = await loadConfigWithEngine(engine, loadConfig() ?? { engine: engine.kind });
  if (!config) throw new SubscriptionAdmissionError('subscription_required');
  return { operationContext: { engine, config, remote: false, sourceId: data.source_id as string, dryRun: false,
    logger: { info: console.log, warn: console.warn, error: console.error } },
    codex: { allowedTools: structuredClone(data.allowed_tools as string[]), allowedSlugPrefixes: structuredClone(data.allowed_slug_prefixes as string[]) },
    codexExpectedInputHash: data.optimizer_input_hash as string };
}
