# Private Codex host action checkpoint

This source checkpoint adds the first sequential GBrain-owned minion loop. It is
limited to scoped page reads. Installed GBrain, production data, credentials and
private activation are unchanged. No production Codex runtime is qualified yet.

## Admission and authority

New trusted application submissions must explicitly select
`action_protocol: 'codex-host-read-v1'`, name one source, allow `get_page`, supply
allowed slug prefixes, set `max_turns` from 1 to 16 and set `no_self_fix: true`.
They still require the queue's separate trusted subscription allowance and
protected-job authorization. USD consent never substitutes for that allowance.
Existing jobs are not automatically converted. Remote delegated subscription
jobs, writes, other brains, custom systems/definitions and nested inference are
not supported by this protocol.

The existing subscription run binds the durable job payload, application
authority, configured model/runtime and source incarnation. Queue admission,
worker entry and each fenced history mutation recheck that binding. History
transactions lock the job and source, then recheck the incarnation through commit. Direct
handler calls without a bound job fail. Conflicting job, tier and subagent model
pins fail before inference. Private handler construction does not construct the
Anthropic client. Native `supports_tools` and `supports_subagent_loop` stay false;
the handler uses the distinct host structured action capability.

The existing worker protocol fence remains in force. A subscription-capable
older build refuses these subagent jobs at its existing preflight; older builds
without subscription enforcement cannot claim them. Isolated child readiness
additionally requires `codex-host-read-v1` for subscription subagents. Removing
private configuration does not allow a bound job to fall through to another
provider. A new unbound job carrying this protocol is refused outside private mode.

## Proposal and execution

Each ephemeral call uses a native JSON Schema envelope containing exactly one
tool action or final answer. Tool branches come from the job's authorized
operation registry. This checkpoint exposes only `brain_get_page` and only its
`slug` parameter. The schema and host semantic checks reject extra authority,
source, request ID and parallel-action fields. Arguments also pass the original
operation schema and normal operation parameter validation.

GBrain supplies the source, job identity and untrusted-reader context. Prefixes
are enforced before the read and against the resolved slug afterward, including
aliases. The existing page operation strips protected body fences. The host
refuses private/quarantined results and projects only slug, source, title, body,
timeline and revision into durable model history. Arbitrary frontmatter and raw
errors are omitted. Page text is reference data, never execution authority.
The ordinary read operation can retain its existing best-effort, throttled
`last_retrieved_at` telemetry; no content mutation tool is enabled.

Bounds are explicit: 16 maximum assistant turns, a 16,000-byte input prompt,
16,000-byte projected tool results, 96,000-byte retained/history input bound and
an 8,000-character final answer. Oversize results become explicit failed reads,
not silently truncated evidence. Subscription attempt/turn/deadline limits and
the shared account lane apply independently. Job cancellation and deadlines
reach the adapter. Unknown process settlement still retains the subscription lane.

## Durable history and recovery

The loop reuses `subagent_messages` and `subagent_tool_executions`, with history
schema version 3 and provider ID `codex-host-read-v1`. No storage migration is
needed for those existing fields. The stable identity remains
`(job_id, message_idx, ordinal)`, with ordinal zero for the single action.

An accepted assistant action and its pending ledger entry commit together before
execution. Insertion supplies a candidate UUID, but the database-returned
`gbrain_tool_use_id` is authoritative. Retaining the same identity with different
arguments fails. Measured token rollups commit with first retention and are not
added again on replay. Subscription cost remains null; attempts not retained as
history remain recorded in the subscription ledger.

The loop reconciles prior history before requesting another proposal:

- A pending allowed read may execute again; it has no content-writing effect.
- A completed read reuses its saved result.
- Result settlement and its history message commit together.
- A retained final answer returns without another inference call.
- Legacy/inconsistent history refuses execution. Unexpected ledger tools stop as
  `codex_action_needs_reconciliation`, with the original pending row retained.
- Lost worker ownership or cancellation prevents history/result settlement.

Read errors are retained as failed tool results with a content-free error code.
The model may then explain the failure; the final result includes
`tool_actions_failed`. Exhaustion or a malformed proposal does not create a final
answer. Full history is bounded rather than silently compacted or discarded.

## Deterministic verification

`test/helpers/codex-actions-contract.ts` exercises the real queue, worker wrapper,
handler, gateway, fake executable, page operation and existing ledger on PGLite
and native PostgreSQL. Its fixtures cover native schema capture, multi-round
reads, source/privacy/prefix boundaries, rejected writes/authority/parallel
actions, canonical identity conflicts, token accounting, turn/attempt exhaustion,
older children and terminal replay.

Injected failures cover before action retention, after ledger insertion inside
the transaction, after action retention, after reading before result settlement,
after result settlement and after final-answer retention. A stolen claim cannot
settle the old worker's output; the new owner resumes the same retained action.
These are deterministic failures at production persistence seams, not a claim of
complete OS process-kill or network-partition coverage.

The focused PGLite/action and regression command passed 149 tests:

```sh
bun test --timeout=60000 test/ai/codex-actions.serial.test.ts test/ai/codex-jobs.serial.test.ts test/ai/private-policy.serial.test.ts test/child-readiness.test.ts test/subagent-handler.test.ts
```

The final action contract contains 24 cases, including source-incarnation and
handler-payload changes. The affected action/job rerun passed 47 tests; the final
action-local source fence was then exercised by all 24 cases on each engine.
These counts overlap.

Native PostgreSQL passed all 24 action-contract tests using an isolated temporary
PostgreSQL 16.15/pgvector 0.8.7 cluster, stopped afterward:

```sh
bun test --timeout=240000 test/e2e/codex-actions.test.ts
```

All commands use scrubbed environments, fresh state, discovery disabled, a
forbidden-network tripwire and registered fake executable hashes. No real
subscription call or production database is involved.

`GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` passed 74 checks and skipped the admin
build. Its sole failure was a missing `SubagentResult.tool_actions_failed` type
declaration, corrected afterward. `bun run typecheck` was rerun successfully;
`bun run build` and `git diff HEAD --check` also passed. The admin gate's additional
unlocked dependency installation and the full CI matrix were not run.

## Remaining work

This is a scoped read checkpoint, not full minion acceptance. Add proven writes
through prepared requests and receipts, then verify ambiguous effects and actual
required-write completion. Broader read registries, remote delegation, operator
reconciliation, pin/job migration and full process-crash matrices remain open.
Final-answer prose is model output, not independently verified factual truth.
Runtime native-action/instruction isolation, installation and separately
authorized live subscription acceptance remain required before activation.
