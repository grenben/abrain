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
| A. Schema/image transport and lifecycle | absent | partial prototype | partial | `codex-proposal`, `codex-input`, `codex-schema`, `codex-lifecycle`, `codex-process` and fake executable tests. Real schema file/argv, JSONL completion, local validation, private scratch, filtered env, process-group settlement. Runtime native-action/instruction isolation remains unqualified; PNG validation checks complete chunks, bounded inflation and decoded pixels before admission; JPEG/WebP now validate complete containers and decoded pixels using pinned local WASM. Windows process trees unsupported. |
| B. Strict routing | absent | absent | partial | `private-policy`, gateway/provider construction guards, `model-config`, special atom resolver, and legacy subagent entry gate. Explicit conflicting pins fail; default roles choose the configured Codex model. Complete queue/eval/pin-plane coverage remains open. |
| C. Subscription accounting | absent | absent | partial | `subscription-admission`, migration v223, `codex-dispatch`, async host scopes, honest null costs, independent auxiliary USD guards. PGLite and native PostgreSQL tests cover account concurrency, immutable envelopes, bounds, stale ownership and unresolved retention. Queue/worker binding is implemented below; explicit CLI and two scheduled producers now issue allowances; other producers and durable operator reconciliation remain open. Migration v225 preserves unknown subscription totals in extraction rollups alongside API subtotals. The lane is shared within one brain DB, not across unrelated DBs. |
| D. Bounded feature coverage | absent | absent | partial | Actual gateway chat/expansion/OCR use the proposal path; schema/image transport and valid empty outcomes tested. `private-roles` inventories roles without claiming feature acceptance. Facts/classifiers, atoms, grading, drift and chunk synopses now have native schemas and semantic checks; see the bounded-role follow-up. Other roles and full publication recovery still require fixtures and fixes. |
| E. Synthesis/pattern publication | absent | unverified | partial | Private patterns now use native proposals, v226 retained plans, stable prepared-write receipts, evidence revision checks, source-scoped provenance and partial-commit recovery. PGLite/PostgreSQL fixtures cover the pattern path. Bounded private synthesis now shares the retained-plan path, with multi-chunk completion, required summary receipts and transcript-to-pattern fixtures on both engines. Existing-page edits, full worker/crash acceptance and operator reconciliation tooling remain open; see the synthesis checkpoint. |
| F. Host-owned action loop | absent | absent | partial | Explicit `codex-host-read-v1` and `codex-host-actions-v1` jobs use sequential native proposals, scoped page reads and receipt-backed page writes. Migration v227 retains host authority; page protocol 3 preserves untrusted write semantics and fences publication against stale jobs/revisions. Fake-executable PGLite/PostgreSQL fixtures cover 41 action cases. Native tools remain false; broader reads, operator reconciliation and complete process-crash acceptance remain open. See `private-codex-actions.md`. |
| G. Diagnostics/migration | absent | absent | partial | `private-codex audit --json` is an engine-free, no-call source command, always incomplete until coverage closes. Pin migration v248 and job parking v249 have explicit previews, receipts and rollback. Queued-job previews identify drain requirements; durable fences prevent ordinary resume, and reviewed unstarted standalone jobs get new queue identities/grants. File migration requires other config writers stopped. Started/ambiguous work and graph replacements require reconciliation/new workflow review. Full worker/pin inventory and operator reconciliation remain incomplete. See `private-codex-pins.md` and `private-codex-job-upgrade.md`. |

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

## Runtime and drift follow-up

The [runtime qualification investigation](private-codex-runtime-qualification.md)
records local build metadata and why documented hook coverage is insufficient
for pre-execution denial. The production registry remains empty.
[Private drift](private-codex-drift.md) now validates native proposals and preserves
failed judgments, source scope and private report publication; its fake-executable
contract passes on PGLite and PostgreSQL. Full feature/runtime acceptance remains
incomplete.

## Queue integration follow-up

`MinionQueue.add` now accepts explicit bounded subscription consent in its trusted
fourth argument (`codexSubscription: {maxAttempts, maxTurns, deadline}`). It is
never read from job data and is currently restricted to application authority.
The run and job commit in the same transaction. A versioned run identity binds
the stored payload, submission authority, configured model/binary and explicit
source incarnation. Reusing a job with changed inputs or larger limits refuses;
coalesced legacy jobs cannot silently adopt the protocol. Retries reuse the
original allowance. Queue preflight reports conflicting job/global pins.
Private generative submissions without a trusted allowance refuse before insertion,
so they cannot leave an unfenced job available to an older worker. Previously queued
legacy jobs still need an explicit drain/park/resubmit disposition before activation.

`runWithJobSpend` carries this grant in both inline and isolated worker handlers.
It rechecks the live job lease, durable payload, authority, source incarnation and
private route before dispatch and acceptance, and carries the worker's cancellation
signal into the adapter. Migration **v224** fences each subscription job claim;
old workers cannot claim those rows. Child readiness independently requires
`codex-subscription-v1`, preventing a newer parent from invoking an older child.

Auxiliary API usage requires separate spending authorization. Capped mixed jobs
must reserve the complete known API ceiling; they cannot clip a reservation to the
remaining balance and then dispatch an oversized call. Subscription calls still
report unknown monetary cost, and the account lane stays occupied after ambiguity.

This is infrastructure for bounded jobs, not completed feature/producer coverage.
Explicit `jobs submit` flags and two opt-in cycle schedules now issue grants; other producers remain incomplete. See [producer interfaces](private-codex-producers.md).
Legacy private native minions remain refused at submission; the later action checkpoint adds an explicit scoped read protocol.
A new shared contract exercises real queue/worker/gateway paths with fake Codex
executables on both PGLite and native PostgreSQL. Production migration/activation
has not occurred.

Queue verification used scrubbed environments, isolated databases, fake executables
and a network tripwire. The final focused command passed **45 tests**:

```sh
bun test --timeout=60000 test/ai/codex-jobs.serial.test.ts test/minions-spend-authorization.test.ts test/ai/codex-gateway.serial.test.ts test/child-readiness.test.ts
```

Native PostgreSQL passed **27 tests**, with only the optional PgBouncer arm skipped,
and catalog regeneration disabled:

```sh
bun test --timeout=240000 test/e2e/codex-subscription-jobs.test.ts test/e2e/codex-subscription-admission.test.ts test/e2e/schema-catalog-golden.test.ts
```

PGLite migration/catalog checks passed 13 tests. Additional queue regressions passed
122 tests initially; one old-schema rehearsal failed because it retained the new
trigger after removing its referenced column. The fixture now removes/restores that
trigger, and its entire file (`test/minions-submission-authority.test.ts`) passes
24 tests. The other six files were `minions-admission`,
`minions-spend-enforcement-child`, `minions-legacy-coalesce`, `queue-child-done`,
`queue-started-at-retry`, and `worker-job-isolation` under `test/`.
`bun run verify` passed 75 checks (including typecheck), with the admin build still
explicitly skipped for its additional unlocked install. `bun run build` passed.
These counts overlap. The isolated PostgreSQL cluster was stopped afterward.
The final submission-time refusal also passed 44 tests across
`test/ai/codex-jobs.serial.test.ts` and `test/minions-admission.test.ts`, plus all
14 native PostgreSQL job-contract tests on a fresh isolated cluster, stopped afterward.

## Dream triage follow-up

The production `runTriagePass` / `makeJudgeClient` path now carries a bounded
native schema for Codex. Host semantic validation checks complete quotes against
both the supplied sample and original transcript, named entities against the
sample, and segment/note bounds. It runs before subscription-turn acceptance and
again at the feature boundary. Invalid output throws without storing a judgment;
there is no hidden repair or fallback. Valid zero-score/empty-segment output stays
a real verdict. A separate Codex cache version invalidates earlier prompt-only
verdicts and their backoff markers. Private triage is sequential and rejects
conflicting routes or an additional decision provider before cache/inference.

`triage-client.ts` preserves the existing gateway judge API; `triage-codex.ts`
owns these new rules. Legacy providers retain their previous parsing behavior.
The fake-executable fixture exercises the actual triage/gateway/cache path,
including schema capture, grounding, valid empty output, cache reuse/invalidation,
refusal and incomplete lifecycle. This does not qualify synthesis publication,
source authority across the full cycle, or automatic subscription grant creation.

Triage verification passed 63 tests across the new fixture, triage/cache/backoff
regressions and Codex gateway suite; two opt-in live calibration tests were skipped.
After adding refusal coverage, the final fixture and legacy gateway-adapter/fallback
run passed 61 tests (`bun test --timeout=60000 test/ai/codex-triage.serial.test.ts
test/cycle/synthesize-gateway-adapter.test.ts test/ai/gateway-chat-fallback.test.ts`).
`bun run verify` again passed 75 checks with the same admin-build skip; typecheck
and `bun run build` passed. No live provider, installed configuration or DB changed.

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

The [image-validation follow-up](private-codex-images.md) records the current
runtime blocker and complete PNG/JPEG/WebP container and pixel checks.

See [bounded-role follow-up](private-codex-bounded-roles.md) for the latest feature and accounting work.

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

Pattern publication now has the deterministic recovery coverage described below. Full synthesis and minion recovery acceptance remain incomplete.

## Pattern publication follow-up

The [publication checkpoint](private-codex-publication.md) describes the new private
pattern path and its limits. The adapter, routing, subscription admission and
prepared-write coordinator were pre-existing; this step connects them through a
retained whole-proposal plan and deterministic receipt identities. Migration v226
has parity across both supported engines. The installed artifact, production
schema, runtime qualification and activation remain unchanged.

## Bounded synthesis follow-up

The [synthesis checkpoint](private-codex-synthesis.md) adds the private dispatcher,
chunk schemas and grounding, bounded file identities, required summaries, durable
daily call reservations and completion/cooldown behavior. It reuses pre-existing
triage, the adapter and retained publication machinery. No production migration,
installation, live verification or activation occurred. The overall matrix remains
partial; existing-page edits and full host-owned action acceptance are still unfinished.

## Host-owned read action follow-up

The [action checkpoint](private-codex-actions.md) adds a versioned sequential read
loop through the actual subagent handler, existing ledger and subscription worker
scope. It generates one-action/final schemas from the authorized registry, binds
source/prefix authority, retains database-returned canonical IDs before execution,
rejects changed inputs and reconciles unfinished reads before further inference.
Legacy jobs are not reinterpreted. Writes, broader tools and remote delegation
remain incomplete. Installed capabilities, runtime qualification and activation
are unchanged.

## Pin migration follow-up

The [pin migration checkpoint](private-codex-pins.md) adds explicit per-plane
preview/apply/rollback, durable receipts and drift refusal. File/env route checks
now also reject shadowed conflicting generative pins before dispatch. Synthetic
tests cover the actual CLI, file effects and both storage engines. No installed
configuration, database, worker or queued job was changed.

## Upgrade handoff and remaining acceptance

The [queued-job cutover](private-codex-job-upgrade.md) provides explicit drain
dispositions, durable graph parking and reviewed new standalone submissions. It
retains old identities and unknown effects rather than adopting legacy payloads.
It has not been applied to the installed database or running workers.

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
