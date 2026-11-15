# Private Codex optimizer rollout checkpoint
> **Historical checkpoint:** This document describes the private 0.60.317.0 source lineage, not validation or activation of the upstream synchronization. Private migrations v261–v290 are being ported as v315–v344; integration remains in progress.

Implemented in source; installed GBrain is unchanged. This checkpoint adds
durable scoped read evaluations. Whole-optimizer activation remains incomplete.

The later [workflow checkpoint](private-codex-skillopt-workflow.md) adds the native
optimizer algorithm, durable progress and unmanaged file-publication recovery.

## Production path

`runRollout` selects `runCodexRollout` in strict private mode. It requires a
trusted local operation context, source, enclosing root subscription allowance,
and explicit `codex` invocation ID/tool/prefix grant. The initial supported tool
is `get_page`. Unsupported tools, remote delegation, virtual writes, injected
chat/tool loops and conflicting model pins fail before inference. The combined
candidate/task prompt is limited to 16,000 bytes and at most 16 turns; oversized
inputs fail instead of being truncated.

Registered migration **241**, shared by PostgreSQL and PGLite, permanently maps
`(run_id, invocation_id)` to a real subagent job. Its hash binds the full
candidate/task, source incarnation, model/runtime selection, tool scope and turn
bound. Changed inputs require a different host invocation ID. The root lock
serializes insertion and bounds child count by `max_attempts`. Migration 278's
aggregate admission charges child calls to the root allowance.

Children use the existing native action handler, fenced queue claims, message
history and canonical tool ledger. Parent authority is checked at execution and
transactional publication boundaries. Ordinary workers without the parent scope
cannot execute these children. The payload's explicit
`optimizer_protocol: codex-skillopt-rollout-v1` marker is rejected as an unknown
field by older native action handlers, before inference. Current handlers require
its durable rollout binding; an ordinary job cannot merely claim the marker. The runner renews a live 15-minute lease before
calls, each bounded to at most ten minutes. Recovery requires lease expiry plus
15 seconds, within the bounded stall count. Active/unresolved inference attempts
block recovery and retain their account lane.

The validated trajectory and terminal job result commit together. Lost commit
acknowledgments recover that same trajectory. Earlier crashes reuse recorded
actions, results and final proposals. Failed reads, cancellation, turn exhaustion
and provider/admission failures do not become scored successes. Failure does not
automatically create another child or refund calls.

Trajectories record child/job identities, measured token categories, usage
completeness and null monetary cost. They describe accepted history; subscription
attempt rows account for all attempted calls. Replay creates no new usage. Do not
sum root and child allowance counters as independent spend.

`runValidationGate` and `scoreSkillOnTasks` accept a host `codex.evaluationId` and
tool scope. Task/repetition identities receive separate durable jobs; retries
reuse them. Private gate inputs are snapshotted before awaits. Tests exercise the
real deterministic rule judge and median/epsilon acceptance calculation.

Pruning and terminal removal skip retained rollout jobs; a foreign key also
protects replay identity. Other eligible jobs still prune normally. Explicit
archival cleanup for these retained records remains future work.

## Deterministic verification

All fixtures use fresh credential-free homes, discovery disabled, fake Codex
executables and a network tripwire. PostgreSQL clusters are disposable and stopped
afterward. No production database or real inference CLI was used.

| Command | Result |
| --- | --- |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-actions.serial.test.ts` | Final source: 60 passed, 258 assertions |
| `python3 /tmp/maxbrain-test-postgres-group-actions.py` | Final source: 60 passed, 258 assertions; cluster stopped |
| `python3 /tmp/maxbrain-rollout-regressions.py` | Legacy rollout/gate/held-out/pruning and native judge: 53 passed, 133 assertions, in separate processes |
| `python3 /tmp/maxbrain-test-postgres-calibration-schema.py` | Migration/catalog/replay parity: 12 passed, 31 assertions; PgBouncer skipped; cluster stopped |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 passed; admin build explicitly skipped |
| `python3 /tmp/maxbrain-stream-check.py bun run typecheck` | Passed on final source |
| `git diff --check` | Passed |
| `python3 /tmp/maxbrain-stream-check.py bun run build` | Compiled 3,704 modules |

The added shared contract contains 17 cases covering transport, replay, changed
inputs, archived sources, scope refusal, real multi-repetition gates, exhaustion,
canonical pending reads, failed reads, unresolved attempts, competing owners,
crashes before/after final commit, retained results, stale workers, cancellation,
parentless execution and pruning. The final suites include the corrected stale-owner fixture, bounded child count
and explicit optimizer protocol marker. Logs use `/tmp/maxbrain-rollout-`.

## Remaining integration and upgrade handoff

- Wire the whole optimizer producer to a stable root grant, phase/candidate
  evaluation IDs, run recovery and prepared canonical skill publication.
- Expand the authorized registry for skills requiring search/query/list. The
  explicit `get_page` scope does not constitute full skill coverage.
- Remote grants, automatic retry scheduling and archival retention need their
  own authority/recovery contracts.
- Qualify real Codex isolation and bounded live subscription behavior. The
  production runtime qualification allowlist remains empty.

Migration 279 was applied only in disposable tests. Installing this source,
migrating the actual database and cutting workers over require the separately
authorized upgrade. No installed executable, pin, service, production database
or private activation changed here. Full container CI, admin UI and live checks
were not run.
