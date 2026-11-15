import { createHash } from 'node:crypto';

/**
 * Derive OpenAI's `prompt_cache_key` (the AI SDK's `providerOptions.openai.
 * promptCacheKey`). It's a ROUTING hint, not a cache breakpoint: OpenAI caches
 * prefixes automatically, and a stable key makes requests sharing a prefix
 * land on the same engine, raising the hit rate (OpenAI cites 60%→87%).
 *
 * Hash the system prompt + sorted tool names — that's the stable prefix
 * gbrain's repeated loops (enrich, page-summary, skillopt, subagent) actually
 * share. Returns undefined when there's no system prompt (nothing stable to
 * key on), so one-off requests don't get pinned to a single engine. An
 * explicit key can still be set per provider/model via
 * `provider_chat_options` config, which overrides the derived key.
 *
 * @internal exported for tests; not part of the public gateway API.
 */
export function openAIPromptCacheKey(args: {
  system?: string;
  toolNames?: string[];
}): string | undefined {
  if (!args.system) return undefined;
  const basis = `${args.system} ${(args.toolNames ?? []).slice().sort().join(',')}`;
  return `gbrain:${createHash('sha256').update(basis).digest('hex').slice(0, 32)}`;
}
