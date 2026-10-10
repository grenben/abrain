import { chat, type ChatOpts } from './gateway.ts';
import { CodexProposalError } from './providers/codex-contract.ts';
import { digest } from '../persistence/digest.ts';
import { sanitizeSynopsis } from '../embedding-context.ts';

import { CODEX_SYNOPSIS_VERSION } from './codex-versions.ts';

/** The chunk is the authoritative source; surrounding context may orient but not replace it. */
export async function codexSynopsis(opts: ChatOpts, chunk: string) {
  // The newer synopsis prompt has two text blocks for provider caching. Codex
  // receives their same newline-joined text; non-text blocks remain forbidden.
  const messages = opts.messages.map(message => ({ ...message, content: typeof message.content === 'string'
    ? message.content
    : message.content.map(block => {
      if (block.type !== 'text') throw new CodexProposalError('invalid_input');
      return block.text;
    }).join('\n') }));
  if (!chunk.trim() || Buffer.byteLength(chunk) > 65536 || Buffer.byteLength(JSON.stringify([opts.system, messages])) > 180000 ||
    opts.maxTokens !== undefined && (!Number.isSafeInteger(opts.maxTokens) || opts.maxTokens < 16 || opts.maxTokens > 8192)) throw new CodexProposalError('invalid_input');
  const evidenceHash = digest({ version: CODEX_SYNOPSIS_VERSION, system: opts.system, messages, chunk });
  const result = await chat({ ...opts, messages, allowFallback: false, timeoutMs: 120000, responseSchema: { name: CODEX_SYNOPSIS_VERSION, schema: {
    type: 'object', properties: {
      evidence_hash: { type: 'string', enum: [evidenceHash] },
      synopsis: { type: 'string', minLength: 1, maxLength: 300 },
      source_quote: { type: 'string', minLength: 1, maxLength: 2000,
        description: 'Exact contiguous quotation from CHUNK supporting the synopsis.' },
    }, required: ['evidence_hash', 'synopsis', 'source_quote'], additionalProperties: false,
  }, validateCodexProposal: text => {
    const value = JSON.parse(text) as { synopsis: string; source_quote: string };
    if (!value.source_quote.trim() || !chunk.includes(value.source_quote) || !value.synopsis.trim() ||
      sanitizeSynopsis(value.synopsis) !== value.synopsis || /[<>\r\n]/.test(value.synopsis)) throw new CodexProposalError('invalid_output');
  } } });
  return { kind: 'success' as const, synopsis: (JSON.parse(result.text) as {synopsis:string}).synopsis, usage: result.usage };
}
