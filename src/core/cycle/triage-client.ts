import type Anthropic from '@anthropic-ai/sdk';
import { chat as gatewayChat, validateModelId, type ChatResult } from '../ai/gateway.ts';
import { hasAnthropicKey } from '../ai/anthropic-key.ts';
import { normalizeModelId } from '../model-id.ts';
import { assertTriageRoute, codexTriageSchema } from './triage-codex.ts';

export interface JudgeClient {
  create: (
    params: Anthropic.MessageCreateParamsNonStreaming,
    options?: { signal?: AbortSignal; validateCodexProposal?: (text: string) => void },
  ) => Promise<Anthropic.Message>;
}

/**
 * Build a gateway-routed JudgeClient for the resolved verdict model.
 * Returns null when no chat provider is reachable for `verdictModel`:
 *   - Unknown provider id (resolveRecipe throws AIConfigError).
 *   - Anthropic provider with no key (env or config) — preserves the legacy
 *     "no ANTHROPIC_API_KEY" cheap-skip semantics.
 * On null, the verdict loop short-circuits each transcript with an explicit
 * "no configured provider" reason and continues the phase.
 *
 * For non-Anthropic providers (deepseek, openrouter, voyage, ollama,
 * llama-server, ...), we delegate auth probing to the gateway's own
 * recipe `auth_env.required` machinery — AIConfigError at gateway.chat()
 * time is caught by the verdict loop and surfaced per-transcript.
 */
export function makeJudgeClient(verdictModel: string): JudgeClient | null {
  // Normalize: ensure provider:model shape (and slash→colon — #1698). resolveModel
  // returns bare anthropic ids (e.g. `claude-haiku-4-5`); gateway.chat needs `anthropic:...`.
  const modelStr = normalizeModelId(verdictModel);
  assertTriageRoute(modelStr);

  // #1698 (C1): id-validity via the shared `validateModelId` core (resolveRecipe +
  // assertTouchpoint) — catches unknown provider AND chat-less provider (model-id
  // typos pass locally and fail at the provider; no runtime allowlist). We do NOT
  // use the full `probeChatModel` here: its `isAvailable` layer would reject
  // non-Anthropic-no-key providers and an unconfigured gateway, breaking the
  // deliberate per-transcript-degrade contract (and test A9). validateModelId reads
  // the recipe registry, not gateway _config, so it works pre-configureGateway().
  const v = validateModelId(modelStr);
  if (!v.ok) return null;

  // Anthropic key probe (legacy behavior preserved verbatim). Other providers' key
  // checks happen lazily at chat call time and surface as AIConfigError, which the
  // verdict loop catches per-transcript.
  if (v.parsed.providerId === 'anthropic' && !hasAnthropicKey()) return null;

  return {
    create: async (params, options): Promise<Anthropic.Message> => {
      // Map Anthropic.MessageCreateParamsNonStreaming → gateway.ChatOpts.
      // `judgeSignificance` always sends string content + string system,
      // and the adapter only TEXT-flattens the array-of-blocks shape —
      // `tool_use`, `tool_result`, image, and other non-text blocks become
      // empty strings. If a future caller wires tool-use or image content
      // through this client, extend the mapping instead of relying on the
      // current silent drop. Same pattern as think/index.ts:607-615.
      const messages = params.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content)
              ? m.content.map(b => ('text' in b ? b.text : '')).join('')
              : ''),
      }));
      const system = typeof params.system === 'string'
        ? params.system
        : (Array.isArray(params.system)
            ? params.system.map(b => ('text' in b ? b.text : '')).join('')
            : undefined);

      const result: ChatResult = await gatewayChat({
        model: modelStr,
        responseSchema: codexTriageSchema(modelStr, options?.validateCodexProposal),
        system,
        messages,
        maxTokens: params.max_tokens,
        // DeepSeek v4 thinks by default and bills reasoning as OUTPUT tokens
        // against max_tokens (recipe thinking_by_default, #4172) — same for
        // OpenRouter's DeepSeek hosts (#4758) and a configured Anthropic
        // thinking mode. The judge wants only the small JSON verdict, so it
        // turns thinking off per call (#5331; per-route mapping in thinking-off.ts).
        thinking: 'off',
        // #4077: a cancelled cycle tears down the in-flight judge call too.
        abortSignal: options?.signal,
      });

      // Map gateway.ChatResult → Anthropic.Message shape. judgeSignificance
      // reads `.content[0].type === 'text'`, `.content[0].text`, and
      // `.stop_reason`; other fields are best-effort for downstream
      // telemetry parity. The stopReason mapping is load-bearing:
      // 'length' → 'max_tokens' lets judgeSignificance detect a truncated
      // verdict (reasoning models can burn the whole max_tokens budget on
      // reasoning tokens, leaving empty/partial text) and
      // 'refusal'/'content_filter' → 'refusal' surfaces a blocked response,
      // instead of silently treating either as a clean end-of-turn.
      // 'other' (gateway's mapStopReason catch-all — unknown provider
      // finish reasons, which includes both non-standard SUCCESSFUL stops
      // and the AI SDK's 'error'/'unknown' labels) maps to 'end_turn'
      // deliberately. Rationale: (a) treating 'other' as abnormal would
      // permanently disable verdict caching on providers whose successful
      // stops the gateway doesn't recognize; (b) the residual risk is
      // narrow — an errored response only gets cached if it still contains
      // a complete, parseable JSON object with a finite numeric score in
      // [0,1] (unparseable output is never cached), and such a complete
      // verdict is trustworthy regardless of the finish label. Distinguishing
      // error/unknown from benign-unknown belongs in gateway.ts's
      // mapStopReason (out of scope here — see PR notes).
      return {
        id: '',
        type: 'message',
        role: 'assistant',
        model: modelStr,
        // A chat_fallback_chain entry answered: judgeSignificance marks the verdict uncacheable.
        ...(result.fallbackFrom ? { answered_by: result.model } : {}),
        content: [{ type: 'text', text: result.text }],
        stop_reason: result.stopReason === 'length' ? 'max_tokens'
          : result.stopReason === 'tool_calls' ? 'tool_use'
          : (result.stopReason === 'refusal' || result.stopReason === 'content_filter') ? 'refusal'
          : 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
        },
      } as unknown as Anthropic.Message;
    },
  };
}
