# Aggregate Codex subscription allowances

**Say to your agent:** *“Give optimizer rollouts distinct durable identities
while enforcing one aggregate subscription allowance.”*

## Implemented admission foundation

The [optimizer workflow](private-codex-skillopt-workflow.md) uses distinct
rollout grants under its root allowance. The ledger also supports the bounded
hierarchy used by the [batch coordinator](private-codex-skillopt-batches.md):

```text
batch allowance
  └─ skill optimizer allowance
       └─ rollout allowance
```

Trusted host callers can create a child subscription run with `parentRunId`.
The parent must already exist. There may be at most two parent edges (three
levels); a fourth level is rejected. This is host workflow accounting, not
model delegation. Children cannot introduce a different account lane, extend the
deadline, exceed the parent's attempt/turn bounds, change parents or become
roots. Their envelopes remain immutable. A child can have smaller limits than
its parent.

Each call consumes its own run's attempts and every ancestor's aggregate
attempts. Semantic acceptance charges accepted turns at all those levels exactly
once. One content-repair allowance spans the entire tree. Creating more children
does not add capacity. A failed call consumes an attempt; unresolved calls retain
the account lane. No USD conversion or remaining subscription quota is inferred.

Migration v278 adds the parent reference and original group guard. Migration
v284 replaces that guard with bounded tree accounting and adds
`gbrain_codex_subscription_lock_path`. Existing counters and attempt records are
preserved without recalculation. Admission and acceptance lock root, intermediate
and leaf rows in that order. The database guard propagates deltas recursively
within the same transaction, including earlier counter-update SQL. Exhaustion
rolls back the attempt insertion or accepted flag and all descendant counters.
Decreasing counters at any level is refused. An older direct SQL writer with a
different lock order may receive a transaction deadlock abort; it cannot commit
partial charges. Workers should be drained during a separately authorized upgrade.

An active or unresolved attempt blocks siblings, ancestors and other branches
using the same account lane, including after a process crash. There is no TTL
release, refund or fallback provider. The existing owner identity controls
settlement. Limits are GBrain's local admission controls; they do not estimate
OpenAI's remaining subscription quota or reset it.

Root counters already include descendant consumption: do not sum the counters
across levels. Token measurements remain on actual attempt rows, one record per
call. Batch reports include all descendant attempts once and preserve missing measurements. Existing optimizer reports still cover their
root and direct rollout children. Monetary cost and remaining quota remain null.

## Integration and activation limits

Foreground native batches use this tree through a durable manifest binding each
skill's identity, source, scope and recovery state. Child optimizers require that
persisted membership and a live batch owner scope; a child grant alone is
insufficient. Scheduled cycle selection and PostgreSQL queued batch submission
now use this tree through the durable host protocol. Fleet and shared catalog
batch producers remain incomplete.

Trusted queue submissions can bind a distinct job allowance to a parent; real
worker handlers charge the shared total while retaining separate action ledgers.
Invalid parent binding rolls back job insertion. A parent ID in model-authored
job data is refused. An allowance does not authorize a job, grant tools, fence
worker ownership, publish a skill or reconcile an unsettled action. The queue
accepts parent binding only in its separate trusted subscription argument and
does not reinterpret legacy queued jobs.

Account lanes remain shared within one database; independent brain databases do
not coordinate a common subscription account yet. The registered migrations
have been exercised only against isolated state. They have not been applied to
the installed database. Installed GBrain, runtime qualification and activation
remain unchanged/unverified.

## Deterministic coverage

Shared PGLite/PostgreSQL fixtures exercise real gateway calls through a fake
Codex executable, root/child/grandchild accounting, per-level exhaustion, repair
bounds, failed-call charging, idempotent acceptance, atomic rollback, unresolved
ownership and rejection of deeper trees. A migration fixture starts with spent
legacy child allowances, applies the registered upgrade twice, and verifies
preserved charges and new grandchild admission. Separate PostgreSQL connections
race different branches, root/leaf and intermediate/leaf reservations, and
accepted-turn settlement.

Current checkpoint verification commands and results are recorded in
[development status](private-codex-status.md#bounded-subscription-tree-checkpoint).
All inference in these tests uses fixture executables with network tripwires.
Schema catalog and migration replay checks cover both storage engines. These
checks prove the checkout, not an upgraded installation or live subscription.
