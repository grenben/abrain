# Native optimizer background-job checkpoint
> **Historical checkpoint:** This document describes the private 0.60.317.0 source lineage, not validation or activation of the upstream synchronization. Private migrations v261–v290 are being ported as v315–v344; integration remains in progress.

The private single-skill CLI can now submit a durable optimizer job on PostgreSQL.
PGLite retains the existing inline behavior because it has no worker daemon.
This is source implementation and deterministic verification; installed services
and their configuration have not changed.

## Submission and execution

`--background` uses the same explicit Codex attempt/turn/deadline flags, request
UUID, source and read prefixes as foreground execution. `--follow` requires
background mode. Dry-run creates no job or allowance. Benchmark bootstrap is
also supports PostgreSQL background submission through its own immutable input
plan and fenced worker publication. PGLite keeps bootstrap inline because it has
no worker daemon.

`submitCodexSkillOpt` reconstructs the real job options and calls the shared
`prepareCodexSkillOpt` preflight. It validates the complete input, model pins,
benchmark and publication guards before queue insertion. Absolute file paths,
file snapshots, directory identity, source incarnation, models/runtime and tool
permissions feed the immutable workflow hash. Only application-authorized local
jobs may use this producer; remote grants are not inferred from job data.

Registered migration **263** adds `codex_skillopt_submissions`. One transaction
binds the request UUID, workflow/payload hashes, queue job and root subscription
allowance. Repeating the request returns the same job, including after submission
acknowledgement loss. Changed limits or inputs refuse. An existing queue row
without a permanent submission cannot be adopted through coalescing. The same
UUID cannot switch between foreground and background admission to obtain a new
allowance. Repeated submission reports the existing status; it does not silently
restart a dead/cancelled job or reset its counters.

The actual worker registration passes its original `MinionJobContext` to
`runSkillOptJob`. The handler requires the current subscription publication fence,
application submission authority and permanent payload binding before rebuilding
its local operation context. The optimizer checks the queued workflow hash before
claiming progress or starting inference. A changed skill/benchmark/source/pin
cannot become a different run under the same job.

Each optimizer job is a root subscription allowance. Its existing per-task child
jobs consume that root's aggregate attempts/accepted turns. Root worker leases,
shutdown/cancellation signals and authority checks remain in force at every child
call, checkpoint and publication. A stale worker cannot continue or publish.
Unresolved inference retains the account lane and blocks recovery. Exhaustion
throws; it does not become a grade, no-improvement result or API fallback.

The current native registry allows scoped `get_page` only and performs no paid
embedding/reranking. Subscription result costs are null. Background paid auxiliary
execution remains denied without the separate existing job spend authorization;
a stored CLI auxiliary-cap value alone does not grant it. Broader tool support
must integrate those budgets before enabling such calls.

## Recovery and storage

The workflow stores its accepted result before filesystem effects. Retrying after
a committed file write with a lost SQL acknowledgement reconciles the exact
accepted bytes and retains the same job/history. This is recoverable per-file
publication, not a transaction spanning the filesystem and database.

The permanent binding has a restrictive job foreign key. Queue prune/remove
operations skip bound optimizer jobs as well as their already-retained rollout
jobs. Unrelated terminal jobs remain removable. A future archival protocol is
needed before these recovery records can be deleted safely.

Legacy/unversioned private optimizer payloads fail preflight; they are not
silently interpreted as the new workflow. Drain them under their original mode,
or explicitly park/resubmit with a fresh reviewed native request and scope.
Existing non-private model resolution and execution remain available.

## Deterministic evidence

Shared contracts use fresh synthetic state, fake qualified executables, no
credentials, disabled discovery and a network tripwire. Disposable PostgreSQL
clusters are stopped after every run. No production migration was applied.

- `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-actions.serial.test.ts -t 'native optimizer background jobs' --timeout=180000`: initial nine cases passed, 46 assertions.
- `python3 /tmp/maxbrain-test-postgres-optimizer-job.py`: same nine cases/assertions on PostgreSQL.
- Final producer-mode boundary: `bun test test/ai/codex-actions.serial.test.ts -t 'one request UUID cannot switch'` through the isolated wrapper and `python3 /tmp/maxbrain-test-postgres-optimizer-job-mode.py`: one additional case passed, 5 assertions on each engine.
- `python3 /tmp/maxbrain-test-postgres-calibration-schema.py`: migration/catalog replay parity, 12 passed, 31 assertions; PgBouncer skipped.
- Isolated legacy `test/skillopt/models-four-paths.serial.test.ts`: 8 passed, 31 assertions; `test/skillopt/bootstrap-from-skill.test.ts`: 20 passed, 48 assertions.
- Full shared contract before the final mode-boundary addition: `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-actions.serial.test.ts --timeout=180000` and `python3 /tmp/maxbrain-test-postgres-group-actions.py`: 90 passed, 410 assertions on each engine. The additional boundary case was verified separately as above.
- `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify`: 75 passed, 0 failed; admin UI build explicitly skipped. Includes typecheck, architecture/size/registry and generated-schema gates.
- `python3 /tmp/maxbrain-stream-check.py bun run build`: development executable compiled; `bun run check:doc-history` and `git diff --check` passed. Full container CI, PgBouncer and live checks were not run.

Fixtures exercise real worker execution, CLI submission/inline routing, changed
files/limits, forbidden pins, direct-handler refusal, old/new worker fencing,
committed-effect recovery, exhausted and unresolved calls, submission loss and
retained identity under pruning. Process-kill and live inference acceptance are
not established by these fault-injection tests.

## Remaining scope and upgrade

Managed shared-skill staging/prepared-publication recovery, cycle, remote
producers and broader tool registries remain work.
Production runtime qualification is still empty. Installation requires a separate
authorized build/install and migration/worker cutover after remaining gates pass.
This checkpoint leaves the installed GBrain unchanged.
