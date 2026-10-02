# Private Codex CLI route

Codex CLI has a private operational hybrid in the gateway. It is **never** in
the public recipe registry, and is intentionally absent from public provider
list, explanation, and probe UX. A route is available only when both conditions
hold:

1. The trusted GBrain process environment contains the literal
   `GBRAIN_PRIVATE_CODEX_CLI=1`. Cwd dotenv assignments cannot enable it.
2. A caller or model configuration explicitly selects `codex-cli:<model>`.

The opt-in alone does not choose a model or spawn Codex. No database or config
value can enable the gate.

## Runtime contract

The private recipe exposes text chat and expansion. Expansion is schemaless
text generation followed by tolerant JSON parsing. Tools, subagent loops,
images, files, structured output, streaming, and embeddings are unsupported.

`maxTokens` is advisory only. The gateway passes the target through the AI SDK
to the adapter so it can emit an unsupported-setting warning, but it is omitted
from the Codex CLI arguments and from enforceable invocation limits. No output
truncation is claimed. Hard wall-clock timeout, bounded stdout/stderr, and
process-tree termination remain enforced by the adapter. These limits do not
bound model output in tokens.

Reported input/output token counts are retained for usage accounting. Codex
pricing is deliberately undeclared, so recorded dollar cost is null/unknown.
Finite hard cost budgets and delegated spend limits must refuse Codex rather
than considering the advisory output target a hard bound. There is no
zero-cost assumption.

Codex owns OAuth login, credentials, and refresh. GBrain invokes the local CLI
without accessing its authentication material. Private setup and recovery
commands are in [Codex CLI routing](../ai-providers/codex-cli.md).

## Approved live expansion smoke (2026-10-02)

One separately approved expansion smoke completed through the real
`gateway.expand()` → AI SDK → adapter → Codex CLI **0.160.0** path, using model
`gpt-5.6-luna`. The gateway returned four parsed rewrites. This confirms one
successful operational text-expansion path; it is not a provider-wide
reliability or safety claim.

Observed invocation facts:

- Arguments included `--no-daemon`, `--ask-for-approval never`, disabled
  `shell_tool`, `apps`, `browser_use`, `browser_use_external`, `computer_use`,
  and `hooks`, `web_search="disabled"`, and
  `exec --json --ephemeral --ignore-user-config --ignore-rules
  --skip-git-repo-check --sandbox read-only`.
- The CLI ran with an isolated scratch `--cd` and the explicit model. Its argv
  did **not** contain `model_max_output_tokens`.
- JSONL completion was normal and reported `input_tokens=14470`,
  `cached_input_tokens=5888`, `cache_write_input_tokens=0`,
  `output_tokens=55`, and `reasoning_output_tokens=0`. The adapter retained
  input, cached-input, output, and reasoning-output usage; the AI SDK usage type
  has no cache-write field, so that observed zero was not retained. Stderr was
  empty.
- The scratch directory had been removed before return, no process referenced
  that scratch afterward, and no artifact filename containing the returned
  thread id was found under `CODEX_HOME`. The child environment key set matched
  the adapter allowlist: `CODEX_HOME`, `HOME`, `LANG`, `LOGNAME`, `PATH`,
  `PWD`, `SHLVL`, `TERM`, `TMPDIR`, `USER`, `_`.

The approved temporary smoke artifact is the evidence record; private absolute
paths, thread/account identifiers, and credentials are intentionally omitted.
An earlier live chat attempt was aborted after confirming that Codex ignored
`model_max_output_tokens`; it produced no successful chat result. This expansion
smoke exercises a different path and does **not** validate chat completion,
prove disabled native tools can never execute, test credential rotation, prove
broad absence of persistence, or establish repeated or cross-platform
behavior. The observed scratch/process/artifact indicators are one-run evidence,
not a general proof of native isolation or ephemerality. The approved live quota
is spent. Any future live call requires fresh approval; do not make live calls
as part of ordinary tests or validation.

## Relevant files

- `src/core/ai/private-codex.ts` — trusted process-env gate and cwd-dotenv
  defense.
- `src/core/ai/model-resolver.ts` — private explicit resolution, without adding
  Codex to the public registry.
- `src/core/ai/recipes/codex-cli.ts` — private text chat/expansion capability
  declaration; no nominal dollar prices.
- `src/core/ai/gateway.ts` and `src/core/ai/guarded-generation.ts` — provider
  routing, schemaless expansion, and advisory output-limit handling.
- `src/core/ai/providers/codex-cli-language-model.ts` — local subprocess
  adapter and its hard process/byte/time limits.
- `docs/ai-providers/codex-cli.md` — private setup and disable/recovery
  instructions.
