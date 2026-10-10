# Private Codex brainstorm integration

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

## Remaining whole-run work

This is a judge implementation checkpoint, not complete brainstorm activation.
Cross generation still uses the legacy free-text parser, parallel calls and
USD estimate. The outer orchestrator still needs a native path with durable
input selection, source/incarnation authority, distinct auxiliary budgets,
structured cross proposals, accepted-result recovery and prepared publication.
Legacy file checkpoints must not become trusted private receipts. The standalone
brainstorm/LSD CLI also needs explicit subscription allowance handling. Existing
non-private behavior remains supported.

No installation, production migration, live inference, credential change,
service restart or private activation is performed by this development work.
The production runtime qualification registry remains empty.

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
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-think.serial.test.ts` | 274 passed; 992 assertions |
| `python3 /tmp/maxbrain-test-postgres-think.py` | Same 274 passed and 992 assertions; cluster stopped |
| `python3 /tmp/maxbrain-codex-brainstorm-regressions.py` | Seven legacy suites, each a separate process: 110 passed; 291 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/private-route-audit.test.ts` | One passed; 15 assertions; uninspected planes remain incomplete |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 checks passed; admin build explicitly skipped |
| `python3 /tmp/maxbrain-stream-check.py bun run build` | Compiled 3,677 modules |
| `git diff --check` | Passed |

Logs use `/tmp/maxbrain-codex-brainstorm-`: `contract.log`, `postgres.log`,
`regression-0.log` through `regression-6.log`, `audit.log`, `verify.log` and
`build.log`. The new judge contract contributes 21 cases to each shared suite.
Full container CI, admin UI build and PgBouncer were not run. No new migration
was added; retained judgments use the existing v236 proposal cache.
