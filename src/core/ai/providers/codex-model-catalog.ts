import { CODEX_PROPOSAL_LIMITS } from './codex-contract.ts';
import { CODEX_PROPOSAL_INSTRUCTIONS } from './codex-runtime.ts';

/**
 * A per-call model profile for the pinned Codex runtime. The selected slug is
 * still sent to the provider; these local metadata fields only constrain the
 * CLI's effective tool plan. Unknown fields or modes must fail strict config,
 * never fall back to the provider's action-capable catalog.
 */
export function codexProposalModelCatalog(model: string): string {
  return JSON.stringify({ models: [{
    slug: model,
    display_name: model,
    description: null,
    supported_reasoning_levels: [],
    shell_type: 'disabled',
    visibility: 'list',
    supported_in_api: true,
    priority: 0,
    availability_nux: null,
    upgrade: null,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: 'bytes', limit: CODEX_PROPOSAL_LIMITS.promptBytes },
    experimental_supported_tools: [],
    tool_mode: 'direct',
    input_modalities: ['text', 'image'],
    supports_search_tool: false,
    include_skills_usage_instructions: false,
    include_apps_usage_instructions: false,
    include_plugin_usage_instructions: false,
    model_messages: { instructions_template: CODEX_PROPOSAL_INSTRUCTIONS },
    node_repl_disabled: true,
    use_responses_lite: false,
  }] });
}
