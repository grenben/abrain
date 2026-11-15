import { readPrivateCodexConfig } from '../ai/private-policy.ts';
import { validateCodexReadJob } from './codex-action-contract.ts';
/** Legacy native-loop capability check, preserved outside private mode. */
export async function assertQueueModelCapability(jobName: string, data?: Record<string, unknown>): Promise<void> {
  if (jobName === 'subagent' && readPrivateCodexConfig()) { validateCodexReadJob(data ?? {}); return; }
  if (jobName === 'subagent' && data?.action_protocol !== undefined) throw new Error('codex_action_private_mode_required');
  // v0.38 (S1.7 + D6) — capability-based gate replaces the v0.31.12 Anthropic
  // pin. The subagent loop now routes through `gateway.toolLoop()` so any
  // provider whose recipe declares tool calling AND supports_subagent_loop
  // works. Refuse-at-submit when the requested model cannot run a tool loop
  // (no tools, loop declared unsupported, or unknown provider). The handler
  // (`subagent.ts`) does a defense-in-depth check at dispatch time too.
  if (jobName === 'subagent' && data && typeof data === 'object') {
    const submittedModel = (data as { model?: unknown }).model;
    if (typeof submittedModel === 'string' && submittedModel.length > 0) {
      const { classifyCapabilities } = await import('../ai/capabilities.ts');
      const verdict = classifyCapabilities(submittedModel);
      if (verdict === 'unusable:no_tools') {
        throw new Error(
          `subagent job rejected: data.model "${submittedModel}" lacks native tool calling. ` +
          `The subagent loop dispatches brain ops via tool calls — without tool support the loop has no way to run. ` +
          `Pick a provider that supports tools (anthropic, openai, google, litellm, deepseek, groq, together, azure-openai).`,
        );
      }
      if (verdict === 'unusable:no_subagent_loop') {
        throw new Error(
          `subagent job rejected: data.model "${submittedModel}" comes from a provider whose recipe declares ` +
          `supports_subagent_loop: false — its tool_call_ids are not stable enough across crashes/replays ` +
          `to drive the subagent loop. ` +
          `Pick a provider whose recipe declares supports_subagent_loop: true (e.g. anthropic, openai, google, deepseek, groq).`,
        );
      }
      if (verdict === 'unknown') {
        const { listRecipes } = await import('../ai/recipes/index.ts');
        const known = listRecipes().map((r) => r.id).join(', ');
        throw new Error(
          `subagent job rejected: data.model "${submittedModel}" references an unknown provider. ` +
          `Use format provider:model where provider matches a recipe in src/core/ai/recipes/. ` +
          `Known providers: ${known}.`,
        );
      }
      // 'degraded:no_caching' and 'degraded:no_parallel' pass through — the
      // gateway prints a once-per-(source, model) cost warning at first
      // dispatch. 'ok' passes through silently.
    }
  }
}
