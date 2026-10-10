import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { digest, jsonBytes } from '../persistence/digest.ts';
import { readPrivateCodexConfig } from '../ai/private-policy.ts';
import { MinionQueue } from './queue.ts';
import { parseSubmissionAuthority } from './submission-authority.ts';
import { jobSpendAuthorization } from './spend-authorization.ts';
import { jobMayGenerate, preflightSubscriptionJob } from './subscription-jobs.ts';
import { jobUpgradeSnapshot, lockJobUpgrade, upgradeError, upgradeHash, upgradeIdentity } from './codex-upgrade-snapshot.ts';

export interface UpgradeSubmission {
  version: 1; job_id: number; data: Record<string, unknown>;
  max_attempts: number; max_turns: number; deadline: string; max_usd?: number;
}
export function validateUpgradeSubmission(value: unknown): UpgradeSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return upgradeError('invalid_submission');
  const s = value as UpgradeSubmission;
  if (Object.keys(s).some(k => !['version','job_id','data','max_attempts','max_turns','deadline','max_usd'].includes(k)) ||
      s.version !== 1 || !Number.isSafeInteger(s.job_id) || s.job_id <= 0 || s.job_id > 2147483647 || !s.data || typeof s.data !== 'object' || Array.isArray(s.data) ||
      jsonBytes(s) > 65536 || ![s.max_attempts,s.max_turns].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 1000) || s.max_turns > s.max_attempts ||
      typeof s.deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s.deadline) || !Number.isFinite(Date.parse(s.deadline)) ||
      new Date(s.deadline).toISOString().replace('.000Z','Z') !== s.deadline.replace('.000Z','Z') ||
      (s.max_usd !== undefined && (!Number.isFinite(s.max_usd) || s.max_usd <= 0))) return upgradeError('invalid_submission');
  return structuredClone(s);
}
async function replacementPlan(engine: BrainEngine, submission: UpgradeSubmission) {
  const { plan, rows: [old] } = await jobUpgradeSnapshot(engine, [submission.job_id]);
  const policy = readPrivateCodexConfig();
  if (!policy) return upgradeError('private_configuration_required');
  if (plan.parked.length !== 1 || plan.parked[0]!.replacement_job_id !== null) upgradeError('park_before_resubmit');
  const [parking] = await engine.executeRaw<{ plan: { ids: number[]; source_hash: string; brain_id: string }; state: string }>('SELECT plan,state FROM codex_upgrade_receipts WHERE id=$1::uuid', [plan.parked[0]!.receipt_id]);
  if (!parking || parking.state !== 'applied' || parking.plan.brain_id !== plan.brain_id ||
      (await jobUpgradeSnapshot(engine, parking.plan.ids)).plan.source_hash !== parking.plan.source_hash) upgradeError('source_incarnation_changed');
  // Parent/child graphs require an explicit new workflow, never implicit rewiring.
  if (old!.parent_job_id !== null || plan.dependencies.length) upgradeError('graph_requires_new_workflow');
  if (old!.attempts_made !== 0 || old!.attempts_started !== 0 || old!.started_at !== null || old!.lock_token !== null || old!.result !== null || old!.error_text !== null) upgradeError('previous_execution_requires_reconciliation');
  if (old!.submission_authority !== null && parseSubmissionAuthority(old!.submission_authority)?.kind !== 'application') upgradeError('remote_authority_requires_new_review');
  const [history] = await engine.executeRaw<{ exists: boolean }>(`SELECT (
    EXISTS(SELECT 1 FROM subagent_tool_executions WHERE job_id=$1) OR EXISTS(SELECT 1 FROM subagent_messages WHERE job_id=$1)
    OR EXISTS(SELECT 1 FROM codex_subscription_runs WHERE run_id LIKE 'codex-job:' || $1::text || ':%')
  ) AS exists`, [submission.job_id]);
  if (history?.exists) upgradeError('retained_execution_requires_reconciliation');
  const oldSource = old!.data?.source_id ?? old!.data?.sourceId, newSource = submission.data.source_id ?? submission.data.sourceId;
  if (typeof oldSource !== 'string' || oldSource !== newSource ||
      (old!.data?.source_id !== undefined && old!.data?.sourceId !== undefined && old!.data.source_id !== old!.data.sourceId) ||
      (submission.data.source_id !== undefined && submission.data.sourceId !== undefined && submission.data.source_id !== submission.data.sourceId)) upgradeError('explicit_same_source_required');
  if (!jobMayGenerate(old!.name, submission.data)) upgradeError('unsupported_replacement');
  await preflightSubscriptionJob(engine, old!.name, submission.data);
  const body = { version: 1, kind: 'jobs', operation: 'resubmit', brain_id: plan.brain_id, job_id: submission.job_id,
    parked_receipt: plan.parked[0]!.receipt_id, name: old!.name, snapshot_hash: plan.plan_hash,
    submission_hash: digest(submission), data_hash: digest(submission.data), policy_hash: digest(policy),
    allowance: { max_attempts: submission.max_attempts, max_turns: submission.max_turns, deadline: submission.deadline, max_usd: submission.max_usd ?? null },
    protocol: ['codex-host-read-v1','codex-host-actions-v1'].includes(submission.data.action_protocol as string) ? submission.data.action_protocol : 'bounded-job',
    execution: { queue: 'default', max_attempts: 1, delayed: false }, inference: 'none', coverage_complete: false };
  return { ...body, plan_hash: digest(body) };
}
export async function previewUpgradeSubmission(engine: BrainEngine, input: unknown) {
  return replacementPlan(engine, validateUpgradeSubmission(input));
}
/** New payload, grant, queue identity and receipt commit together; original job stays fenced. */
export async function resubmitUpgradeJob(engine: BrainEngine, input: unknown, expected: string) {
  upgradeHash(expected); const s = validateUpgradeSubmission(input);
  return engine.transaction(async tx => {
    await lockJobUpgrade(tx);
    const [prior] = await tx.executeRaw<{ id: string; plan: Awaited<ReturnType<typeof replacementPlan>>; receipt: { replacement_job_id: number } }>(
      "SELECT id,plan,receipt FROM codex_upgrade_receipts WHERE kind='jobs' AND plan_hash=$1 AND plan->>'operation'='resubmit' ORDER BY sequence DESC LIMIT 1", [expected]);
    if (prior) {
      if (prior.plan.submission_hash !== digest(s) || prior.plan.brain_id !== await upgradeIdentity(tx)) upgradeError('submission_changed');
      const [current] = await tx.executeRaw<{ name: string; data: Record<string, unknown>; submission_authority: unknown }>('SELECT j.name,j.data,j.submission_authority FROM minion_jobs j JOIN codex_parked_jobs p ON p.replacement_job_id=j.id WHERE p.job_id=$1 AND j.id=$2', [s.job_id,prior.receipt.replacement_job_id]);
      if (!current || current.name !== prior.plan.name || digest(current.data) !== prior.plan.data_hash || parseSubmissionAuthority(current.submission_authority)?.kind !== 'application') upgradeError('replacement_changed');
      return { ...prior, state: 'applied' };
    }
    const plan = await replacementPlan(tx, s);
    if (plan.plan_hash !== expected) upgradeError('preview_changed');
    const id = randomUUID(), queue = new MinionQueue(tx);
    const spendAuthorization = s.max_usd === undefined ? undefined : jobSpendAuthorization(
      { consented_effects: ['paid'], cap_usd: s.max_usd, cap_source: 'user', via: 'max_usd' }, { command: 'private-codex jobs resubmit' });
    const next = await queue.add(plan.name, s.data, { idempotency_key: `codex-upgrade:${id}`, coalesce_params: false, max_attempts: 1 }, {
      allowProtectedSubmit: true, codexSubscription: { maxAttempts: s.max_attempts, maxTurns: s.max_turns, deadline: new Date(s.deadline) }, spendAuthorization });
    const receipt = { replacement_job_id: next.id };
    await tx.executeRaw("INSERT INTO codex_upgrade_receipts(id,kind,plan_hash,plan,state,receipt) VALUES($1::uuid,'jobs',$2,$3::text::jsonb,'applied',$4::text::jsonb)", [id,expected,JSON.stringify(plan),JSON.stringify(receipt)]);
    await tx.executeRaw('UPDATE codex_parked_jobs SET replacement_job_id=$2 WHERE job_id=$1', [s.job_id,next.id]);
    return { id, plan, receipt, state: 'applied' };
  });
}
