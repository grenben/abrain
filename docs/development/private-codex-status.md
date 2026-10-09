# Private Codex development status

This is an incomplete development checkpoint, not a release or activation guide.
The target remains: Codex proposes; GBrain authorizes, records, executes and reconciles.

## Installation and source evidence (2026-10-09)

- The shell GBrain launcher resolves through `~/.local/bin/gbrain` and
  `~/.bun/bin/gbrain` to the global Bun package's `gbrain/src/cli.ts`.
  Its package version is **0.60.96.0**. The package's `.bun-tag` contains
  `garrytan-gbrain-9dbc00c`; exact build/commit correspondence is unverified.
- Accessible MCP/autopilot wrapper files select `~/.bun/bin/gbrain`.
  Actual worker process state and user service state could not be confirmed.
  The user service bus was inaccessible. Wrapper metadata is not proof of a running worker.
- The installed recipe/gateway/minion sources did not contain the selected
  private Codex architecture. Installed verdict: **absent for that architecture**.
  Generic Anthropic generation and persistence already exist.
- Development starts from upstream commit
  `6d4d4a92405d1caf3cdb48649a0a2cd7b4eef634`, source version **0.60.128.0**,
  on branch **codex/private-subscription-v1**. This newer source is not evidence
  of installed capabilities. Source is an upstream-derived checkout, not an
  exact reconstruction of the older installed package.
- The prior branch `codex/private-subscription` retains its staged prototype;
  unrelated personal workspace changes were not included in this worktree.
- Local Codex reports **0.162.0**. The non-secret login-status command reported
  ChatGPT authentication. No credential file was opened/copied/refreshed.
  This status does not prove a successful subscription inference call.
- Accessible GBrain file-plane routing included `voyage:voyage-4` embeddings.
  DB, worker and queued-job pin planes were not inspected. No database was
  opened for diagnosis, and no production model discovery/probe was run.

## Before/after capability matrix

Statuses assess the selected Codex architecture, not whether the legacy feature exists.
The installed artifact has not changed. Private activation and live verification are **no**.

| Area | Installed | Source before | Source now | Evidence / remaining work |
|---|---|---|---|---|
| A. Schema/image transport and lifecycle | absent | partial prototype | partial | `codex-proposal`, `codex-input`, `codex-schema`, `codex-lifecycle`, `codex-process` and fake executable tests. Real schema file/argv, JSONL completion, local validation, private scratch, filtered env, process-group settlement. Runtime native-action/instruction isolation remains unqualified; image validation currently checks bounded container headers/dimensions, not a full codec decode. Windows process trees unsupported. |
| B. Strict routing | absent | absent | partial | `private-policy`, gateway/provider construction guards, `model-config`, special atom resolver, and legacy subagent entry gate. Explicit conflicting pins fail; default roles choose the configured Codex model. Complete queue/eval/pin-plane coverage remains open. |
| C. Subscription accounting | absent | absent | partial | `subscription-admission`, migration v223, `codex-dispatch`, async host scopes, honest null costs, independent auxiliary USD guards. PGLite and native PostgreSQL tests cover account concurrency, immutable envelopes, bounds, stale ownership and unresolved retention. Durable operator reconciliation and producer/queue/cycle envelope integration remain open. The lane is shared within one brain DB, not across unrelated DBs. |
| D. Bounded feature coverage | absent | absent | partial | Actual gateway chat/expansion/OCR use the proposal path; schema/image transport and valid empty outcomes tested. `private-roles` inventories roles without claiming feature acceptance. Semantic validation, citations, cache identity and failure/watermark behavior require role-by-role fixtures and fixes. |
| E. Synthesis/pattern publication | absent | unverified | unverified | Existing prepared-write/oneshot machinery is available. No Codex-specific accepted-plan retention, partial-commit flow or transcript-to-pattern acceptance fixture is claimed here. |
| F. Host-owned action loop | absent | absent | absent | Existing ledger/canonical IDs, delegated tools, receipts and worker leases were located. Codex native tools remain false; the unfinished private minion path refuses execution before Anthropic construction. Sequential host action schema/loop, fencing, recovery and proven writes still need implementation. Deterministic worker registration remains possible. |
| G. Diagnostics/migration | absent | absent | partial | `private-codex audit --json` is a new engine-free, no-call source command, always incomplete until coverage closes. No pin preview/apply/rollback or queued-job drain/park/resubmit tooling is implemented yet. |

## Changes developed

The old two-file prototype was not a gateway implementation. This branch adds:

- A split adapter implementation: request snapshots and explicit schema subset
  validation; owner-only schema, answer and image files; stdin prompts; JSONL
  lifecycle parsing; bounded stderr/stdout; typed, content-free errors;
  cancellation settlement and retained scratch on unconfirmed termination.
- A runtime qualification gate. Its production allowlist is deliberately empty;
  tests register only the SHA-256 of synthetic fake executables. Changing a fake
  after registration refuses execution. There is no configuration flag to bypass
  this qualification gate in a deployed runtime.
- Trusted file-only `private_codex` parsing, strict pin checking without model
  discovery or alias fallback, generative gateway defaults, an atom-resolver
  branch, and pre-construction checks on native provider/legacy minion paths.
- A Codex recipe that reports subscription billing and schema proposals, with
  native tools and native subagent loops false. Its model is explicitly configured;
  no subscription model list or prices are invented.
- A transactional subscription ledger (migration v223, identical SQL on both
  storage engines) and dispatch integration. It never expires ambiguous account
  ownership just because time elapsed. Failed attempts consume their allowance.
  Missing subscription admission cannot be replaced by a USD-only cap.
- Gateway chat, query expansion and OCR paths, observed through the invocation
  guard, retaining measured tokens and unknown monetary cost. Auxiliary embedding
  and reranking still use their own USD admission. No provider fallback is used.
- An engine-free route audit plus a deliberately incomplete feature inventory.
- Small extractions from config, gateway, atoms and subagent code to remain within
  the existing module/function ceilings. No ceiling was increased.

## Runtime qualification blocker

The local CLI advertises native schema/image files, JSONL, ephemeral calls,
strict configuration and user-config/rule isolation flags. Those flags alone
are insufficient to prove native tools cannot execute. Current official
[Codex hooks documentation](https://learn.chatgpt.com/docs/hooks) and
[pre-tool implementation](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/pre_tool_use.rs)
require care around hook failure behavior. A denial hook is defense in depth,
not a proven blanket denial mechanism. Current upstream source was inspected,
but was not proven identical to the installed binary.

Before adding a production build hash to the qualification registry, verify
all native and hosted action surfaces are denied before execution even when
hooks fail; inherited managed configuration/instructions/plugins cannot change
that; images are handled only through the verified image interface; and process
containment settles descendants, including attempts to detach. Fake tests prove
GBrain transport and accounting, not those native runtime properties.

## Verification

All tests use synthetic inputs, temporary configuration and isolated state.
No real Codex inference, subscription tokens, production database, live worker
or production migrations are involved. Fake subprocess tests need execution
outside this session's sandbox because Bun child stdin is blocked there.

The full repository verification run passed **75 checks, zero failures, one skip**
after fixing test isolation and documentation size. The admin gate runs an unpinned
additional install and remains explicitly skipped under the locked-dependency-only
authorization. Typecheck and compiled build passed.

The first regression run passed 229 tests across six files. The final focused
unit/CLI/subagent run passed 149 tests across six files. Adapter/gateway/schema
tests passed 30 cases; the subsequent gateway run passed all five cases, including
the added terminal-accounting fixture. Migration/generator tests passed 195 cases;
PGLite migration/catalog goldens passed 13. These
suites overlap; their counts must not be summed as unique coverage.
The compiled no-call audit produced valid JSON; incomplete coverage now exits 1.
It reported 27 roles/incomplete
coverage and created no files in a fresh temporary HOME.

Focused commands:

```sh
bun test --timeout=60000 test/ai/codex-proposal.serial.test.ts test/ai/codex-schema-lifecycle.test.ts test/ai/codex-gateway.serial.test.ts
bun test --timeout=60000 test/ai/subscription-admission.test.ts test/ai/private-policy.serial.test.ts test/ai/private-route-audit.test.ts
bun test --timeout=60000 test/model-config.serial.test.ts test/ai/gateway.test.ts test/ai/capabilities.test.ts test/core/budget/budget-tracker.test.ts test/cycle/extract-atoms-model-config-fail-soft.test.ts test/subagent-handler.test.ts
bun run typecheck
bun run build
bun run check:module-size
bun run check:function-size
bun run check:recipe-pricing
bun run check:layering
bun run check:jsonb-params
bun run check:ai-sdk-importers
bun run check:orphan-modules
bun run check:schema-migrations
```

With separate user authorization, an isolated PostgreSQL **16.15** cluster was
provisioned under `/tmp`, using its own owner-only data/socket directories, random
loopback port and generated test-only SCRAM password. The host's pgvector 0.6.0
caused expected legacy `vector` versus `halfvec` catalog drift. PostgreSQL binaries
were copied into `/tmp/maxbrain-pg-runtime`; pgvector **0.8.7** was built from the
[official tagged source](https://github.com/pgvector/pgvector/tree/v0.8.7) using
matching Ubuntu headers extracted there. No system package/service was changed.

The corrected native run passed **13 tests, zero failures**, including five new
independent-connection admission tests and PostgreSQL/PGLite column parity.
It verifies lane contention, loser rollback, attempt caps, connection-loss recovery
without replay, stale owner fencing, changed input rejection, and concurrent turn
acceptance with losing-transaction rollback. The optional PgBouncer arm was skipped.
Four regenerated PostgreSQL catalog goldens contain only added subscription objects.
A fresh-cluster rerun with regeneration disabled passed eight catalog/parity tests
(one PgBouncer skip). Each test cluster was stopped afterward. Command, in a scrubbed environment with
only the generated test target supplied:

```sh
GBRAIN_TEST_ALLOW_DATABASE_URL=1 GBRAIN_CI_DISABLE_TEST_ENV_FILE=1 GBRAIN_TEST_UPDATE_GOLDENS=1 bun test --timeout=240000 test/e2e/codex-subscription-admission.test.ts test/e2e/schema-catalog-golden.test.ts
```

No claim is made for the still-missing publication/minion recovery acceptance tests.

## Upgrade handoff and remaining acceptance

**Do not deploy or activate this checkpoint.** Continue development in dependency
order: qualify runtime isolation, finish account recovery and queue/cycle admission,
close bounded-role semantics, retain synthesis/pattern plans through prepared writes,
then implement sequential host-owned actions and prove write replay/fencing.
Finish pin/job migration and worker diagnostics after those protocols stabilize.

GitHub creation/authentication/push are deferred until the owner can authorize them.
The new repository/remotes have not been created or changed.

Once source and deterministic gates are complete, a separately authorized upgrade
must build the selected revision, install it through the actual Bun package/launcher
layout, preview/apply registered DB migrations, deal explicitly with legacy jobs,
and restart all affected services onto the same artifact. Preserve the DB target
and prepare rollback of binaries/config/pins before activation. Do not delete
unresolved subscription rows as a way to make a blocked call run again.

Separately authorized bounded live checks must verify subscription auth mode,
schemas/images, maintenance, iterative read/write recovery and cancellation.
Only then activate trusted private configuration. **Installed GBrain currently
retains its original capabilities. Implemented source, fake verification,
installation, live verification and activation are different states.**
