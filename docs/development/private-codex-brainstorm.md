# Private Codex brainstorm integration
> **Historical checkpoint:** This document describes the private 0.60.317.0 source lineage, not validation or activation of the upstream synchronization. Private migrations v261–v290 are being ported as v315–v344; integration remains in progress.

**Say to your agent:** *“Complete private Codex brainstorm generation and judging,
including safe retries and separate embedding limits, without activating it.”*

## Source status

The actual `runJudge` dispatcher has a private native path. It resolves
`models.brainstorm.judge`, the utility tier, global and explicit model pins
through the strict resolver; conflicting aliases/providers fail before dispatch.
It requires an existing host subscription allowance and rejects injected chat
transports. Empty input remains a deterministic no-op without inference.

The host snapshots the rubric, idea IDs/text/citations and bias tags. A run can
judge at most 512 ideas and a 1 MiB serialized snapshot. Individual idea text
is bounded to 4,000 characters; IDs are distinct, bounded host identifiers.
Caller chunk limits must be positive integers up to 1,000; native chunks contain
at most 32 ideas. Each call is ephemeral, sequential, bounded to 120 seconds and
at most 6,360 output tokens, with no repair or provider fallback.

Native final-response schemas require the evidence hash and exactly one row
per supplied idea ID. Extra keys, missing/duplicate/foreign IDs, out-of-range
scores and empty/control-character notes fail the whole chunk. GBrain computes
weighted scores and the LSD inversion rule from the captured rubric. A model
cannot supply a final passing verdict. Accepted output order follows host IDs.

Validated chunks use the existing durable proposal cache under
`codex-brainstorm-judge-v1`, bound to the host grant, model, rubric, complete input
and bias tags. Every cache hit validates schema, hash, semantics and current
host authority. A later chunk failure returns no partial judgment; retry reuses
earlier accepted chunks. Only newly inferred chunks add measured tokens.
Subscription monetary cost and remaining quota are null. Deadline, ownership,
abort and unsettled-attempt gates remain in the shared admission/cache path.

## Native generation and publication

Strict private `runBrainstorm` now selects a separate bounded native path before
legacy parallel generation, USD estimates or filesystem checkpoints. Brainstorm
and LSD share this path. Local CLI flags create a durable allowance atomically
with the actual input binding; direct SDK callers need an existing host grant.
An ordinary USD cap alone never authorizes native calls. The CLI prints the
request UUID for recovery and uses the normal source resolver, including explicit
`--source` and ambient federation. Legacy non-private behavior is preserved.

The host retains selected close/far page IDs, source incarnations, revisions,
read authority, visibility, bounded text and calibration tags before generation.
Cross calls run sequentially with native JSON Schema, at most five ideas each,
exact supporting quotes and host-generated citations. The bounds are eight close
pages, 24 far pages, 512 total ideas, 20 sources and 4,000 characters per page.
Each call has a 120-second deadline and 4,096 output-token limit. No automatic
content repair or alternate provider runs. Valid empty output is retained as
empty; malformed output, refusal, incomplete lifecycle and provider failure
cannot become an empty success or a judgment. Failed judge calls retain accepted
cross proposals for retry without reselecting evidence.

Migration v276 adds `codex_brainstorm_runs` on both engines. It binds one grant to
one immutable request, selection, accepted result and publication plan. A renewable
15-minute owner lease fences generation and result storage; expired ownership
cannot bypass active or unresolved attempts. Changed inputs, models, settings,
evidence revisions or auxiliary-budget identities refuse reuse. Accepted results
can be recovered after the allowance expires without inference. Native monetary
cost and remaining quota stay unknown. Measured native tokens are retained.
Paid embedding/reranking requires a separate durable USD allowance; retrieval
failure cannot silently turn into successful keyword-only work. Explicitly
disabled embeddings remain a supported deterministic keyword mode.

A requested save validates and retains the complete prepared page admission
before effects. Protocol 5 binds its canonical request ID to the retained plan.
The existing coordinator checks source incarnation, read/write authority, worker
claim when present, target/evidence revisions and required receipt state, then
publishes canonical files, database content and provenance links through its
normal recovery machinery. Any private evidence makes the result private.
Targets must be new pages; a changed target is a conflict. Lost acknowledgments
reuse the same request and committed receipt. Completion requires a committed
receipt; uncertain effects stop for reconciliation. Prevalidation is not a claim
of general batch atomicity. Existing indexing debt and reverse-write handling
remain owned by the coordinator.

### Local command and recovery

After a separately authorized build, schema upgrade and private activation,
`brainstorm` and `lsd` accept all three limits together:

```text
--codex-max-attempts N --codex-max-turns N --codex-deadline ISO_UTC
--codex-request-id UUID
--aux-max-usd N
```

Attempts and turns range from 1 to 1,000; turns cannot exceed attempts. New
deadlines must be within 24 hours. The UUID is optional initially and printed
after the binding commits. Repeat the identical command, UUID and limits to
recover. `--aux-max-usd` is optional and separately authorizes paid retrieval;
`--max-usd` also constrains auxiliary work, never native subscription usage.
A successful `--json` invocation returns the retained result without saving,
matching the existing CLI's JSON behavior. Legacy file `--resume` identities
and `--force-resume` cannot override private request binding. `--list-runs`
still lists legacy checkpoints; it is not a private receipt browser.

### Remaining acceptance

This source checkpoint does not activate the installed services. The production
runtime qualification registry remains empty. Live schema/image transport,
native-action isolation, subscription auth and cancellation still need bounded,
separately authorized acceptance. The multi-fixture `eval brainstorm` producer now uses one shared grant and
durable fixture identities; see [evaluation behavior and acceptance](private-codex-brainstorm-eval.md). Scheduling and worker-specific
brainstorm producers are not claimed complete by the local CLI checks. Scratch
brains and remote callers cannot manufacture local grants.

No installation, production migration, live inference, credential change,
service restart or private activation is performed by this development work.
Rollback must park/drain protocol-5 requests before an older consumer runs;
retain the tables and receipts instead of dropping recovery state. Both fresh
schema generation and registered migrations include v276; production migration
and deployment are separate upgrade steps.

## Deterministic checks

Shared PGLite/PostgreSQL fixtures exercise the production `runJudge`, gateway,
native adapter, fake executable, allowance tables and proposal cache. They check
actual schema files/argv/environment, reordered results, malformed and partial
outputs, refusal/missing completion, two-chunk failure/recovery, changed rubric
and input identity, host scoring, forbidden routes, exhaustion, owner loss,
abort and corrupted cache receipts. Legacy brainstorm suites run in separate
processes to keep their module mocks isolated.

### Verified development checkpoint

These commands ran with discovery disabled, fresh temporary configuration,
synthetic content and fake native executables. The wrapper supplies the isolated
environment; the PostgreSQL runner creates and stops its disposable cluster.

| Command | Result |
| --- | --- |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-think.serial.test.ts` | 295 passed; 1,086 assertions |
| `python3 /tmp/maxbrain-test-postgres-think.py` | Same 295 passed and 1,086 assertions; cluster stopped |
| `python3 /tmp/maxbrain-codex-brainstorm-regressions.py` | Seven legacy suites, each a separate process: 110 passed; 291 assertions |
| `python3 /tmp/maxbrain-test-postgres-calibration-schema.py` | v276 catalog refresh, then catalog + migration replay: 12 passed; 31 assertions; PgBouncer skipped; cluster stopped |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 checks passed; admin build explicitly skipped |
| `python3 /tmp/maxbrain-stream-check.py bun run build` | Compiled 3,687 modules |
| `git diff --check` | Passed |

Logs for this checkpoint use `/tmp/maxbrain-brainstorm-run-`: `contract.log`,
`postgres.log`, `regressions.log`, `schema.log`, `verify.log` and `build.log`.
Individual legacy suite logs remain `/tmp/maxbrain-codex-brainstorm-regression-0.log`
through `regression-6.log`. The run contract contributes 21 cases and 94 assertions
to each full shared suite, covering lost acknowledgments after result/admission/
commit, real CLI allowance and source handling, managed canonical files,
publication conflicts, private evidence, cancellation and native/auxiliary limits.
The original judge contract contributes another 21 cases. No real inference CLI
or credentials are used. Full container CI, admin UI build and PgBouncer were not
run. Tests verify the development checkout; installed capabilities are unchanged.
