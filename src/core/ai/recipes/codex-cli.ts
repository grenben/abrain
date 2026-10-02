import type { Recipe } from '../types.ts';

/** Private-only staged recipe; never add to the public recipe registry.
 * OpenAI Codex through the locally installed `codex` CLI and its saved
 * ChatGPT authentication. GBrain never reads or refreshes Codex credentials;
 * the CLI owns login, keyring/file storage, refresh, and workspace policy.
 */
export const codexCli: Recipe = {
  id: 'codex-cli',
  name: 'Codex (via CLI)',
  tier: 'native',
  implementation: 'codex-cli',
  auth_env: {
    required: [],
    optional: ['GBRAIN_CODEX_CLI_BIN', 'CODEX_HOME'],
    setup_url: 'https://developers.openai.com/codex/auth',
  },
  touchpoints: {
    expansion: {
      models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
      default_timeout_ms: 30_000,
    },
    chat: {
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      supports_tools: false,
      supports_subagent_loop: false,
      supports_prompt_cache: true,
      thinking_by_default: true,
      max_context_tokens: 1_050_000,
      default_timeout_ms: 30_000,
    },
  },
  aliases: {
    codex: 'gpt-5.6-sol',
    sol: 'gpt-5.6-sol',
    terra: 'gpt-5.6-terra',
    luna: 'gpt-5.6-luna',
  },
  setup_hint:
    'Install the Codex CLI and run `codex login`. Verify the saved session with ' +
    '`codex login status`. Set GBRAIN_CODEX_CLI_BIN when `codex` is not on PATH.',
};
