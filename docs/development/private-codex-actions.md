# Private Codex host actions

The source supports a sequential GBrain-owned minion loop with scoped page reads
and recoverable page writes. Installed GBrain, production data, credentials and
private activation are unchanged. No production Codex runtime is qualified yet.

## Admission and authority

Trusted application jobs select either `codex-host-read-v1` (only `get_page`) or
`codex-host-actions-v1` (`get_page` and `put_page`). They name one source, allowed
slug prefixes, `max_turns` from 1 to 16, and `no_self_fix: true`. Write jobs also
set `require_writes` explicitly. Both require protected submission authorization
and a separate subscription allowance; USD consent cannot substitute for it.
Remote delegation, other brains, custom systems/tools and nested inference are
not supported by these protocols.

The subscription binding covers immutable job data, application authority,
configured runtime/model, source creation time and source incarnation UUID.
A binding created before the incarnation UUID was included fails identity checks;
it needs explicit resubmission rather than silent adoption. Queue/worker entry
and every history transaction recheck the binding. Transactions lock the brain,
job and source in order. An unbound direct handler call fails. Private routing
refuses conflicting pins before inference and never constructs Anthropic.

Native tool/loop capabilities remain false. Isolated child readiness requires
both host action protocol features as well as subscription enforcement. Existing
jobs are not automatically converted, and removing private configuration cannot
send a bound job to another provider.

## Proposals and reads

Every ephemeral call proposes exactly one tool action or final answer through a
native JSON Schema generated from the job's authorized registry. Arguments also
pass the original operation schema. Model-authored source, authority, request ID,
operation ID and parallel actions are refused.

Reads use the normal untrusted `get_page` operation with host-supplied source and
prefix checks before and after alias resolution. Privacy fences are stripped;
private/quarantined pages are refused. History retains only slug, source, title,
body, timeline and revision. Read telemetry can still update `last_retrieved_at`.
Failed reads retain a content-free error and `tool_actions_failed` reports them.

Limits are 16 turns, 16,000 prompt bytes, 16,000 result bytes, 96,000 history bytes,
8,000 final-answer characters and 12,000 write-content bytes. Oversized evidence
fails explicitly. Subscription attempts, accepted turns, deadline and shared
account concurrency remain independently enforced; cost stays null.

## Durable writes

The assistant proposal and pending ledger row commit atomically before effects.
The stable coordinates are `(job_id, message_idx, ordinal=0)`; the database-returned
`gbrain_tool_use_id` is authoritative. Reusing it with changed inputs fails.

Before admission, GBrain retains an immutable `host_binding` containing the
normalized write admission, stable request ID, worker claim, source authority,
subscription run and observed revision. Existing targets require a successful
retained read of that exact source, slug and revision. New targets bind absence.

Writes use normal untrusted stdio writer registration and `preparePageAdmission`,
then `preparePageMutation`. Normal grant, namespace, visibility, protected content,
core-page, empty-overwrite, timeline, canonical-file and indexing-debt rules still
apply. GBrain stamps `minion:codex` provenance; the model cannot supply authority.
No OAuth credential is copied into the action history.

Migration 265 adds the host binding and page request protocol 3. Old consumers
refuse that protocol. Current admission and publication revalidate the retained
job claim and payload, subscription deadline, writer grants, source incarnation,
canonical identity and request contents. Publication rechecks the observed target
revision while its page lock is held. The existing coordinator couples canonical
file/database effects to its durable receipt and recovery record.

On replay, GBrain reads the original receipt before another inference call. If a
new worker inherits a retained write binding but no request was ever admitted,
it may rebind only the dead worker's lock token under the live job/source fence;
the stable request ID, action identity, inputs, source and subscription run stay
fixed. Any existing receipt preserves its original immutable admission intent.
A committed write settles the pending action without republishing. A queued or
recovering write waits on the same request for a bounded interval. An unresolved
outcome stops as `codex_action_needs_reconciliation`; its action stays pending.
A confirmed terminal failure without unresolved publication becomes a failed
result. A new worker can reconcile an old worker's committed receipt. A stale
claim cannot admit or publish a new effect, or settle history.

Required-write completion checks the actual receipts. A final answer, successful
dispatch, exact no-op or duplicate does not count as a changed page. A quarantined
commit is disclosed as a failed tool result. A cancellation after a commit leaves
the receipt available for reconciliation even if the tool result was not retained.

Read histories use schema version 3; write-enabled histories use version 4.
Result settlement and history persistence commit together. Token rollups are
recorded once on first assistant retention. Completed history and final answers
replay without further inference; all retained history remains bounded.

## Deterministic verification

The shared action contract exercises actual queue/worker, handler, gateway,
fake executable, operation, ledger, persistence owner and file paths. There are
41 cases on both PGLite and isolated PostgreSQL. Faults cover action/ledger
retention, write binding, request admission, publication rollback, result
settlement, final retention, stale claims, changed revisions/inputs and unresolved
receipts. These are failures injected at production seams, not full OS process-kill
or network-partition coverage.

`test/ai/codex-actions-process-crash.slow.test.ts` separately kills PGLite
workers with SIGKILL after a pending read action, after write authority is
retained but before admission, and after a canonical page write commits but
before its action ledger settles. A second process expires and reclaims each
lease. The read retains one ledger identity with no repeated inference; both
write cases retain one ledger identity and one committed file/database effect,
with no second write admission. PostgreSQL process-kill recovery remains open.

```sh
bun test --timeout=60000 test/ai/codex-actions.serial.test.ts test/ai/codex-jobs.serial.test.ts test/child-readiness.test.ts
# 80 passed, 344 assertions
bun test --timeout=240000 test/e2e/codex-actions.test.ts
# 41 passed, 161 assertions on isolated PostgreSQL 16.15 / pgvector 0.8.7
```

Commands run with fresh temporary homes/state, discovery disabled, fake executable
hashes and a forbidden-network tripwire. The temporary PostgreSQL cluster is
stopped afterward. No real inference or production migration was run.

The restored-handler and legacy page/subagent regression run passed 161 tests
(587 assertions). Reverting the handler integration with
`scripts/check-test-discriminates.sh` produced 16 executed test failures; restoration
passed. Schema/migration checks passed 218 cases initially; the two failing schema
cache/fragment cases were corrected, and the affected two-file rerun passed all
20 cases. Catalog goldens changed only for the binding column, protocol constraint
and request guard. The migration-record golden also caught up previously implemented
migrations 225 and 226. PostgreSQL catalog checks passed 8 cases; the PgBouncer
case remained skipped because no isolated PgBouncer was provisioned.

`GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` passed 75 checks and explicitly skipped
the admin build. Typecheck and the compiled CLI build passed (3,601 modules).
The admin gate would install additional unlocked dependencies; neither that gate
nor the full CI matrix was run. These results verify source, not an installation.

## Remaining acceptance

Broader scoped reads, operator reconciliation, pin/job migration, all feature
producers and the full process-crash matrix remain open. Final-answer prose is
model output, not independently verified factual truth. Native runtime isolation
qualification and separately authorized live subscription tests remain required
before installation and activation. This checkpoint does not claim the whole
Codex migration is complete.
