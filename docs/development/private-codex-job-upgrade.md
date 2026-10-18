# Private Codex queued-job cutover

This source checkpoint adds explicit legacy-job dispositions. It does not stop
services, run inference, change an installed executable or activate private mode.
The database requires registered migration **v267** on the selected existing brain.
The commands use the existing connection bootstrap with startup migrations disabled.

## Review and drain

```sh
gbrain private-codex jobs preview --ids 12,34 --json
```

Preview reads only an explicit bounded selection (at most 128 IDs) and immediate
dependencies. Output includes hashes, status, recognized protocol and disposition;
prompts, result bodies and authority payloads are not printed. Oversized snapshots
refuse. Coverage remains incomplete for unselected jobs and worker processes.

| Disposition | Meaning and action |
|---|---|
| `drain` | The job is active. Observe its current execution and receipts before cutover; this command neither cancels nor starts it. |
| `park` | Pending work can be considered for a durable hold. All connected nonterminal dependencies must be explicitly included. |
| `parked` | A durable migration fence already holds this job. Keep its receipt and history. |
| `terminal_review` | The job status is terminal. Reconcile any uncertain effects independently; this is not proof of settled effects. |

Stop producers for a controlled cutover. Let authorized active work finish, then
stop workers before applying the reviewed migration. A stalled or ambiguous
execution needs reconciliation; do not reset its attempts or erase its history to
make it eligible for resubmission. No command here automatically drains a worker
by starting more legacy inference.

## Park and restore

```sh
gbrain private-codex jobs park --ids 12,34 --expect HASH --yes --json
gbrain private-codex jobs receipts --json
gbrain private-codex jobs restore --id UUID --expect HASH --yes --json
```

`HASH` is the preview's `plan_hash`; `UUID` is the parking receipt ID. The
transaction locks the job graph and sources, rechecks the snapshot and records
status changes, fences and receipt together. Active work or an unselected live
dependency refuses the whole plan. The fence prevents updates, deletion, old-worker
claims, ordinary resume/cancel and new child attachment. Existing histories,
subscription attempts and ambiguous account ownership are retained.

Restore removes the selected fences and restores original pending statuses in
one transaction. It refuses while strict private mode is active, after replacement
submission, or after source/dependency drift. Binary/configuration rollback and
worker restart are separate operator steps. Neither migration nor rollback is a
general configuration or worker activation switch.

## Reviewed new submission

Resubmission never changes the old job into a Codex job. Write a separate local
JSON file containing the exact new content and allowance, for example:

```json
{
  "version": 1,
  "job_id": 12,
  "data": {
    "action_protocol": "codex-host-read-v1",
    "prompt": "Read notes/example and summarize the evidence.",
    "source_id": "default",
    "allowed_tools": ["get_page"],
    "allowed_slug_prefixes": ["notes/*"],
    "max_turns": 4,
    "no_self_fix": true
  },
  "max_attempts": 6,
  "max_turns": 4,
  "deadline": "REPLACE_WITH_FUTURE_UTC_ISO_TIMESTAMP"
}
```

The timestamp must be within 24 hours at submission. `max_attempts` and
`max_turns` are explicit subscription allowances, not token/quota estimates.
Mixed work requires its own optional positive `max_usd` allowance for API
auxiliaries. An omitted USD allowance does not authorize paid auxiliary calls.
Iterative writes use the separately validated `codex-host-actions-v1` payload
described in [host actions](private-codex-actions.md).

```sh
gbrain private-codex jobs resubmit-preview --file reviewed.json --json
gbrain private-codex jobs resubmit --file reviewed.json --expect HASH --yes --json
```

Use the replacement preview's hash. The file is bounded to 64 KiB, must be an
owned regular file, and must contain only the recognized envelope fields. The
preview binds its entire content, original job snapshot, brain/source incarnation,
private policy and allowances without printing the prompt.

Submission uses the existing queue, authority validation and subscription ledger.
The fresh job, grant, replacement link and receipt commit together. It uses the
default queue, no delay and one queue attempt; subscription calls remain bounded
by the separate envelope. Repeating the identical reviewed request returns the
same receipt, including after commit-response loss. Changed inputs refuse. The
original job remains parked permanently once a replacement exists, preventing
rollback from admitting both jobs. The normal claim protocol fences older workers.

## Reconciliation limits

Automatic replacement requires an unstarted standalone generative job under local
application or legacy-null authority, an explicit same source, no retained
execution history/subscription run, and a supported new payload. Previously
attempted work remains parked for deterministic reconciliation. Connected graphs
require an explicitly reviewed new workflow; this command does not infer new
parent/child wiring. Remote authority requires a new authorization review.

These refusals preserve historical identities and uncertain effects. They do not
claim that reconciliation tooling or every generative feature is complete. The
runtime qualification registry remains unqualified for production, so successful
queue migration does not prove a job can run live. Keep installation, runtime
qualification and activation as separate acceptance gates.

## Verification

The shared contract exercises real queue, transaction, trigger and CLI paths on
PGLite and isolated native PostgreSQL. Fixtures contain synthetic content; network
is forbidden and the configured inference executable does not exist. Tests cover
active-job refusal, stale snapshots, dependency closure, old-worker fencing,
rollback, source reincarnation, explicit new grants, prior-execution refusal,
receipt-insertion crashes, concurrent replacement and unchanged-input replay.

```sh
bun test --timeout=60000 test/ai/codex-upgrade-jobs.serial.test.ts
bun test --timeout=240000 test/e2e/codex-upgrade-jobs.test.ts
```

Schema/catalog fixtures verify both storage engines. Native PostgreSQL requires
authorized isolated infrastructure; no production schema is applied here. Full
process-kill and live subscription acceptance remain separate from these injected
transaction failures and deterministic no-inference checks.

Checkpoint verification: the migration/queue/action/pin regression command passes
89 tests; native PostgreSQL passes 15 migration tests and eight catalog/parity
tests, with the unavailable PgBouncer arm skipped. Migration and PGLite schema
checks pass 220 tests. `bun run verify` passes 75 checks including typecheck and
architecture/size/registry/docs gates; admin UI build is explicitly skipped.
`bun run build` compiles 3,613 modules. Reverting only the CLI dispatch integration
produces 13 passes and two failures, establishing that the new CLI assertions
detect its removal. Restoring it passes all 15 migration tests. These checks do
not establish full CI, installation or live subscription behavior.
