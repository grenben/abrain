# Standalone Codex benchmark bootstrap
> **Historical checkpoint:** This document describes the private 0.60.317.0 source lineage, not validation or activation of the upstream synchronization. Private migrations v261–v290 are being ported as v315–v344; integration remains in progress.

Say to your agent: “Generate a review draft for this skill with an explicit Codex
allowance, and recover the same request if interrupted.” This checkpoint describes
development source. Installed GBrain and private activation remain unchanged.

## Admission and output

The private `skillopt --bootstrap-from-skill` and `--bootstrap-from-routing`
branches now accept the existing explicit local allowance flags:
`--codex-request-id`, `--codex-max-attempts`, `--codex-max-turns` and
`--codex-deadline`. The existing source and read-prefix requirements remain;
benchmark generation itself executes no model tools. USD-only caps cannot grant
subscription calls. Monetary cost and remaining subscription quota stay unknown.

Before creating a grant, the real CLI validates bounded regular-file snapshots,
model routing, task counts, routing intents and publication authority. Dry runs
create no grant or plan. Shared managed benchmark publication remains unsupported;
the result is an unmanaged draft requiring human review before evaluation.

Migration **265** retains immutable input identity, original file contents,
source incarnation, model/bin selection, allowance controls, accepted output and
completion state. Each request gets fenced ownership with a renewable lease.
Migration **270** binds a standalone background bootstrap request to its
application-authorized `skillopt` queue job. On PostgreSQL, `--background`
prevalidates the files and persists the immutable plan before returning the job
ID; the worker rechecks the same plan before inference and draft publication.
PGLite remains inline because it has no worker daemon. Repeating an unchanged
background request returns the same job; changed files, limits or request
purpose refuse. No automatic fresh allowance or provider fallback is created
when a request exhausts its limits.

## Recovery and failures

The complete validated draft is persisted before file effects. Publication checks
source incarnation, current private routing, owner lease and original files, and
uses the existing unmanaged writer guard and bounded durable file writer. Native
bootstrap writers share the optimizer's per-path advisory lock.

Files and SQL are not a single atomic transaction. If the draft was written but
the terminal SQL update rolled back, retrying the unchanged request recognizes
the exact accepted bytes and records completion without regeneration or `--force`.
An unrelated edit is preserved and refused. Lost accepted-result acknowledgement
reuses the retained native proposal. Recovery never silently reviews a draft.

Cancellation after acceptance prevents publication and retains recoverable work.
A replacement owner fences the stale caller. Missing completion remains unresolved
and blocks another attempt; releasing the workflow lease does not settle its
account attempt. Malformed proposals and exhaustion are explicit failures, never
successful empty benchmarks. CLI JSON errors preserve the native failure code. An expired allowance can reconcile
an exact already-written draft, but cannot publish an accepted unwritten draft.

## Deterministic verification

Fixtures use fake Codex executables, synthetic files, fresh isolated homes and
databases, disabled discovery, absent credentials and forbidden-network checks.
Unless identified as the v288 integration check, the counts below describe the
old-source checkpoint and have not been rerun against this integration branch.

- PGLite: `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-think.serial.test.ts --timeout=180000 -t 'native skill benchmark generation|native standalone bootstrap admission'` — 40 passed, 174 assertions.
- Final PGLite additions: the same isolated command with `-t 'native standalone bootstrap admission'` — 16 passed, 82 assertions, including expiry and source-incarnation boundaries.
- v288 integration, background CLI/job contract on isolated PGLite: `bun test test/ai/codex-actions.serial.test.ts -t 'background Codex benchmark bootstrap jobs'` — 5 passed, 24 assertions; CLI refuses background mode on PGLite, while producer/worker behavior uses fake Codex and no inference during admission.
- Background CLI/job contract on a disposable PostgreSQL cluster on the old-source branch: 5 passed, 25 assertions; the PostgreSQL path remains unverified in this integration checkout.
- PostgreSQL: `python3 /tmp/maxbrain-test-postgres-bootstrap-local.py` — final combined suite: 43 passed, 187 assertions; disposable server stopped afterward.
- Background queue submission, worker publication, same-request replay and changed-file refusal are covered by `test/helpers/codex-bootstrap-job-contract.ts` in the shared PGLite/PostgreSQL action contracts.
- `python3 /tmp/maxbrain-test-postgres-calibration-schema.py` — fresh catalog parity and migration replay: 12 passed, 31 assertions; PgBouncer case skipped.
- `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` — 75 passed, zero failures, admin build explicitly skipped; includes typecheck and architecture/registry checks.

Full action/optimizer regression on PGLite:
`python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=180000 test/ai/codex-actions.serial.test.ts`
— 114 passed, 539 assertions. The PostgreSQL counterpart,
`python3 /tmp/maxbrain-test-postgres-group-actions.py`, passed 114 tests and
540 assertions; its isolated server stopped afterward.

Additional legacy regressions ran separately to avoid module-mock contamination:
`test/skillopt/bootstrap-from-skill.test.ts` passed 20 tests (48 assertions), and
`test/skillopt/models-four-paths.serial.test.ts` passed eight (31 assertions).
`python3 /tmp/maxbrain-stream-check.py bun run build` compiled 3,729 modules.

The test helper is `test/helpers/codex-bootstrap-local-contract.ts`. Exception and
lease tests do not prove operating-system process-kill recovery or live runtime
isolation. The full container CI, admin UI and PgBouncer gates remain unverified.

## Upgrade boundary

Migration 268 is registered for PGLite and PostgreSQL; it has only been applied to
isolated test databases here. A later authorized deployment must build this source,
apply registered migrations to the intended target, and update compatible consumers.
Keep plans and accepted drafts for reconciliation; a binary rollback does not
authorize deleting their durable records. Production Codex runtime qualification
and bounded live acceptance must pass before activation. No installation, service
restart, credential change, production migration or live inference was performed.
