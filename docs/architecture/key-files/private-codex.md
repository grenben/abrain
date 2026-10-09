# Private Codex source modules

## Experimental private Codex source

- `src/core/ai/providers/codex-proposal.ts` — ephemeral structured proposal adapter; native schema/image files, validated lifecycle, typed failures and conservative scratch cleanup. `codex-input.ts` snapshots/validates input before admission, `codex-schema.ts` rejects unsupported schemas and validates results, `codex-images.ts` bounds image containers, `codex-lifecycle.ts` separates transport events from application JSON, `codex-process.ts` settles POSIX process groups, `codex-contract.ts` owns limits/failure types, and `codex-runtime.ts` owns fixed argv and host instructions. `codex-qualification.ts` has no qualified production runtime; fake-executable hashes are registered only by tests.
- `src/core/ai/private-policy.ts` — trusted file-only private opt-in and strict explicit-pin checks without discovery. `private-roles.ts` is an incomplete dispatch inventory. `private-route-audit.ts` reports uninspected planes and incomplete feature acceptance; CLI `private-codex audit --json` opens no database or provider.
- `src/core/ai/codex-dispatch.ts` — durable subscription admission and observed proposal dispatch. `subscription-context.ts` carries host-owned async scopes; `subscription-admission.ts` reserves/settles account lanes and attempt/turn/repair limits; `subscription-schema.ts` is installed by registered migration v223 on both engines. Unresolved attempts retain ownership. `codex-chat.ts` adapts bounded chat/expansion/OCR through this path. `recipes/codex-cli.ts` declares subscription/schema capability without claiming native tools or inventing prices.
- `src/core/ai/chat-format.ts` — deterministic OpenAI prompt-cache key derivation extracted from the gateway; its existing gateway export is preserved.
- `src/core/config-path.ts` — engine-free config path helpers, re-exported by `config.ts`; retains the `GBRAIN_HOME/.gbrain` convention.
- `src/core/cycle/extract-atoms-model.ts` — atom extraction's special model resolver, with strict private routing and the legacy fail-soft behavior outside private mode; re-exported from `extract-atoms.ts`.
- `src/core/minions/handlers/subagent-result-mode.ts` — result mode/fallback token stamping extracted from the legacy handler. Private mode refuses its native loop before client construction; the host action loop is not implemented yet.

See [private Codex status and acceptance gaps](../../development/private-codex-status.md).
