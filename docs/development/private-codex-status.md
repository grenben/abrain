# Private Codex development status

This is an incomplete development checkpoint, not a release or activation guide.
The target remains: Codex proposes; GBrain authorizes, records, executes and reconciles.

The isolated integration checkout is restamped onto upstream 0.60.296.0 as
source version 0.60.297.0. Its private migrations are registered at v258–v285.
This checkout has passed the repository verification gates; the installed
0.60.96.0 package and its database have not been changed.

Latest source checkpoint: [standalone benchmark bootstrap jobs](private-codex-bootstrap-cli.md)
adds PostgreSQL background submission and fenced worker publication for
standalone skill benchmark drafts. Migration head is 285; queued PostgreSQL
batch and bootstrap jobs retain permanent request bindings. Scheduled optimizer
cycles retain source-scoped selection and receipt-backed cooldowns. The public
queued batch API is exported from `gbrain/core/skillopt`. Fleet and remote
producers, broader query/graph tools, full dispatch coverage and production
runtime qualification remain incomplete.

The shared System One decision runner admits only the configured Codex CLI model
in strict private mode. Each batch uses a closed schema bound to its exact typed
questions; the host validates answers before accepting the subscription turn.
Query, search and background callers cannot dispatch TypeSafe, ordinary LLM, or
cross-provider fallback decisions. A leftover TypeSafe key cannot auto-enable
default paid slots while private mode is active. Host-scoped Codex chat turns
serialize through validation and acceptance, so parallel decision slots do not
race the subscription lane. Fake-executable PGLite tests cover standalone
search, the query operation and think decisions with hash-only receipts.
The same think/search intent and query-operation answerability receipts pass
on a disposable PostgreSQL brain. The shared 426-case think contract passes
on both PGLite and PostgreSQL. Calibrated action across slots and real-runtime
qualification remain open.

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
| C. Subscription accounting | absent | absent | partial | `subscription-admission`, migration v258, `codex-dispatch`, async host scopes, honest null costs, independent auxiliary USD guards. PGLite and native PostgreSQL tests cover account concurrency, immutable envelopes, bounds, stale ownership and unresolved retention. Queue/worker binding is implemented below; explicit CLI and two scheduled producers now issue allowances; other producers and durable operator reconciliation remain open. Migration v260 preserves unknown subscription totals in extraction rollups alongside API subtotals. The lane is shared within one brain DB, not across unrelated DBs. |
| D. Bounded feature coverage | absent | absent | partial | Actual gateway chat/expansion/OCR use the proposal path; schema/image transport and valid empty outcomes tested. `private-roles` inventories roles without claiming feature acceptance. Facts/classifiers, atoms, grading, drift, take proposals and chunk synopses now have native schemas and semantic checks; private take acceptance retains reviewer plans and reconciles canonical receipts; see the bounded-role follow-up. Other roles and full publication recovery still require fixtures and fixes. |
| E. Synthesis/pattern publication | absent | unverified | partial | Private patterns now use native proposals, v261 retained plans, stable prepared-write receipts, evidence revision checks, source-scoped provenance and partial-commit recovery. PGLite/PostgreSQL fixtures cover the pattern path. Bounded private synthesis now shares the retained-plan path, with multi-chunk completion, required summary receipts and transcript-to-pattern fixtures on both engines. Existing-page edits, full worker/crash acceptance and operator reconciliation tooling remain open; see the synthesis checkpoint. |
| F. Host-owned action loop | absent | absent | partial | Explicit `codex-host-read-v1` and `codex-host-actions-v1` jobs use sequential native proposals, scoped page reads and receipt-backed page writes. Migration v262 retains host authority; page protocol 3 preserves untrusted write semantics and fences publication against stale jobs/revisions. Fake-executable PGLite/PostgreSQL fixtures cover 41 action cases. Native tools remain false; broader reads, operator reconciliation and complete process-crash acceptance remain open. See `private-codex-actions.md`. |
| G. Diagnostics/migration | absent | absent | partial | `private-codex audit --json` is an engine-free, no-call source command, always incomplete until coverage closes. Pin migration v263 and job parking v264 have explicit previews, receipts and rollback. Queued-job previews identify drain requirements; durable fences prevent ordinary resume, and reviewed unstarted standalone jobs get new queue identities/grants. Started/ambiguous work and graph replacements require reconciliation/new workflow review. Full worker/pin inventory and operator reconciliation remain incomplete. See `private-codex-pins.md` and `private-codex-job-upgrade.md`. |

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
- A transactional subscription ledger (migration v258, identical SQL on both
  storage engines) and dispatch integration. It never expires ambiguous account
  ownership just because time elapsed. Failed attempts consume their allowance.
  Missing subscription admission cannot be replaced by a USD-only cap.
- Durable PostgreSQL background submission for standalone benchmark bootstrap:
  v285 request/job binding, immutable preflight input, strict model validation,
  fenced worker reuse of the retained proposal and review-draft writer, cross-
  workflow UUID collision checks, and queue retention of bound jobs. PGLite
  remains inline; the installed artifact is unchanged.
- Gateway chat, query expansion and OCR paths, observed through the invocation
  guard, retaining measured tokens and unknown monetary cost. Auxiliary embedding
  and reranking still use their own USD admission. No provider fallback is used.
- An engine-free route audit plus a deliberately incomplete feature inventory.
- Small extractions from config, gateway, atoms and subagent code to remain within
  the existing module/function ceilings. No ceiling was increased.

## Runtime and drift follow-up

The [runtime qualification investigation](private-codex-runtime-qualification.md)
records local build metadata and why documented hook coverage is insufficient
for pre-execution denial. A reproducible, credential-free Linux probe now checks
the host boundary, pinned ELF, inode protection, PID-namespace launch,
zero-tool request plan, synthetic PNG transport, hostile ancestor instructions,
and rejection of seven forced local calls, including a shell call with a
non-denying hook. One signed-in synthetic schema-and-image call also completed
with a valid answer and no native-action event. The local 0.162.0 binary
also settled after abort and timeout against a held credential-free mock
response, with zero tools in both requests. It passes these bounded checks
but fails production inode protection because it
is user-owned; all-path qualification is unfinished and the production registry
remains empty.
[Private drift](private-codex-drift.md) now validates native proposals and preserves
failed judgments, source scope and private report publication; its fake-executable
contract passes on PGLite and PostgreSQL. Full feature/runtime acceptance remains
incomplete.

## Take-proposal follow-up

[Private take proposals](private-codex-take-proposals.md) add whole-batch native
schema/quote validation, cache isolation and transactional proposal persistence.
Migration v265 retains host-bound source/revision/quote evidence. Failed proposals
never become empty cache entries; receipt permission failures preserve committed
proposal counts. Canonical take acceptance now retains reviewer edits and atomically
commits the proposal claim and write admission atomically before effects; retries reconcile the original receipt, including
compacted receipts and distinct writer identities. Source/revision changes refuse
before effects. Controlled interruption fixtures cover rollback and committed-write
recovery on both engines; full native process-crash acceptance remains open.

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
signal into the adapter. Migration **v259** fences each subscription job claim;
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

Linux production-hash admission now refuses root execution, mutable system
configuration or launcher parents, an untrusted `/usr/bin/unshare` or
`/usr/bin/true`, and any `/etc/codex` path. Before reserving a subscription
attempt, it probes the same unprivileged namespace options with fixed
`/usr/bin/true` and fails closed when they cannot start. The actual host check
passes on this PC, and synthetic fixtures cover denial cases. The production
launcher now places Codex in a
private PID namespace and a bounded `setsid` descendant test confirms abort
settlement through namespace teardown. The production hash allowlist is still
empty while real-runtime tool paths and wider host/process acceptance remain
unproven.

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
retained whole-proposal plan and deterministic receipt identities. Migration v261
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

## Calibration voice follow-up

The [calibration checkpoint](private-codex-calibration.md) adds native structured
voice judgments and explicit failure handling with one shared content-repair
allowance. The inventory separates profile generation, voice review and the
think A/B harness. Private profile generation now implements source-scoped
metrics, native patterns/tags, explicit CLI allowances and v266 retained receipts
with authority/revision checks. Broader calibration remains partial: think A/B,
full scheduled dispatch and live runtime qualification are unverified. Supported
judge modes are not proof of wired product surfaces. Installed status is unchanged.

## Think synthesis follow-up

The [think checkpoint](private-codex-think.md) adds native schema transport,
citation closure, scoped calibration context and explicit private failures to
`runThink`. Synthetic tests exercise the real retrieval/gateway/adapter/ledger on
PGLite and PostgreSQL. This is a synthesis checkpoint: direct CLI subscription
grants, auto-think persistence/cooldowns, private A/B trial receipts, optional
System One decisions and live runtime qualification remain incomplete. Installed
GBrain and activation are unchanged.

## Think publication follow-up

The [publication checkpoint](private-codex-think-publication.md) adds v267 retained
think plans, protocol-4 canonical page/take requests, citation transactionality,
stable replay and durable worker fences. Managed-file partial completion is
exercised on both engines. CLI subscription grants, auto-think completion,
operator recovery and process-kill acceptance remain open. Installed status and
activation are unchanged.

## Think CLI and automatic-question follow-up

[CLI allowances and automatic think](private-codex-think-automation.md) wrap the
local command in durable subscription and independent paid-retrieval limits. The
actual cycle dispatcher now includes opt-in `auto_think`; v268 retains source-bound
batches and answers, fences writes, blocks replacement of unfinished work, and
starts cooldown only after all selected answers and required saves complete.
Installed capabilities and activation remain unchanged; runtime qualification,
operator reconciliation and remaining generation coverage are incomplete.

## Calibration A/B follow-up

[Native calibration A/B trials](private-codex-think-ab.md) connect the production
think path to retained v269 comparisons and explicit atomic preference receipts.
Profile/evidence drift, failures and partial trials do not become votes. Local
CLI generation uses explicit subscription allowances; inspection and rating are
model-free. Runtime isolation, full crash acceptance, operator recovery and the
remaining generation inventory remain incomplete; nothing is installed or activated.

## Conversation-parser follow-up

[Private parser fallback](private-codex-parser.md) uses native bounded schemas,
whole-response source validation and versioned raw cache revalidation. Failed
parses stay failures in the real extraction dispatcher. Optional fallback still
requires its explicit opt-in; no separate polish caller exists. Source work does
not qualify a production Codex executable or activate the installed brain.

## Contextual-summary follow-up

[Contextual summaries](private-codex-contextual.md) now resolve Codex for direct
service calls, retain independent embedding admission, and fence publication
against job/source/cancellation changes. Native synopsis schema v2 binds prompt
and chunk evidence. Contextual job identities are v2 and require an explicit
source. Migration v270 preserves small paid charges in both accounting tables.
This is source development with isolated checks, not an installed upgrade.

## Proposal-cache follow-up

[Native proposal caching](private-codex-proposal-cache.md) adds v271 durable raw
responses in the subscription owner's database. The synopsis seam revalidates
schema, quote evidence, authority and grant lifetime on every scoped reuse;
failed calls never become cache entries or refunded attempts. LongMemEval's
durable run lifecycle, additional native roles and aggregate accounting remain
incomplete. Installed capabilities and activation are unchanged.

## Native evaluation roles

[Evaluation role contracts](private-codex-evaluation-roles.md) add native reader,
extractor and judge dispatch, validated source evidence, explicit abstention and
failure, atomic fenced fact batches, versioned receipts and honest aggregate
costs. The real keyword reader/judge benchmark retains externally supplied
admission across temporary-brain resets and fails on partial exhaustion. Full
CLI grants, fact-key preprocessing, full mixed-retrieval lifecycle and run recovery remain
incomplete; this does not change the installed artifact or activate private mode.

## Disposable benchmark target follow-up

Factory-owned in-memory targets now preserve their identity across resets and
refuse resets of subscription owners. Extraction can populate those targets
under the external host grant and transaction fence, with attempts and retained
native proposals surviving corpus replacement. Cancellation and uncertain owner
commits fail the question; this is not cross-database atomic publication or full
run/result recovery. The real keyword extraction/reader/judge path is covered by
synthetic fake-Codex fixtures. Installed GBrain remains unchanged.

## Native benchmark synopsis follow-up

Private tokenmax benchmarks now use sequential native synopses, host-retained
validated proposals, null monetary cost and independent paid embedding
admission. The real synthetic CLI fixture exercises import, synopsis publication
and hybrid vector search. Empty pages differ from missing/stale pages and
provider failures; cancellation and source/owner drift cannot complete a page.
The legacy JSONL cache and USD-only cap do not authorize native calls. Full CLI
grants and durable run recovery remain open; fact keys are covered below. Installation and live
runtime qualification are unchanged.

## Native fact-key follow-up

Both benchmark fact-key extractors now use native schemas, retained validated
proposals and canonical page snapshots. Prepared vectors publish in one fenced
temporary-database transaction with exact input hashes and unchanged source
text. Source/revision drift, cancellation or lost host ownership cannot leave a
partially published vector batch. Subscription cost remains null; embeddings
have separate durable admission. Full CLI grant creation, request binding and
run/result recovery remain incomplete. This changes source only.

## Durable benchmark result follow-up

Private benchmarks under an enclosing host grant now retain accepted reader
answers before judging and accepted judgments before JSONL emission. Leased
run ownership binds the dataset, selected questions, material options and
resolved protocol/model hashes. Recovery reuses canonical receipts; edited
JSONL files, changed inputs, stale owners and unsettled native attempts cannot
authorize another call. Completed results remain exportable after the inference
deadline. Failed private questions stop the batch immediately. The local allowance follow-up below adds direct CLI grant creation and auxiliary
budget identity. Live runtime qualification remains open; this is a source-only
migration and implementation.

## Local benchmark allowance follow-up

The actual CLI now accepts explicit subscription bounds and a separate auxiliary
USD cap. It atomically binds the allowance to the loaded evaluation request,
uses the shared job account lane, and opens the existing selected owner without
applying migrations. Named auxiliary budget identities are part of the v2 run
binding. Pure keyword retrieval and help remain owner-free. Existing identical
expired grants export receipts only. Installed configuration, services and
production data remain unchanged; live runtime qualification is still required.

## Brainstorm pipeline checkpoint

The real brainstorm/LSD dispatcher now uses native structured crosses and judges,
durable source/evidence selection, owner leases, accepted-result recovery and
protocol-5 prepared publication in strict private mode. Local CLI allowances
bind explicit attempts, turns and deadlines; auxiliary USD budgets are separate.
Judgments retain complete ID coverage, host scoring and accepted-chunk reuse.
Migration v273 is registered for both engines. Multi-fixture evaluation admission now shares one allowance across durable
fixture results, with migration v274 and the existing evaluation lease store.
Remaining producer coverage and live runtime qualification are incomplete. Installed
GBrain is unchanged. See [scope and evidence](private-codex-brainstorm.md).

## Brainstorm evaluation checkpoint

Private multi-fixture evaluation now uses strict bounded input parsing, one
aggregate subscription allowance, retained fixture identities and fenced batch
receipts. Failed fixtures cannot become grades or passing partial reports.
Details and verification: [brainstorm evaluations](private-codex-brainstorm-eval.md).
Installed services and production database remain unchanged.

## Skill-optimization judge checkpoint

Private LLM scoring now uses native bounded schemas and validated output quotes.
The actual candidate-validation gate is sequential, preflights all explicit
pins and model tiers, propagates cancellation, and cannot score failures as zero
or accept a partial task set. Deterministic rule/qrels scorers remain model-free.
Native rollout/action history, benchmark proposals, aggregate admission and
prepared skill publication remain incomplete; [details and evidence](private-codex-skillopt.md).

## Skill-optimization proposal checkpoint

The actual private reflection and one-shot rewrite entries now use native
schemas, full input snapshots, all-or-nothing semantic validation, sequential
edit composition and durable accepted-proposal reuse. Failures cannot become
empty successful proposals, and cancellation prevents a second reflection call.
This does not publish a skill or replace the legacy rollout loop. Whole-run
admission and durable optimizer publication remain work; benchmark bootstrap
now has a separate foreground/background checkpoint. [Scope and checks](private-codex-skillopt.md).
Installed GBrain is unchanged.

## Skill benchmark generation checkpoint

Both private benchmark generators now use complete native proposals with typed
rules, host-assigned IDs, exact routing coverage, strict failures and retained
proposal reuse. Unmanaged drafts preserve review and ownership guards; inputs
and output are checked for drift before writing. The guarded entry requires a
host subscription allowance and reports unknown monetary cost. Standalone
bootstrap now has immutable PostgreSQL background submission, a fenced worker
path and retained draft publication (migration v285); PGLite stays inline.
Whole-optimizer publication remains work; [scope and verification](private-codex-bootstrap-cli.md).
No deployment or activation was performed.

## Aggregate subscription admission checkpoint

Migration v275 adds parent/child subscription envelopes with one aggregate
attempt, turn and repair budget. The database enforces counter coupling and
immutable parent identity; the existing shared account lane retains unresolved
attempts. This is a dependency for durable optimizer rollout jobs, whose complete
host bindings and recovery remain work. [Scope and verification](private-codex-subscription-groups.md).
No installed database migration or activation was performed.

## Bounded subscription tree checkpoint

Migration v281 and `subscription-tree-schema.ts` add a maximum three-level
host allowance tree. `subscription-admission.ts` reserves and accepts under
root-first row locks. Counter deltas charge every ancestor atomically; failed
attempts stay charged, counter refunds are rejected, and unresolved calls retain
the lane. Historical v275 remains unchanged. No optimizer producer was granted
new authority; batch/cycle coordination is the next integration task.

Verification used fresh credential-free homes, model discovery disabled, fake
Codex executables, and disposable PGLite/PostgreSQL databases. PostgreSQL wrappers
start an isolated loopback cluster and stop it in `finally`.

| Command | Result |
| --- | --- |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=180000 test/ai/codex-think.serial.test.ts -t 'aggregate Codex subscription admission\|bounded Codex subscription tree'` | 15 passed, 81 assertions; subsequent migration-preservation case checked separately |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=180000 test/ai/codex-think.serial.test.ts -t 'migration preserves spent legacy'` | 1 passed, 5 assertions |
| `python3 /tmp/maxbrain-test-postgres-tree.py` | Same 15 cases plus 9 independent-connection admission cases: 24 passed, 125 assertions |
| `python3 /tmp/maxbrain-test-postgres-tree-upgrade.py` | Migration preservation and replay: 1 passed, 5 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=180000 test/ai/codex-gateway.serial.test.ts` | 7 passed, 23 assertions |
| `python3 /tmp/maxbrain-test-postgres-calibration-schema.py` | Catalog/replay/parity: 12 passed, 31 assertions; PgBouncer case skipped (not provisioned) |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=180000 test/ai/codex-actions.serial.test.ts -t 'durable Codex optimizer rollouts\|local CLI runs the real optimizer\|real worker completes a permanently\|actual worker publishes the bound shared'` | 22 passed, 117 assertions |
| `python3 /tmp/maxbrain-test-postgres-read-regression.py` | Same optimizer/worker regression paths on PostgreSQL: 22 passed, 117 assertions |
| `python3 /tmp/maxbrain-stream-check.py bun run build` | Passed; 3,734 modules compiled |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 passed, 0 failed; admin build explicitly skipped; typecheck included |
| `git diff --check` | Passed |

The initial native-proposal fixture had no scored input and correctly skipped
inference; supplying synthetic scored input verified actual calls. The upgrade
fixture initially used the single-statement query API for migration SQL; it now
uses the engine's real migration API. Both corrected fixtures passed. Existing
standalone admission tests also passed (8 cases).

This checkpoint does not deploy GBrain, apply production migrations, activate
private mode, prove live subscription behavior, or qualify a production Codex
runtime. Full container CI, admin UI and PgBouncer remain unverified here.

## Durable optimizer batch checkpoint

`runBatchAll` now dispatches strict private mode to the native batch coordinator.
The CLI admits foreground `--all` with explicit subscription and read scope.
Migration v282 retains the validated manifest, canonical members and owner lease
before effects. Child optimizers require persisted membership and host authority;
their existing checkpoints, rollout ledgers and publication receipts remain the
recovery mechanism. Batch completion verifies actual member results and receipt
hashes. Paid auxiliary admission remains separate; monetary cost and remaining
quota remain null.

All checks used credential-free homes, discovery disabled, fake Codex and
isolated databases. Current deterministic evidence:

| Command | Result |
| --- | --- |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=180000 test/ai/codex-actions.serial.test.ts -t 'durable Codex optimizer batch'` | Initial 9 batch cases passed, 50 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=180000 test/ai/codex-actions.serial.test.ts -t 'aggregate exhaustion retains\|cancellation between members\|lost terminal acknowledgement'` | 3 added recovery cases passed, 17 assertions |
| `python3 /tmp/maxbrain-test-postgres-batch.py` | All 12 initial batch cases passed on PostgreSQL, 67 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=180000 test/ai/codex-actions.serial.test.ts -t 'actual CLI runs two skills\|valid empty selection\|CLI dry-run checks\|lost terminal acknowledgement'` | Final manifest/receipt checks and new empty-selection case passed; dry-run fixture had an undersized selection split and was corrected separately |
| `python3 /tmp/maxbrain-test-postgres-batch-final.py` | Same final subset: 3 passed; same dry-run fixture correction required |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=180000 test/ai/codex-actions.serial.test.ts -t 'CLI dry-run checks'` | Corrected fixture and extracted CLI report: 1 passed, 3 assertions |
| `python3 /tmp/maxbrain-test-postgres-batch-dry.py` | Corrected PostgreSQL dry-run: 1 passed, 3 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=180000 test/ai/codex-actions.serial.test.ts -t 'competing SDK batch\|actual CLI runs two skills\|local CLI runs the real optimizer'` | Final root-purpose race and affected CLI regressions: 3 passed, 22 assertions |
| `python3 /tmp/maxbrain-test-postgres-batch-identity.py` | Same final identity and CLI contracts: 3 passed, 22 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=180000 test/ai/codex-actions.serial.test.ts -t 'local preflight\|local recovery refuses\|local grant identity\|local USD-only\|durable Codex optimizer rollouts\|local CLI runs the real optimizer\|real worker completes a permanently\|actual worker publishes the bound shared'` | 26 existing optimizer/worker/authority regression cases passed, 142 assertions |
| `python3 /tmp/maxbrain-test-postgres-read-regression.py` | Existing rollout, local CLI, worker and shared publication: 22 passed, 117 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=180000 test/skillopt/models-four-paths.serial.test.ts` | 8 passed, 31 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=180000 test/skillopt/batch.test.ts` | Existing discovery/slug helpers: 5 passed, 5 assertions; this suite alone does not prove batch execution |
| `python3 /tmp/maxbrain-test-postgres-calibration-schema.py` | Catalog/replay/parity: 12 passed, 31 assertions; PgBouncer skipped (not provisioned) |

The installed executable and database retain their original capabilities.
This checkout still requires the remaining producer integrations and runtime
qualification before a separately authorized deployment and activation. Full
container CI, admin UI, PgBouncer and live subscription checks remain unverified.

Final review found and fixed concurrent SDK adoption of one root as both a batch
and a standalone optimizer. Purpose checks now hold the root allowance lock.
All 15 distinct batch cases are covered across the full and focused runs on
both storage engines; final targeted reruns cover the changed claims and CLI
reporting path. Every disposable PostgreSQL cluster was stopped.

Final repository gates:

| Command | Result |
| --- | --- |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 73 passed; admin build skipped; caught two type errors and a 303-line CLI function |
| `python3 /tmp/maxbrain-stream-check.py bun run check:function-size` | Passed after extracting batch result reporting; no ceiling increased |
| `python3 /tmp/maxbrain-stream-check.py bun run typecheck` | Passed after final source and fixture fixes |
| `python3 /tmp/maxbrain-stream-check.py bun run check:regen-all` | All 12 generated artifacts fresh |
| `python3 /tmp/maxbrain-stream-check.py bun run build` | Passed on final source; 3,739 modules compiled |
| `git diff --check` | Passed |

The failed verify checks were rerun individually after correction; the complete
battery was not redundantly rerun. Final inference and lease checks cover the
root-lock change, and the no-call CLI contract covers the reporting extraction.

## Scheduled optimizer cycle checkpoint

Implemented the private `runPhaseSkillopt` branch through the existing retained
batch coordinator. The real cycle dispatcher threads explicit source and job
deadline. New trusted configuration binds the source, directory, permitted reads
and per-skill limits. Migration 268 retains the frozen selection, source
incarnation and completion receipt hash. Only verified batch completion earns
the source-scoped success cooldown. Preflight failures have a separate 24-hour
error cooldown; partial or ambiguous batches stay pending and block new roots.

This reuses the pre-existing batch, optimizer, rollout, ledger and publication
implementation. New code is in `skillopt/codex-cycle{,-config,-context,-store,-schema}.ts`,
with small changes to the cycle dispatcher, batch selection check and root
purpose guards. Failed or unavailable configuration is reported explicitly.
Cycles retain null subscription cost/quota and inherit independent paid auxiliary
admission. Feature flags and the legacy API path retain their existing behavior.

| Plane | Before | After |
| --- | --- | --- |
| Installed executable/services | Older installed artifact; worker planes incomplete | Unchanged; not deployed or activated |
| Scheduled source path | Legacy optimizer wrapper lacked native scope/admission | Native retained selection, bounded batch and receipt-backed completion |
| Verification | No native scheduled-cycle contract | Real dispatcher/queued handler and fake-executable contracts on both engines |
| Runtime | No qualified production Codex runtime | Still unqualified; no live calls or auth changes |

The new shared fixture contains 12 distinct cycle cases: real dispatch and
cooldown, default-off/dry-run, USD-only/conflicting authority, unreadable flag,
preflight error cooldown, concurrent preflight failure, partial file publication,
lost completion acknowledgement, lost selection acknowledgement/direct rollout
adoption, exhaustion/incarnation mismatch, real queued maintenance failure stamp,
and cancellation/deadline. Both engines execute these across the initial and
focused runs. A first fixture attempted to rewrite a referenced source incarnation
and correctly hit a storage FK; it was corrected to represent a retained earlier
incarnation without rewriting unrelated source guards. An initial TypeScript
nullability error was also corrected.

All commands below run in the development checkout. The wrappers create fresh
homes, disable discovery, remove credentials and use only the qualified fake
Codex executable. PostgreSQL wrappers provision disposable local databases and
stop their servers afterward. No installed database is used.

| Command | Result |
| --- | --- |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-actions.serial.test.ts -t 'scheduled native Codex optimizer cycle' --timeout=240000` | Initial 8 passed; 1 fixture FK failure, subsequently corrected |
| `python3 /tmp/maxbrain-test-postgres-cycle.py` | Same initial 8 passed and fixture FK failure |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-actions.serial.test.ts -t 'exhausted runs stay pending' --timeout=240000` | Corrected fixture: 1 passed, 7 assertions |
| `python3 /tmp/maxbrain-test-postgres-cycle-repair.py` | Corrected fixture: 1 passed, 7 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-actions.serial.test.ts -t 'lost selection acknowledgement\|durable Codex optimizer rollouts\|actual CLI runs two skills' --timeout=240000` | 21 passed, 110 assertions |
| `python3 /tmp/maxbrain-test-postgres-cycle-regress.py` | Same 21 passed, 110 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-actions.serial.test.ts -t 'unavailable feature configuration' --timeout=240000` | 1 passed, 3 assertions |
| `python3 /tmp/maxbrain-test-postgres-cycle-config.py` | Same 1 passed, 3 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/skillopt/cycle-phase-caps.serial.test.ts --timeout=180000` | Legacy mocked cycle behavior: 15 passed, 78 assertions; separate process |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/skillopt/models-four-paths.serial.test.ts --timeout=180000` | Existing routing: 8 passed, 31 assertions; separate process |
| `python3 /tmp/maxbrain-test-postgres-calibration-schema.py` | 12 passed, 31 assertions; PgBouncer skipped; all four catalog snapshots refreshed and rechecked |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 passed, 0 failed; admin build skipped |

Final review also fenced the interval between selection and batch creation:
once a concurrent preflight failure settles the selection, a caller that already
prepared files cannot adopt it. Missing retained selection cannot report successful
completion. Focused final tests and build gates are recorded below.

| Final command | Result |
| --- | --- |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-actions.serial.test.ts -t 'real cycle dispatcher completes\|invalid benchmarks earn\|concurrent preflight failure\|lost selection acknowledgement' --timeout=240000` | 4 passed, 33 assertions |
| `python3 /tmp/maxbrain-test-postgres-cycle-fence.py` | Same 4 passed, 33 assertions |
| `python3 /tmp/maxbrain-stream-check.py bun run typecheck` | Passed on final source and fixtures |
| `python3 /tmp/maxbrain-stream-check.py bun run check:function-size` | Passed; no ceiling raised |
| `python3 /tmp/maxbrain-stream-check.py bun run check:module-size` | Passed |
| `python3 /tmp/maxbrain-stream-check.py bun run build` | Final source compiled: 3,745 modules |
| `python3 /tmp/maxbrain-stream-check.py bun run check:regen-all` | All 12 generated artifacts fresh |
| `git diff --check` | Passed |

The complete verify battery preceded the last configuration/fencing refinements;
focused final checks cover those changes instead of repeating unrelated suites.

Installed capabilities remain unchanged. Before upgrade, remaining dispatch and
runtime qualification gaps must be closed, an artifact built from the verified
revision, and deployment/production migration/service restart authorized.
The new migration is registered for both supported engines but has only been
applied to disposable tests. The feature remains off by default. Full container
CI, admin UI, PgBouncer and live subscription acceptance remain unverified.

## Queued optimizer batches

`skillopt --all --background` now preflights selected benchmarks before one job
is submitted. Migration 269 binds the request, payload and job; the worker checks
the host lease and retained per-skill hashes before using the existing batch
coordinator. Retries reuse the job and child receipts. PGLite keeps its inline
path because it has no worker daemon.

The fake Codex PostgreSQL contract completed two queued skills with 132 attempts,
then replayed the batch without extra calls. It also rejects malformed input
before enqueue and changed benchmark data before optimizer admission. Existing
single-skill queue recovery regressions passed on PGLite. Migration, installation
and activation on the installed brain remain unperformed.

## Public queued batch replay correction

The public trusted batch producer now re-preflights current skill and benchmark
content before returning a previously bound job. A changed input under the same
request UUID fails with `subscription_identity_conflict`; the regression checks
that it creates no second job and invokes no fake Codex process. Related contract
expectations now reflect supported private batch flags and assert a scoped
listing contains the requested page when other authorized fixture pages exist.
Cancellation testing invokes GBrain's registered handler directly so it does
not deliver a synthetic process-wide SIGINT to Bun.

| Check | Result |
| --- | --- |
| PostgreSQL changed-input replay regression | Not run in this integration checkout; no PostgreSQL server is available |
| Four corrected PGLite Codex contract cases with fake executable | 4 passed, 29 assertions |
| Focused PGLite optimizer job contract | 16 passed, 58 assertions; PostgreSQL-only cases skip on PGLite |
| `bun run typecheck` | Passed |
| `git diff --check` | Passed |

This does not close the full dispatch/runtime audit. Installed GBrain remains
unchanged, unqualified and inactive.
