# Native optimizer CLI admission checkpoint
> **Historical checkpoint:** This document describes the private 0.60.317.0 source lineage, not validation or activation of the upstream synchronization. Private migrations v261–v290 are being ported as v315–v344; integration remains in progress.

The single foreground `gbrain skillopt` command now supplies the explicit host
grant and local read scope required by the native optimizer workflow. This is
source development, not an installed upgrade or live subscription verification.

## Admission and recovery

In strict private mode the command requires all three native limits:
`--codex-max-attempts`, `--codex-max-turns`, and `--codex-deadline` (ISO UTC).
The attempt limit is 1–1000, accepted turns cannot exceed it, and a new deadline
must be within 24 hours. These limits apply to the entire optimizer and its
child evaluations. They do not describe the provider's remaining quota.

`--source ID` and one or more `--read-prefix slug-or-prefix/*` flags explicitly
authorize the benchmark's reads. The current host registry permits only
`get_page`. Source resolution uses the existing resolver and the workflow binds
the source incarnation. Skill files and benchmark content cannot widen that scope.

`--codex-request-id UUID` identifies recovery; if omitted, the CLI generates one
and reports it after the grant/input transaction commits. Reuse that ID, the
original limits, source, prefixes, files and optimizer options on a retry.
Completed work returns its retained receipt/draft without more inference.
Changed limits, source, prefixes or auxiliary cap are refused. Legacy `--resume`
is a different protocol and is not accepted by this private producer.

The durable allowance is created in the same transaction as the validated input
binding. Invalid models, invalid files and dry-run do not create unused grants.
Dry-run still requires the explicit limits/scope but sends no inference. An
existing identical expired allowance can recover an already completed receipt;
it cannot admit new calls. SIGINT/SIGTERM cancel the host scope, retaining
acknowledged progress; the existing adapter owns process termination settlement.

Ordinary `--max-usd` never grants subscription calls. Subscription monetary cost
and remaining quota stay null/unknown. `--aux-max-usd` is separately bound to the
run and enforced by the existing durable auxiliary budget guard; the current
page-read registry makes no embedding/reranking calls.

## Verification

Fresh synthetic files/pages and fake Codex executables exercise the actual CLI,
optimizer, child job handlers, durable history and publication. Discovery is
disabled, credentials are absent, and the shared fixture forbids network calls.

- PGLite: `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-actions.serial.test.ts --test-name-pattern 'local (CLI|preflight|recovery|grant|USD|cancellation)' --timeout=180000`: 6 passed, 39 assertions.
- PostgreSQL: `python3 /tmp/maxbrain-test-postgres-optimizer-cli.py`: same 6 passed, 39 assertions; disposable cluster stopped.
- Legacy dispatch: `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/skillopt/models-four-paths.serial.test.ts --timeout=30000`: 8 passed, 31 assertions.
- CLI flag registry regenerated with `bun run build:flag-registry`.
- `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify`: 75 passed, 0 failed, admin UI build explicitly skipped.
- `python3 /tmp/maxbrain-stream-check.py bun run typecheck`: passed.
- `python3 /tmp/maxbrain-stream-check.py bun run build`: compiled 3,712 modules into the development executable.
- `git diff --check`: passed. Full container CI, PgBouncer and live runtime checks were not run.

Cases cover complete CLI execution/replay, no-effect preflight/dry-run, changed
limits/scope refusal, checkpoint acknowledgement loss, missing/invalid grants,
unsupported producers, and cancellation/recovery with signal-handler cleanup.
No schema migration is added by this checkpoint.

## Remaining work

The subsequent [background-job checkpoint](private-codex-skillopt-jobs.md) adds
permanent CLI request/job binding and worker execution. Cycle, batch/fleet,
standalone bootstrap and remote producers still need their own admission/recovery integration. Shared canonical
skill publication recovery and broader read tools remain incomplete. Private
flags refuse unsupported producer modes rather than creating an allowance they
cannot safely consume. Existing non-private dispatch remains unchanged.

No installed executable, production database, service or pin was changed.
Runtime qualification, live checks, installation and activation remain pending.
