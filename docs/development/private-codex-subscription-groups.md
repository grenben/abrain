# Aggregate Codex subscription allowances

**Say to your agent:** *“Give optimizer rollouts distinct durable identities
while enforcing one aggregate subscription allowance.”*

## Implemented admission foundation

Trusted host callers can create a child subscription run with `parentRunId`.
The parent must already exist and be a root run. Children cannot introduce a
different account lane, extend the deadline, exceed the parent's attempt/turn
bounds, change parents, become roots, or form nested groups. Their envelopes
remain immutable. A child can have smaller limits than its parent.

Calls on the parent and every child consume the parent's aggregate attempts,
accepted turns and single content-repair allowance. They also consume the
child's own limits where applicable. Creating more children does not add total
capacity. Both limits must permit admission before inference. A failed call
consumes an attempt; a semantically accepted result consumes a turn exactly once.
No USD conversion or remaining subscription quota is inferred.

Migration v260 adds the self-reference, parent index and database guard. Counter
updates charge the parent in the same transaction. This also enforces aggregate
caps for writers using the earlier counter-update SQL. The current admission
code locks parent before child to keep concurrent workers' ordering consistent.
A losing acceptance rolls back both its child's counter and its attempt's
accepted flag. Decreasing child counters is refused; ambiguous attempts are
never refunded.

Parent and child calls share the existing unique active account lane. An active
or unresolved child attempt blocks calls from siblings and the parent, including
after a process crash. There is no TTL release or new fallback provider. The
existing owner identity still controls settlement. Root envelopes without
children retain their existing behavior.

Root counters include child consumption: do not sum root and child counters
when reporting totals. Token measurements remain on the actual attempt rows,
one record per call. A group token report must include root and immediate-child
attempts once, preserve missing measurements, and continue reporting unknown
monetary cost and remaining quota.

## Integration and activation limits

This is the admission dependency for durable optimizer rollouts, not a completed
optimizer worker integration. Trusted queue submissions can bind a distinct job
allowance to the parent; real worker handlers then charge the shared total while
retaining separate canonical action ledgers. Invalid parent binding rolls back
job insertion. A parent ID in model-authored job data is refused. Child budgets
do not themselves authorize a job,
allocate its ledger, grant tools, fence parent worker ownership, publish a skill,
or reconcile unsettled actions. The optimizer still needs those host-owned
bindings and its full-run recovery/report lifecycle. Existing job submission
does not accept a model-supplied parent budget or silently reinterpret legacy
queued jobs. The parent field is accepted only in the queue's separate trusted
subscription argument. Account lanes remain shared within their owner database; independent
brain databases do not coordinate a common subscription account yet.

The migration is registered and tested only against isolated state. It has not
been applied to the installed database. Installed GBrain, live inference,
runtime qualification and activation remain unchanged/unverified.

## Deterministic coverage

Shared PGLite/PostgreSQL fixtures exercise real native gateway calls under a
root and distinct child identities, aggregate exhaustion, independent child
caps, single repair admission, failed-call accounting, idempotent acceptance,
concurrent siblings, unresolved ownership, changed envelopes and direct database
counter updates. Separate PostgreSQL connections race child reservations and
acceptances. The fake executable and network tripwires prevent live inference.
Schema catalog and migration replay checks verify the registered storage change.

| Command | Result |
| --- | --- |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-think.serial.test.ts` | 399 passed; one standalone-identity compatibility failure found and fixed |
| `python3 /tmp/maxbrain-test-postgres-groups.py` | Same full-contract compatibility failure found on PostgreSQL; cluster stopped |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-think.serial.test.ts -t 'aggregate Codex subscription admission\|archived source and old contextual identity'` | Corrected affected PGLite contract: 9 passed; 40 assertions |
| `python3 /tmp/maxbrain-test-postgres-groups-final.py` | Corrected contract 9/40; independent-worker admission 7/27; job/schedule regressions 23/96; action assertions exposed a bigint/number test mismatch |
| `python3 /tmp/maxbrain-test-postgres-group-actions.py` | Final PostgreSQL action contract: 43 passed; 174 assertions; includes the two child-job cases |
| `python3 /tmp/maxbrain-subscription-groups-regressions.py` | Existing PGLite admission/action checks: 49 passed; 177 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-actions.serial.test.ts` | Expanded PGLite action contract: 43 passed; 174 assertions |
| `python3 /tmp/maxbrain-test-postgres-calibration-schema.py` | Final migration/catalog/parity checks: 12 passed; 31 assertions; PgBouncer case skipped; cluster stopped |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 74 passed; admin build skipped; SQL search-path guard caught one issue |
| `python3 /tmp/maxbrain-stream-check.py bun run check:search-path` | Passed after pinning the new function's search path |
| `python3 /tmp/maxbrain-stream-check.py bun run typecheck` | Passed on final admission/queue source |
| `python3 /tmp/maxbrain-stream-check.py bun run build` | Compiled 3,700 modules |
| `git diff --check` | Passed |

Focused reruns address the identified failures; the full 400-case contract was
not redundantly rerun after the standalone-identity fix. The final PostgreSQL
subset and regression runs collectively cover 82 cases and 337 assertions.
All PostgreSQL targets were disposable local clusters, stopped afterward.
Full container CI, native Windows, PgBouncer, admin UI and live subscription
checks were not run. Logs use `/tmp/maxbrain-subscription-groups-`, including
`contract.log`, `postgres.log`, `final-focused.log`, `final-postgres.log`,
`postgres-actions.log`, `regressions.log`, `final-actions.log`, `schema.log`,
`verify.log`, `search-path.log`, `final-typecheck.log` and `build.log`.
