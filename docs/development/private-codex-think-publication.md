# Private Codex think publication checkpoint

Say to your agent: “Verify private think saves and take writes in isolated tests,
including partial completion and worker takeover. Keep my installed brain unchanged.”

## Scope and status

This extends the validated think synthesis at source commit `9a4bd3e`.
It is source development, behind trusted private configuration. No live inference,
installation, production migration, service restart or activation was performed.
The production Codex runtime qualification registry remains empty.

| Area | Before | Source now | Installed / live |
|---|---|---|---|
| Think save | Page and citation writes were separate; no retained request | Frozen answer and admissions, page/citations/provenance in one coordinated commit | Unchanged / unverified |
| Think take | Legacy write helper, no retained plan | Prepared canonical take write and stable receipt | Unchanged / unverified |
| Partial completion | Caller could regenerate or duplicate work | Same run/question returns the retained result; committed receipts are reused | Unchanged / unverified |
| Worker ownership | No durable think publication fence | Original job identity/lease checked at admission and commit | Unchanged / unverified |
| Protocol | Page protocols 1 and 3 | Protocol 4 permits only retained think page/take requests; old consumers refuse it | Not migrated |
| CLI source selection | Take write omitted the selected source | Selected source reaches the take helper | Not installed |

## Implemented behavior

`think/publication.ts` retains plans only when the trusted caller requests save
or take. Ordinary read-only think does not create publication records. It binds
brain storage, source incarnation, input options, model, original authority,
retrieved page revisions and take fingerprints. Changed inputs under the same
run/question identity fail. Private evidence produces a private synthesis;
a world-held take cannot carry private evidence.

All actions pass the existing read-only page/take preparation before the plan
is accepted. This catches known content, fence and canonical-file refusals before
any write. Each effect prepares and checks again under the existing coordinator.
Prevalidation does not promise that a two-write plan commits atomically.

Migration **v282** adds `codex_think_publications`, with fresh-schema and migration
parity for PostgreSQL and PGLite. The host generates the plan and request UUIDs.
The normalized journal intent carries a reserved plan reference; callers cannot
supply it through the normal page operation. Protocol 4 validates the exact
retained admission and original grants, including when private configuration
has subsequently been disabled.

`publication-execute.ts` marks admission and inserts the journal request in the
same transaction. If admission is recorded but its receipt is missing, it stops
with `write_pending` for reconciliation. It never creates a replacement request.
Concurrent callers converge on the same receipts. Save precedes take when both
are requested. The plan becomes complete only after every required receipt says
committed. Cancellation or an expired allowance does not erase committed receipts.

`publication-prepare.ts` applies synthesis content, citation rows and source-scoped
`derived_from` links in the same coordinator transaction. The canonical file,
reverse-write handling, effect queue and indexing debt remain owned by the existing
persistence system. Page commitment is not a claim that asynchronous indexing or
Git effects have finished. A subsequent take can commit separately; recovery uses
the retained answer and original request IDs.

Worker subscription contexts now carry a durable job fence. A replaced, expired
or changed worker cannot admit or commit pending writes. A new worker can inspect
committed receipts; automatically rebinding an unfinished plan to a new lease is
not implemented. Unsettled work requires reconciliation, not a fresh model answer.

## Deterministic evidence

The shared `test/helpers/codex-think-contract.ts` exercises real retrieval,
gateway, fake executable, retained plans, journal, consumer, coordinator and
managed files. Fresh homes, synthetic content, disabled discovery and a network
tripwire exclude real credentials and inference.

Checks cover native transport and semantic failures, unchanged legacy think
behavior, concurrent publication, changed input/source/evidence, missing receipts,
cancellation, expired allowances, citation rollback, stale workers before admission
and after preparation, private-mode removal, whole-plan file prevalidation and
page-then-take recovery without another inference call.

All commands ran in a scrubbed, credential-free environment with `TMPDIR=/var/tmp`.
PostgreSQL used a newly initialized local cluster with a disposable test database;
the harness stopped it in its cleanup block.

| Command | Result |
|---|---|
| `bun test --timeout=60000 test/ai/codex-think.serial.test.ts` | 35 passed, 112 assertions |
| `bun test --timeout=240000 test/e2e/codex-think.test.ts` | 35 passed, 112 assertions, cluster stopped |
| `bun test --timeout=60000 test/think-persist-take.test.ts test/think-save-source.test.ts test/think-pipeline.test.ts test/think-with-calibration.test.ts test/think-quote-verify.test.ts test/think-gateway-adapter.test.ts test/think-envelope-salvage.test.ts` | 113 passed, 292 assertions |
| `bun test --timeout=60000 test/ai/codex-actions.serial.test.ts` | 41 passed, 161 assertions |
| `bun test --timeout=240000 test/schema-catalog-golden.test.ts test/schema-migrations-replay.test.ts test/schema-bootstrap-coverage.test.ts` | 29 passed, 163 assertions |
| `bun test --timeout=240000 test/e2e/schema-catalog-golden.test.ts test/e2e/schema-migrations-replay.test.ts` | 12 passed, 31 assertions, 1 PgBouncer skip |
| `GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 passed, 0 failed, 1 admin-build skip; includes typecheck and architecture/size/registry/docs gates |
| `bun run build` | Passed, 3,636 modules; checkout artifact only |
| `git diff --check` | Passed |

Catalog goldens were deliberately regenerated with `GBRAIN_TEST_UPDATE_GOLDENS=1`
for each engine, inspected for the new table and protocol guard, then tested with
updates disabled. No existing migration or size ceiling was changed.

Discrimination: `bash scripts/check-test-discriminates.sh test/ai/codex-think.serial.test.ts src/core/think/codex.ts`
restored the `9a4bd3e` dispatcher temporarily and produced **25 pass / 10 fail**.
The developed dispatcher was restored. The final passing suite also adds the
whole-plan canonical-file refusal checks.

Initial development failures caught a missing canonical fixture file, a missing
fixture queue claim-generation increment, and transient source syntax/import
errors. They were corrected before final verification. PgBouncer and the admin
build (which requires an external dependency fetch) remain unverified; full CI and
process-kill acceptance were not run. Logs are local development evidence, not
runtime or installed-artifact qualification.

## Remaining work and upgrade handoff

Direct CLI grants and automatic-think batch completion are covered in the
[subsequent automation checkpoint](private-codex-think-automation.md). Calibration
A/B trials and the remaining generation roles are unfinished work. Full process-kill coverage, lease-rebinding/operator recovery,
broader federated evidence/lineage review and real runtime isolation remain open.

After deployment authorization and the remaining acceptance gates: build the
verified branch, back up the actual database, apply registered migrations through
v282 using the installation's migration procedure, upgrade every consumer and
restart the actual services. Do not activate strict private mode until the runtime
has passed bounded authorized live schema/image, maintenance, action recovery and
cancellation checks. The installed GBrain retains its original capabilities.
