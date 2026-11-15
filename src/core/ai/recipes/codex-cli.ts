import type { Recipe } from '../types.ts';

/** Configured models only: no discovery, API key, nominal price, or native tool capability. */
export const codexCli: Recipe = {
  id:'codex-cli',name:'Codex CLI subscription',tier:'native',implementation:'codex-cli',billing:'subscription',
  touchpoints:{
    chat:{models:[],supports_tools:false,supports_subagent_loop:false,supports_host_structured_actions:true,supports_structured_outputs:true,default_timeout_ms:120_000},
    expansion:{models:[],default_timeout_ms:120_000},
  },
  setup_hint:'Experimental private source implementation. Requires trusted private_codex configuration, explicit subscription admission and a qualified official Codex runtime. No runtime is qualified yet.',
};
