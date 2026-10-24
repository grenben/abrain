import type { ThinkLLMClient } from '../../core/think/index.ts';
import { cachedCodexProposal } from '../../core/ai/codex-proposal-cache.ts';
import { CodexProposalError } from '../../core/ai/providers/codex-contract.ts';
import { digest } from '../../core/persistence/digest.ts';
import { sanitizeChatContent, type ChatSessionForPrompt } from './sanitize.ts';
import { isGatewayThinkClient } from './gateway-client.ts';
import { CODEX_READER_PROTOCOL, CODEX_READER_ABSTENTION } from './codex-protocols.ts';
import type { ReaderAnswer } from './reader.ts';
import { codexSubscriptionContext } from '../../core/ai/subscription-context.ts';
import { resolveModel } from '../../core/model-config.ts';

interface Proposal { answer: string; status: 'answered' | 'abstained'; citations: Array<{ session_id: string; quote: string }> }
export async function codexReader(input: {
  client: ThinkLLMClient; model: string; system: string; prompt: string; maxTokens: number;
  sessions: ChatSessionForPrompt[]; maxSessionChars: number;
}): Promise<Pick<ReaderAnswer, 'text' | 'usage' | 'response_model' | 'finish_reason' | 'native'>> {
  if (!isGatewayThinkClient(input.client) || input.sessions.length > 64) throw new CodexProposalError('invalid_input');
  await resolveModel(codexSubscriptionContext()?.engine ?? null, { privateRole: 'longmemeval-reader', cliFlag: input.model, configKey: 'models.eval.longmemeval', fallback: 'unused' });
  const evidence = new Map(input.sessions.map(s => [s.session_id, sanitizeChatContent(s.body, input.maxSessionChars).text]));
  if (evidence.size !== input.sessions.length) throw new CodexProposalError('invalid_input');
  const system = `${input.system}\nReturn the native schema. Ground answers in exact quotations from the supplied sessions. ` +
    `When evidence is insufficient, use status abstained, no citations, and answer exactly: ${CODEX_READER_ABSTENTION}`;
  const evidenceHash = digest({ protocol: CODEX_READER_PROTOCOL, system, prompt: input.prompt, evidence: [...evidence] });
  const result = await cachedCodexProposal({ privateRole: 'longmemeval-reader', model: input.model, system, messages: [{ role: 'user', content: input.prompt }],
    maxTokens: input.maxTokens, timeoutMs: 120000, responseSchema: { name: CODEX_READER_PROTOCOL, schema: {
      type: 'object', properties: {
        evidence_hash: { type: 'string', enum: [evidenceHash] },
        answer: { type: 'string', minLength: 1, maxLength: 20000 },
        status: { type: 'string', enum: ['answered', 'abstained'] },
        citations: { type: 'array', maxItems: 32, items: { type: 'object', properties: {
          session_id: { type: 'string', minLength: 1, maxLength: 200 }, quote: { type: 'string', minLength: 1, maxLength: 4000 },
        }, required: ['session_id', 'quote'], additionalProperties: false } },
      }, required: ['evidence_hash', 'answer', 'status', 'citations'], additionalProperties: false,
    }, validateCodexProposal: text => {
      const value = JSON.parse(text) as Proposal;
      if (!value.answer.trim() || value.status === 'answered' && !value.citations.length ||
        value.status === 'abstained' && (value.citations.length || value.answer !== CODEX_READER_ABSTENTION)) throw new CodexProposalError('invalid_output');
      const seen = new Set<string>();
      for (const cite of value.citations) {
        const key = JSON.stringify(cite);
        if (!cite.quote.trim() || !evidence.get(cite.session_id)?.includes(cite.quote) || seen.has(key)) throw new CodexProposalError('invalid_output');
        seen.add(key);
      }
    } } });
  const value = JSON.parse(result.text) as Proposal, u = result.usage;
  return { text: value.answer, finish_reason: 'end_turn', response_model: null,
    usage: u ? { total_input_tokens: u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens,
      uncached_input_tokens: u.input_tokens, cache_read_input_tokens: u.cache_read_tokens,
      cache_write_input_tokens: u.cache_creation_tokens, output_tokens: u.output_tokens, reasoning_tokens: u.reasoning_tokens ?? null } : null,
    native: { protocol: CODEX_READER_PROTOCOL, cache_hit: result.cacheHit, status: value.status, citations: value.citations } };
}
