import { CodexProposalError, isRecord, type CodexUsage } from './codex-contract.ts';

/** Lifecycle JSONL is a transport protocol, never application JSON. */
export function parseCodexLifecycle(stdout: string): { text: string; usage: CodexUsage | null } {
  let thread = false;
  let started = false;
  let completed = false;
  let finalText: string | undefined;
  let usage: CodexUsage | null = null;
  const fail = (): never => { throw new CodexProposalError('malformed_lifecycle'); };
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { return fail(); }
    if (!isRecord(event) || typeof event.type !== 'string' || completed) return fail();
    switch (event.type) {
      case 'thread.started':
        if (thread || started || typeof event.thread_id !== 'string') return fail();
        thread = true;
        break;
      case 'turn.started':
        if (!thread || started) return fail();
        started = true;
        break;
      case 'error': case 'turn.failed': throw new CodexProposalError('provider_failure');
      case 'item.started': case 'item.updated': case 'item.completed': {
        if (!started || !isRecord(event.item)) return fail();
        const item = event.item;
        if (item.type === 'refusal' || item.refusal === true) throw new CodexProposalError('refusal');
        if (item.type !== 'agent_message' && item.type !== 'reasoning') throw new CodexProposalError('native_action');
        if (item.type === 'agent_message' && event.type === 'item.completed' && item.phase !== 'commentary') {
          if (finalText !== undefined || typeof item.text !== 'string' || (item.phase !== undefined && item.phase !== 'final_answer')) return fail();
          finalText = item.text;
        }
        break;
      }
      case 'turn.completed': {
        if (!started || finalText === undefined) return fail();
        completed = true;
        if (event.usage !== undefined && event.usage !== null) {
          if (!isRecord(event.usage)) return fail();
          const u = event.usage;
          if (!['input_tokens', 'cached_input_tokens', 'output_tokens'].every(k => Number.isSafeInteger(u[k]) && (u[k] as number) >= 0)) return fail();
          if ((u.cached_input_tokens as number) > (u.input_tokens as number)) return fail();
          usage = { inputTokens: u.input_tokens as number, cachedInputTokens: u.cached_input_tokens as number, outputTokens: u.output_tokens as number };
        }
        break;
      }
      default: return fail();
    }
  }
  if (!completed || finalText === undefined) throw new CodexProposalError('missing_completion');
  return { text: finalText, usage };
}
