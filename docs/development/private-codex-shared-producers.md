# Shared optimizer CLI and worker checkpoint

Say to your agent: “Check an approved shared skill's exact catalog revision,
preview native optimization with explicit limits, then run the same reviewed
request and preserve its publication receipt.” This describes the development
checkout. Production runtime qualification and deployment are still pending;
installed GBrain and its configuration have not changed.

## Explicit shared target

The private single-skill CLI now accepts:

| Flag | Meaning |
|---|---|
| `--shared-skill` | Use canonical shared publication. |
| `--source ID` | Select the source through the existing resolver. |
| `--source-incarnation UUID` | Bind the catalog's exact source incarnation. |
| `--pack-id ID` | Select the catalog pack. |
| `--expected-revision UUID` | Preserve the original revision compare-and-swap. |
| `--codex-request-id UUID` | Identify both the optimizer allowance and canonical publication. |
| `--read-prefix PREFIX` | Explicit page-read scope; repeat for additional prefixes. |
| `--codex-max-attempts N`, `--codex-max-turns N`, `--codex-deadline UTC` | Bound the entire optimizer and its child evaluations. |

Existing benchmark, holdout, training, no-mutate and bundled-skill controls remain.
The canonical owner's skills directory is selected when `--skills-dir` is absent;
an explicit directory must still match that owner. Missing, duplicated or invalid
shared target flags refuse. The feature requires explicit private configuration.
No current revision or broader read scope is inferred from model output.

`--dry-run` validates without creating an allowance, queue job or shared plan,
and without inference or canonical writes. The shared semantic preflight checks
benchmark parsing, task counts, splits, holdouts, native scope, training bounds,
model pins, strict model provenance and effective output caps before admission.
A malformed benchmark cannot leave an unused allowance behind.

Foreground execution returns the shared publication receipt in JSON. Repeating
the same request and unchanged controls returns retained results. Keep the
original request UUID, limits, absolute deadline and target for recovery. A new
UUID is a new allowance; the CLI does not reset an exhausted request for you.

## Background execution

On PostgreSQL, `--background` submits through the existing durable native producer.
PGLite keeps its inline behavior. The distinct
`codex-shared-skillopt-workflow-v1` payload binds the original shared target,
approved closure, evaluation bytes, controls, effective model settings and output
cap. Host-selected staging location is excluded from this queue identity, while
the actual worker's retained plan binds its own private staging location.

Submission uses the existing migration-258 permanent request/job identity and
atomic queue/allowance admission. The worker reconstructs scope only from the
application-authorized stored payload and its current claim. It compares the
complete submitted identity before granting optimizer ownership or inference.
Changing inputs, limits, target or effective settings refuses. A shared payload
cannot be downgraded to the earlier unmanaged protocol or executed directly
without its authorized host scope.

The migration-259 shared optimizer plan and publication protocol 6 carry the
worker fence into the canonical write transaction. A replacement worker reuses
acknowledged evaluations and rebinds ownership. Committed effects remain visible
after a lost worker acknowledgement; recovery reuses the same request and receipt.
Failed or exhausted work stays failed, with null subscription monetary cost and
no provider fallback. Repeating submission returns the existing job; it does not
silently restart a dead/cancelled job or reset counters.

## Verification

`test/helpers/codex-shared-optimizer-producers.ts` extends the existing shared
fixture with real CLI, queue, worker, optimizer and canonical writer paths.
Fixtures use synthetic catalog data, fake qualified Codex executables, fresh
isolated databases/homes, absent credentials, disabled discovery and a network
tripwire. PostgreSQL clusters are stopped after testing.

Initial producer cases passed on both engines: nine tests, 44 assertions on
PGLite and 45 on PostgreSQL (the latter executes the queued CLI job). A final
malformed-benchmark case proves zero calls, zero plans and zero CLI allowances.
Commands and completed checks:

- `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-actions.serial.test.ts --timeout=180000`: full PGLite action/optimizer regression, 113 passed, 535 assertions before the final effective-cap case.
- `python3 /tmp/maxbrain-test-postgres-group-actions.py`: the same full regression on disposable PostgreSQL, 113 passed, 536 assertions; the cluster stopped after testing.
- Final effective-cap drift: the same isolated command with `-t 'changed effective output limits'`, plus `python3 /tmp/maxbrain-test-postgres-shared-cap.py`: one passed, four assertions on each engine.
- Isolated `bun test test/skillopt/models-four-paths.serial.test.ts --timeout=180000`: eight legacy cases passed, 31 assertions.
- `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify`: 75 passed, zero failures, admin UI build explicitly skipped.
- `python3 /tmp/maxbrain-stream-check.py bun run typecheck`: passed after final source/test edits.
- `python3 /tmp/maxbrain-stream-check.py bun run build`: compiled 3,725 modules. `bun run check:doc-history` and `git diff --check` passed.

The full container CI, admin UI and PgBouncer gates were not run in this checkpoint.

These are deterministic exception/fencing tests. They do not establish OS
process-kill recovery, live subscription behavior or native runtime qualification.

## Remaining scope and upgrade

Cycle, batch/fleet, standalone bootstrap and remote producers, broader read tools
and full live acceptance remain incomplete. Paid auxiliary execution still needs
independent authorization; the enabled scoped page-read registry makes no such
calls. No new schema migration is required beyond the existing head, **244**.

Deployment remains separate: build this source, migrate the intended database
through registered migrations, drain/park legacy jobs and cut over compatible
consumers after qualification and acceptance. Existing workers must not silently
reinterpret shared native payloads. No production inference, migration, install,
service restart, GitHub push or activation was performed for this checkpoint.
