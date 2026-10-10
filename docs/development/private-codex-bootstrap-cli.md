# Standalone Codex benchmark bootstrap

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
Changing the inputs or limits refuses; the same UUID cannot switch to foreground
or background optimization. No automatic fresh allowance or provider fallback
is created when a request exhausts its limits.

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

- PGLite: `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-think.serial.test.ts --timeout=180000 -t 'native skill benchmark generation|native standalone bootstrap admission'` — 40 passed, 174 assertions.
- Final PGLite additions: the same isolated command with `-t 'native standalone bootstrap admission'` — 16 passed, 82 assertions, including expiry and source-incarnation boundaries.
- PostgreSQL: `python3 /tmp/maxbrain-test-postgres-bootstrap-local.py` — final combined suite: 43 passed, 187 assertions; disposable server stopped afterward.
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

Migration 265 is registered for PGLite and PostgreSQL; it has only been applied to
isolated test databases here. A later authorized deployment must build this source,
apply registered migrations to the intended target, and update compatible consumers.
Keep plans and accepted drafts for reconciliation; a binary rollback does not
authorize deleting their durable records. Production Codex runtime qualification
and bounded live acceptance must pass before activation. No installation, service
restart, credential change, production migration or live inference was performed.
