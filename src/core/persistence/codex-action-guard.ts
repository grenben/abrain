import type { SqlEngine, WriteRequest } from './model.ts';
import type { WriteAdmission } from './journal.ts';
import { digest as authorityDigest } from './digest.ts';
import { OperationError } from '../ops/contract.ts';

export interface CodexWriteBinding {
  jobId: number; messageIdx: number; canonicalId: string; lockToken: string;
  jobDigest: string; runId: string; expectedRevision: string | null;
}
export interface RetainedCodexWrite { binding: CodexWriteBinding; admission: WriteAdmission }
const refuse = (): never => { throw new OperationError('permission_denied', 'The retained Codex write authority is no longer valid.', 'Reconcile the original action and its receipt before submitting new work.'); };

/** Protocol 3 is exclusively a retained host action. Older consumers refuse it before effects.
 * Lock order: brain/worktree, job, source, writer, request, page. */
export async function authorizeCodexWrite(engine: SqlEngine, input: WriteAdmission, lock: boolean): Promise<void> {
  if (input.protocolVersion === 4) return (await import('../think/publication-guard.ts')).authorizeThinkWrite(engine, input, lock);
  if (input.intent.codex_think_plan !== undefined) refuse();
  if (input.protocolVersion !== 3) {
    if (input.intent.codex_action !== undefined) refuse();
    return;
  }
  const b = input.intent.codex_action as CodexWriteBinding | undefined;
  if (!b || input.operation !== 'put_page' || !input.authority.remote || input.authority.principal.kind !== 'local_stdio') refuse();
  const [job] = await engine.executeRaw<{ data: Record<string, unknown>; submission_authority: { kind?: string } }>(
    `SELECT data,submission_authority FROM minion_jobs WHERE id=$1 AND status='active' AND lock_token=$2 AND lock_until>now()${lock ? ' FOR SHARE' : ''}`, [b!.jobId, b!.lockToken]);
  if (!job || job.submission_authority?.kind !== 'application' || job.data.action_protocol !== 'codex-host-actions-v1' ||
      authorityDigest({ data: job.data, authority: job.submission_authority }) !== b!.jobDigest) refuse();
  const [run] = await engine.executeRaw('SELECT run_id FROM codex_subscription_runs WHERE run_id=$1 AND deadline>now()', [b!.runId]);
  const [ledger] = await engine.executeRaw<{ host_binding: RetainedCodexWrite; input: unknown; status: string }>(
    'SELECT host_binding,input,status FROM subagent_tool_executions WHERE job_id=$1 AND message_idx=$2 AND ordinal=0 AND gbrain_tool_use_id=$3::uuid AND tool_name=$4',
    [b!.jobId, b!.messageIdx, b!.canonicalId, 'brain_put_page']);
  if (!run || !ledger || ledger.status !== 'pending' || !ledger.host_binding ||
      authorityDigest(ledger.input) !== authorityDigest({ slug: input.callerIntent.slug, content: input.callerIntent.content }) ||
      authorityDigest(ledger.host_binding.binding) !== authorityDigest(b) ||
      authorityDigest(ledger.host_binding.admission) !== authorityDigest(input)) refuse();
}

/** Use the identical admission retained before effects; never reconstruct authority from model text. */
export async function authorizeCodexRequest(engine: SqlEngine, row: WriteRequest, lock: boolean): Promise<void> {
  if (row.protocol_version === 4) return (await import('../think/publication-guard.ts')).authorizeThinkRequest(engine, row, lock);
  if (row.intent?.codex_think_plan !== undefined) refuse();
  if (row.protocol_version !== 3) { if (row.intent?.codex_action !== undefined) refuse(); return; }
  const b = row.intent?.codex_action as CodexWriteBinding | undefined;
  if (!b) refuse();
  const [ledger] = await engine.executeRaw<{ host_binding: RetainedCodexWrite }>(
    'SELECT host_binding FROM subagent_tool_executions WHERE job_id=$1 AND message_idx=$2 AND ordinal=0', [b!.jobId, b!.messageIdx]);
  const a = ledger?.host_binding?.admission;
  if (!a || a.requestId !== row.request_id || a.sourceId !== row.source_id || a.sourceIncarnation !== row.source_incarnation ||
      a.slug !== row.slug || a.operation !== row.operation || a.principal.kind !== row.principal_kind || a.principal.id !== row.principal_id ||
      authorityDigest(a.intent) !== authorityDigest(row.intent) || authorityDigest(a.authority) !== authorityDigest(row.authority)) refuse();
  if (['committed', 'failed', 'conflict', 'cancelled'].includes(row.state)) return;
  await authorizeCodexWrite(engine, a!, lock);
}
