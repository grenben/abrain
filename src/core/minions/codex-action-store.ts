import { declarePersistenceProtocol } from '../persistence/protocol.ts';
import type { RetainedCodexWrite } from '../persistence/codex-action-guard.ts';
import { randomUUIDv7 } from 'bun';
import type { BrainEngine } from '../engine.ts';
import type { ChatResult } from '../ai/gateway.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { authorityDigest } from './submission-authority.ts';
import { persistMessage, loadPriorMessages, type PersistedMessage } from './handlers/subagent-persistence.ts';
import { actionError, CODEX_READ_PROTOCOL, CODEX_ACTION_LIMITS, type CodexAction } from './codex-action-contract.ts';
import type { MinionJobContext } from './types.ts';

export interface CodexActionRow {
  message_idx: number; ordinal: number; tool_use_id: string; gbrain_tool_use_id: string;
  tool_name: string; input: { slug: string; content?: string }; host_binding?: RetainedCodexWrite | null; status: 'pending' | 'complete' | 'failed'; output: unknown; error: string | null;
}
/** Every history mutation locks the live claim, and also binds this handler's data to that claim. */
export async function withActionFence<T>(engine: BrainEngine, ctx: MinionJobContext, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
  const scope = codexSubscriptionContext();
  if (!scope || scope.engine !== engine || !scope.runId.startsWith(`codex-job:${ctx.id}:v1:`) || !scope.checkAuthorityInTransaction) actionError('job_binding_required');
  return engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    ctx.signal?.throwIfAborted(); ctx.shutdownSignal?.throwIfAborted();
    await scope!.checkAuthorityInTransaction!(tx);
    const [job] = await tx.executeRaw<{ data: unknown }>('SELECT data FROM minion_jobs WHERE id=$1', [ctx.id]);
    if (!job || authorityDigest(job.data) !== authorityDigest(ctx.data)) actionError('identity_conflict');
    // Job first, then source: freeze the incarnation through commit and recheck any change before the lock.
    await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR SHARE', [ctx.data.source_id]);
    await scope!.checkAuthorityInTransaction!(tx);
    return run(tx);
  });
}
const historyVersion = (ctx: MinionJobContext) => ctx.data.action_protocol === CODEX_READ_PROTOCOL ? 3 : 4;
async function message(tx: BrainEngine, ctx: MinionJobContext, msg: PersistedMessage) {
  await persistMessage(tx, ctx.id, msg);
  await tx.executeRaw('UPDATE subagent_messages SET schema_version=$4,provider_id=$3 WHERE job_id=$1 AND message_idx=$2', [ctx.id, msg.message_idx, ctx.data.action_protocol, historyVersion(ctx)]);
}
function envelope(index: number, role: 'user' | 'assistant', blocks: PersistedMessage['content_blocks'], answer?: ChatResult): PersistedMessage {
  return { message_idx: index, role, content_blocks: blocks, model: answer?.model ?? null,
    tokens_in: answer?.usage.input_tokens ?? null, tokens_out: answer?.usage.output_tokens ?? null,
    tokens_cache_read: answer?.usage.cache_read_tokens ?? null, tokens_cache_create: answer?.usage.cache_creation_tokens ?? null };
}
const equal = (a: unknown, b: unknown) => authorityDigest(a) === authorityDigest(b);

export async function loadCodexActions(engine: BrainEngine, ctx: MinionJobContext, prompt: string) {
  return withActionFence(engine, ctx, async tx => {
    const versions = await tx.executeRaw<{ schema_version: number; provider_id: string }>(
      'SELECT schema_version,provider_id FROM subagent_messages WHERE job_id=$1 UNION ALL SELECT schema_version,provider_id FROM subagent_tool_executions WHERE job_id=$1 LIMIT 50', [ctx.id]);
    if (versions.length > CODEX_ACTION_LIMITS.turns * 3 + 1 || versions.some(v => v.schema_version !== historyVersion(ctx) || v.provider_id !== ctx.data.action_protocol)) actionError('history_protocol');
    if (!versions.length) await message(tx, ctx, envelope(0, 'user', [{ type: 'text', text: prompt }]));
    const messages = await loadPriorMessages(tx, ctx.id);
    const rows = await tx.executeRaw<CodexActionRow>('SELECT message_idx,ordinal,tool_use_id,gbrain_tool_use_id::text,tool_name,input,status,output,error,host_binding FROM subagent_tool_executions WHERE job_id=$1 ORDER BY message_idx', [ctx.id]);
    if (rows.some(r => r.tool_name !== 'brain_get_page' && !(historyVersion(ctx) === 4 && r.tool_name === 'brain_put_page'))) actionError('needs_reconciliation');
    if (Buffer.byteLength(JSON.stringify(messages)) > CODEX_ACTION_LIMITS.history || !equal(messages[0]?.content_blocks, [{ type: 'text', text: prompt }])) actionError('history_limit_or_conflict');
    for (const [i, msg] of messages.entries()) {
      if (msg.message_idx !== i || msg.role !== (i % 2 ? 'assistant' : 'user') || msg.content_blocks.length !== 1) actionError('history_conflict');
      const block = msg.content_blocks[0]!;
      if (i === 0) continue;
      if (i % 2) {
        if (block.type === 'text') { if (i !== messages.length - 1 || typeof block.text !== 'string' || !block.text.trim()) actionError('history_conflict'); }
        else if (block.type === 'tool_use') {
          const row = rows.find(r => r.message_idx === i);
          if (!row || row.ordinal !== 0 || !row.gbrain_tool_use_id || row.tool_use_id !== row.gbrain_tool_use_id ||
              block.id !== row.gbrain_tool_use_id || block.name !== row.tool_name || !equal(block.input, row.input)) actionError('identity_conflict');
          if (row!.status === 'pending' && i !== messages.length - 1) actionError('unsettled_history');
        } else actionError('history_conflict');
      } else {
        const row = rows.find(r => r.message_idx === i - 1);
        if (!row || row.status === 'pending' || !equal(block, resultBlock(row))) actionError('history_conflict');
      }
    }
    if (rows.some(r => messages[r.message_idx]?.content_blocks[0]?.type !== 'tool_use')) actionError('needs_reconciliation');
    return { messages, rows };
  });
}
/** Assistant proposal and pending execution are one transaction, before any tool executes. */
export async function retainCodexAction(engine: BrainEngine, ctx: MinionJobContext, index: number, action: CodexAction, answer: ChatResult): Promise<void> {
  await withActionFence(engine, ctx, async tx => {
    const [prior] = await tx.executeRaw<{ content_blocks: unknown }>('SELECT content_blocks FROM subagent_messages WHERE job_id=$1 AND message_idx=$2', [ctx.id, index]);
    let blocks: PersistedMessage['content_blocks'];
    if (action.kind === 'final') blocks = [{ type: 'text', text: action.answer }];
    else {
      const candidate = randomUUIDv7();
      await tx.executeRaw(`INSERT INTO subagent_tool_executions
        (job_id,message_idx,ordinal,tool_use_id,gbrain_tool_use_id,tool_name,input,status,schema_version,provider_id)
        VALUES ($1,$2,0,$3::text,$3::text::uuid,$4,$5::text::jsonb,'pending',$7,$6) ON CONFLICT (job_id,message_idx,ordinal) DO NOTHING`,
      [ctx.id, index, candidate, action.name, JSON.stringify(action.arguments), ctx.data.action_protocol, historyVersion(ctx)]);
      const [row] = await tx.executeRaw<CodexActionRow>('SELECT tool_name,input,gbrain_tool_use_id::text FROM subagent_tool_executions WHERE job_id=$1 AND message_idx=$2 AND ordinal=0', [ctx.id, index]);
      if (!row?.gbrain_tool_use_id || row.tool_name !== action.name || !equal(row.input, action.arguments)) actionError('identity_conflict');
      blocks = [{ type: 'tool_use', id: row.gbrain_tool_use_id, name: action.name, input: action.arguments }];
    }
    if (prior) { if (!equal(prior.content_blocks, blocks)) actionError('identity_conflict'); return; }
    const [last] = await tx.executeRaw<{ idx: number }>('SELECT max(message_idx) AS idx FROM subagent_messages WHERE job_id=$1', [ctx.id]);
    if (index !== Number(last?.idx) + 1 || index % 2 !== 1) actionError('history_conflict');
    await message(tx, ctx, envelope(index, 'assistant', blocks, answer));
    // Atomic with first retention: retries cannot double-count the measured usage.
    await tx.executeRaw('UPDATE minion_jobs SET tokens_input=tokens_input+$2,tokens_output=tokens_output+$3,tokens_cache_read=tokens_cache_read+$4 WHERE id=$1',
      [ctx.id, answer.usage.input_tokens, answer.usage.output_tokens, answer.usage.cache_read_tokens]);
  });
}
function resultBlock(row: CodexActionRow) {
  return { type: 'tool_result', tool_use_id: row.gbrain_tool_use_id, content: row.output, is_error: row.status === 'failed' };
}
/** Bounded tool output and history commit together; completed reads are never repeated. */
export async function settleCodexAction(engine: BrainEngine, ctx: MinionJobContext, expected: CodexActionRow, output: unknown, failed = false): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(output)) > CODEX_ACTION_LIMITS.result) actionError('result_limit');
  await withActionFence(engine, ctx, async tx => {
    const [row] = await tx.executeRaw<CodexActionRow>('SELECT * FROM subagent_tool_executions WHERE job_id=$1 AND message_idx=$2 AND ordinal=0 FOR UPDATE', [ctx.id, expected.message_idx]);
    if (!row || row.gbrain_tool_use_id !== expected.gbrain_tool_use_id || row.tool_name !== expected.tool_name || !equal(row.input, expected.input)) actionError('identity_conflict');
    if (row.status === 'pending') {
      row.status = failed ? 'failed' : 'complete'; row.output = output;
      await tx.executeRaw('UPDATE subagent_tool_executions SET status=$2,output=$3::text::jsonb,error=$4,ended_at=now() WHERE job_id=$1 AND message_idx=$5 AND ordinal=0',
        [ctx.id, row.status, JSON.stringify(output), failed ? (row.tool_name === 'brain_put_page' ? 'codex_action_write_failed' : 'codex_action_read_failed') : null, row.message_idx]);
    } else if (!equal(row.output, output) || (row.status === 'failed') !== failed) actionError('identity_conflict');
    const blocks = [resultBlock(row)];
    const [prior] = await tx.executeRaw<{ content_blocks: unknown }>('SELECT content_blocks FROM subagent_messages WHERE job_id=$1 AND message_idx=$2', [ctx.id, row.message_idx + 1]);
    if (prior && !equal(prior.content_blocks, blocks)) actionError('identity_conflict');
    if (!prior) await message(tx, ctx, envelope(row.message_idx + 1, 'user', blocks));
  });
}
