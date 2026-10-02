# Private Codex CLI routing

Codex CLI is an operationally available **private-only** route, not a public
GBrain provider. It is never registered: `gbrain providers` commands
intentionally do not list, probe, or test it. Resolve it only by explicitly
configuring a qualified `codex-cli:<model>` and enabling the trusted process
environment gate `GBRAIN_PRIVATE_CODEX_CLI=1`. The literal value `1` is
required; values from cwd dotenv files are rejected. A gate by itself neither
selects Codex nor starts the CLI.

## Private setup

Install the Codex CLI and authenticate using Codex's own OAuth/login flow:

```sh
codex login
codex login status
```

In the trusted shell that will run GBrain, enable the private route and
explicitly select it for one or both model roles:

```sh
export GBRAIN_PRIVATE_CODEX_CLI=1
gbrain config set models.chat codex-cli:gpt-5.6-sol
gbrain config set models.expansion codex-cli:gpt-5.6-sol
```

The gate must be present in the GBrain process environment on every invocation;
do not place it in a project `.env` file. `GBRAIN_CODEX_CLI_BIN` may select a
non-default Codex executable. Codex owns OAuth credentials, login, and token
refresh; GBrain does not read or manage that authentication. The model names in
the staged recipe are routing hints, not provider-side validation or a promise
that a particular model is available to the signed-in account.

## Supported boundary and accounting

The private route supports text chat and schemaless text-based query
expansion. It does not support GBrain tools, subagent loops, images, files,
structured output, streaming, or embeddings. `maxTokens` is advisory only: the
gateway passes the target to the adapter for its unsupported-setting warning,
but omits it from Codex CLI arguments and enforceable invocation limits. GBrain
does not truncate output or enforce a model output-token ceiling. Hard
wall-clock timeout, output-byte, and process termination limits remain in
place, but they are not substitutes for an output-token limit.

Usage token counts are recorded when Codex reports them. Dollar cost is
unknown/null, not zero. Finite hard cost budgets and delegated spend controls
must refuse this unpriced, unbounded-output route rather than treating the
advisory token target as an enforceable ceiling.

## Approved live expansion smoke (2026-10-02)

One approved smoke completed a real `gateway.expand()` → AI SDK → adapter →
Codex CLI **0.160.0** call with `gpt-5.6-luna` and returned four parsed
rewrites. CLI arguments included `--no-daemon`, `--ask-for-approval never`,
disabled shell/apps/browser/computer/hooks capabilities,
`web_search="disabled"`, and `exec --json --ephemeral --ignore-user-config
--ignore-rules --skip-git-repo-check --sandbox read-only`, with an isolated
scratch `--cd` and explicit model. `model_max_output_tokens` was absent from
argv. JSONL completed normally and reported `input_tokens=14470`,
`cached_input_tokens=5888`, `cache_write_input_tokens=0`, `output_tokens=55`,
and `reasoning_output_tokens=0`. The adapter retained every listed field except
cache-write usage, which the AI SDK usage type cannot represent. Stderr was empty. Scratch was
removed before return, no process referenced it afterward, and no artifact
filename containing the returned thread id was found under `CODEX_HOME`. The
child environment keys matched the adapter allowlist (`CODEX_HOME`, `HOME`,
`LANG`, `LOGNAME`, `PATH`, `PWD`, `SHLVL`, `TERM`, `TMPDIR`, `USER`, `_`).

The evidence is recorded in the approved temporary smoke artifact; no private
paths, thread/account identifiers, or credentials are included here. An earlier
live chat attempt was aborted after proving Codex ignored
`model_max_output_tokens`; it had no successful result. This single expansion
validates operational text generation and those observed process/ephemeral
indicators once. It does not prove disabled native tools can never execute,
validate chat completion or credential rotation, prove broad absence of
persistence, or establish repeated/cross-platform behavior. The approved live
quota is spent. Future live calls require fresh approval; ordinary tests and
setup must not make live Codex calls.

## Disable and recover

To disable the private route for a shell, remove the gate:

```sh
unset GBRAIN_PRIVATE_CODEX_CLI
```

If Codex model values remain configured, calls will fail closed as an unknown
provider while the gate is absent. To restore a normal hosted route, configure
supported models explicitly, for example:

```sh
gbrain config set models.chat anthropic:claude-sonnet-4-6
gbrain config set models.expansion anthropic:claude-haiku-4-5-20251001
```

Alternatively, unset either model override to return that role to its ordinary
model-resolution chain. Keep the gate unset unless private Codex use is
deliberately intended.

See [the implementation record](../designs/CODEX_CLI_PROVIDER.md) and the
[AI key-file index](../architecture/key-files/core-ai.md).
