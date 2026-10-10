import type { BrainEngine } from '../engine.ts';
import type { MinionJobContext } from './types.ts';
import type { CodexReadJob } from './codex-action-contract.ts';
import { actionError, CODEX_ACTION_LIMITS } from './codex-action-contract.ts';
import { withActionFence, type CodexActionRow } from './codex-action-store.ts';
import { authorityDigest } from './submission-authority.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { retainToolWriteRequestId } from './tool-write-identity.ts';
import { preparePageAdmission } from '../persistence/page-mutations.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../persistence/identity.ts';
import { admitWrite, getWriteRequest, intentDigest } from '../persistence/journal.ts';
import { waitForWrite } from '../persistence/service.ts';
import type { RetainedCodexWrite } from '../persistence/codex-action-guard.ts';
import type { WriteRequest } from '../persistence/model.ts';

/** Freeze the host authority and normalized admission before any write is submitted. */
export async function retainCodexWrite(engine: BrainEngine, ctx: MinionJobContext, data: CodexReadJob, row: CodexActionRow): Promise<RetainedCodexWrite> {
  if (row.host_binding) return row.host_binding;
  if (typeof row.input.slug !== 'string' || typeof row.input.content !== 'string' || Buffer.byteLength(row.input.content) > CODEX_ACTION_LIMITS.content) actionError('invalid_proposal');
  const snapshot = await engine.readPageSnapshot(row.input.slug!, { sourceId: data.source_id, includeDeleted: true });
  if (snapshot) {
    const [read] = await engine.executeRaw<{ output: { revision?: string; slug?: string; source_id?: string } }>(
      `SELECT output FROM subagent_tool_executions WHERE job_id=$1 AND message_idx<$2 AND tool_name='brain_get_page' AND status='complete' AND output->>'slug'=$3 ORDER BY message_idx DESC LIMIT 1`,
      [ctx.id, row.message_idx, row.input.slug!]);
    if (!read || read.output.source_id !== data.source_id || read.output.revision !== snapshot.revision || snapshot.page.deleted_at) actionError('read_revision_required');
  }
  const params: Record<string, unknown> = { ...row.input, source_id: data.source_id, ...(snapshot ? { expected_revision: snapshot.revision } : {}) };
  retainToolWriteRequestId(params, ctx.id, row.message_idx, 0, row.gbrain_tool_use_id, row.tool_name);
  const writer = await registerLocalWriter(engine, 'stdio');
  const prepared = await withVerifiedLocalRegistration(engine, writer, () => preparePageAdmission({ engine, config: { engine: engine.kind },
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: data.source_id,
    viaSubagent: true, subagentId: ctx.id, allowedSlugPrefixes: data.allowed_slug_prefixes }, { operation: 'put_page', params }));
  // A receipt without its pre-effect host binding is ambiguous; never adopt it.
  if (!prepared.admission) actionError('needs_reconciliation');
  return withActionFence(engine, ctx, async tx => {
    const [job] = await tx.executeRaw<{ lock_token: string; data: unknown; submission_authority: unknown }>('SELECT lock_token,data,submission_authority FROM minion_jobs WHERE id=$1', [ctx.id]);
    const binding = { jobId: ctx.id, messageIdx: row.message_idx, canonicalId: row.gbrain_tool_use_id, lockToken: job!.lock_token,
      jobDigest: authorityDigest({ data: job!.data, authority: job!.submission_authority }), runId: codexSubscriptionContext()!.runId, expectedRevision: snapshot?.revision ?? null };
    const admission = { ...prepared.admission!, protocolVersion: 3 as const,
      intent: { ...prepared.admission!.intent, source_kind: 'minion:codex', ingested_via: 'minion:codex', codex_action: binding } };
    const retained = { binding, admission };
    const [current] = await tx.executeRaw<CodexActionRow>('SELECT * FROM subagent_tool_executions WHERE job_id=$1 AND message_idx=$2 AND ordinal=0 FOR UPDATE', [ctx.id, row.message_idx]);
    if (!current || current.status !== 'pending' || current.gbrain_tool_use_id !== row.gbrain_tool_use_id || authorityDigest(current.input) !== authorityDigest(row.input)) actionError('identity_conflict');
    if (current.host_binding) {
      if (authorityDigest(current.host_binding) !== authorityDigest(retained)) actionError('identity_conflict');
      return current.host_binding;
    }
    await tx.executeRaw('UPDATE subagent_tool_executions SET host_binding=$3::text::jsonb WHERE job_id=$1 AND message_idx=$2 AND ordinal=0', [ctx.id, row.message_idx, JSON.stringify(retained)]);
    return retained;
  });
}

function checkReceipt(row: CodexActionRow, retained: RetainedCodexWrite, receipt: WriteRequest) {
  const a = retained.admission;
  if (retained.binding.canonicalId !== row.gbrain_tool_use_id || a.slug !== row.input.slug! || a.callerIntent.content !== row.input.content ||
      receipt.protocol_version !== 3 || receipt.digest !== intentDigest(a) || authorityDigest(receipt.intent) !== authorityDigest(a.intent) ||
      authorityDigest(receipt.authority) !== authorityDigest(a.authority)) return actionError('needs_reconciliation');
}

/** Recover the same receipt before another model call. Unknown outcomes keep the action pending. */
export async function executeCodexWrite(engine: BrainEngine, ctx: MinionJobContext, data: CodexReadJob, row: CodexActionRow) {
  const retained = await retainCodexWrite(engine, ctx, data, row), a = retained.admission;
  await withActionFence(engine, ctx, async () => {});
  let receipt = await getWriteRequest(engine, a.principal, a.requestId!);
  if (!receipt) receipt = await admitWrite(engine, a);
  checkReceipt(row, retained, receipt);
  if (['queued', 'running', 'recovering'].includes(receipt.state)) {
    const remaining = ctx.deadlineAtMs == null ? 5000 : Math.max(0, Math.min(5000, ctx.deadlineAtMs - Date.now()));
    receipt = await waitForWrite(engine, receipt, { engine: engine.kind }, remaining);
  }
  checkReceipt(row, retained, receipt);
  if (receipt.state === 'committed') return { output: { state: 'committed', request_id: receipt.request_id, slug: a.slug, changed: changed(receipt),
    ...(receipt.outcome?.quarantined ? { error: 'codex_action_write_quarantined' } : {}) }, failed: !!receipt.outcome?.quarantined };
  if (['failed', 'conflict', 'cancelled'].includes(receipt.state) && !receipt.publication_started && !receipt.recovery) return { output: { error: 'codex_action_write_failed', state: receipt.state, request_id: receipt.request_id }, failed: true };
  return actionError('needs_reconciliation');
}

const changed = (receipt: WriteRequest) => receipt.state === 'committed' && receipt.outcome?.status === 'created_or_updated' && receipt.outcome?.noop !== true;

/** Completion is based on durable receipts, not a model claim or a successful tool dispatch. */
export async function codexWriteCounts(engine: BrainEngine, rows: CodexActionRow[], required: boolean) {
  const writes = rows.filter(r => r.tool_name === 'brain_put_page');
  let committed = 0;
  for (const row of writes) {
    const retained = row.host_binding;
    if (!retained) actionError('needs_reconciliation');
    const receipt = await getWriteRequest(engine, retained!.admission.principal, retained!.admission.requestId!);
    if (!receipt) actionError('needs_reconciliation');
    checkReceipt(row, retained!, receipt!);
    if (receipt!.state === 'committed') { if (changed(receipt!) && !receipt!.outcome?.quarantined) committed++; }
    else if (row.status !== 'failed') actionError('needs_reconciliation');
  }
  if (required && !committed) actionError('required_write_missing');
  return { pages_attempted: writes.length, pages_written: committed, pages_failed: writes.filter(r => r.status === 'failed').length };
}
