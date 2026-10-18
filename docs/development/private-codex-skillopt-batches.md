# Private Codex optimizer batches

The existing `skillopt --all` dispatcher now has a private Codex path. It requires
explicit local subscription admission, source and read scope, and processes at
most 20 benchmark-bearing skills sequentially. The source implementation and
isolated tests do not activate or upgrade an installed GBrain.

## Admission and identity

Use the same `--codex-request-id`, attempt/turn limits, absolute deadline,
`--source`, and `--read-prefix` flags as a single optimizer, together with
`--all`. Optional `--read-tool` selections retain the discovery registry. The
batch's root allowance covers all skills and their rollouts; each skill also
has its own bounded child allowance. SDK callers may supply tighter
`codexPerSkill` limits. The CLI uses the root limits for each skill, with the
shared root always enforcing the total.

`--all` discovers each skill's `skillopt-benchmark.jsonl`. Native batch mode
rejects a single `--benchmark` override. `--patch` / `--rewrite`, explicit
bootstrap review, common held-out file, model selections, runtime limits and
mutation controls reach every skill's preflight. Held-out evidence must satisfy
each skill's existing checks. `--dry-run` validates all skills and creates no
allowance, manifest, jobs or output files. Missing directories are errors;
a valid empty selection is a distinct successful empty result.

USD-only flags do not authorize subscription inference. Costs and remaining
subscription quota are null. Private batches reject the API-only
`--brain-wide-max-cost-usd` flag; `--aux-max-usd` is the independent durable budget
for paid embeddings/reranking. Existing auxiliary guards remain inherited across
children, and SDK batch execution without an auxiliary budget refuses paid
auxiliary calls. Current scoped reads are deterministic and do not need those
providers.

## Retained plan and execution

Before effects, `codex-batch.ts` snapshots and validates every skill, benchmark,
source incarnation, model route, read scope and output target. Migration v267
adds `codex_skillopt_batches` and `codex_skillopt_batch_members`. The complete
manifest (bounded to 8 MiB), immutable input hashes, canonical child IDs and
child allowances are persisted in one transaction.

A child allowance alone cannot authorize an optimizer. The coordinator binds an
internal host scope to a persisted membership and live batch owner token.
`codex-run-store` and `codex-rollout-store` check that binding before admitting
nested work. Standalone optimizers retain their existing authority checks.
Parent identity is never accepted from model output or benchmark instructions.

Each member uses the existing real optimizer, canonical rollout jobs, action
ledger, checkpoints, accepted proposal and file reconciliation. The batch
continues only after that member completes. Completion checks actual retained
member results and their receipt hashes; it does not infer completion from
proposed content. Measured token reports count actual attempt rows once across
the whole tree and report unmeasured attempts separately.

## Recovery and failure

Retry with the same request UUID, inputs, scope and limits. A changed manifest,
benchmark, source incarnation, tool scope, auxiliary budget or allowance is
refused. New skill discovery also changes the manifest; use a new reviewed
request for different work.

A batch is not a transactional publication of all skill files. A committed
member remains committed if a later member fails. Retained optimizer results
and exact output bytes reconcile partial file publication; completed members
are reused without more inference. Lost manifest acknowledgement retains the
owner lease until recovery is permitted. Lost terminal acknowledgement returns
the retained batch result on retry.

Errors, exhaustion and cancellation propagate explicitly. They do not become
zero-dollar success reports or cached rejected grades, and no fallback provider
is selected. Attempts stay charged. An active or unresolved call anywhere in the
tree blocks batch recovery and retains the lane; the batch records
`needs_reconciliation`. Settled failures retain resumable progress without
inventing a successful watermark. Owner checks prevent stale publication and
prevent an old owner from releasing its replacement's lease.

## Scope and verification

Foreground local CLI, queued PostgreSQL CLI batches, direct trusted SDK batches,
the public trusted package submission API, and
[scheduled cycle selection](private-codex-skillopt-cycles.md) are implemented.
Fleet optimization and shared catalog batch publication remain separate
integration work. The package API is exported from `gbrain/core/skillopt` as
`submitCodexSkillOptBatch`; callers provide a trusted local `operationContext`,
explicit Codex read scope, resolved model metadata, and a bounded allowance. The
API does not create a grant from USD authorization or remote caller input. The
queue worker receives its
own durable protocol submission, frozen per-skill hashes, request identity and
job fence, then runs the existing retained batch coordinator. Every skill is
validated before enqueueing and against its retained hash before execution.
PGLite keeps its inline path because it has no worker daemon. Each account lane
coordinates one database; separate databases still need shared account coordination.

`test/helpers/codex-skillopt-batch-contract.ts` runs through actual dispatch,
CLI, optimizer, queue, action ledger and publication seams with a fake Codex
executable and forbidden-network tripwires. Both storage engines cover two-skill
execution, repeat identity, whole-batch preflight, partial publication,
manifest/result acknowledgement loss, per-skill and aggregate exhaustion,
unresolved calls, competing owners, stale publication and cancellation.
See the [checkpoint record](private-codex-status.md#durable-optimizer-batch-checkpoint)
for commands, results and unavailable gates. Production migrations, deployment,
runtime qualification, live inference and activation remain pending.
