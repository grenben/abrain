# Private Codex brainstorm evaluations

**Say to your agent:** *“Run the bounded brainstorm evaluation fixtures with one
Codex allowance and verify recovery without changing the installed brain.”*

## Source behavior

`gbrain eval brainstorm` has a strict private branch through the actual native
brainstorm pipeline. The ordinary API-metered evaluation remains available
outside private mode. The private CLI uses the same explicit local allowance
flags as brainstorm: attempts, accepted turns, absolute UTC deadline, optional
recovery UUID and a separate auxiliary USD allowance. All fixtures consume one
`codex_subscription_runs` row and the shared account lane. No per-fixture grants
multiply these limits. Direct SDK callers require a host subscription context.

The host captures a regular UTF-8 JSONL file once, bounded to 1 MiB and 1,000
fixtures. Malformed rows, unknown fields, empty/oversized questions and invalid
thresholds fail before a local allowance is persisted. Dataset bytes, selected
fixtures and order, thresholds, source incarnations, models, retrieval settings,
embedding identity and auxiliary budget identities bind the batch. Reusing a
UUID with changed material input is refused. `--source` and ambient source
selection use the existing resolver and federation rules. Source/configuration
drift is checked again before accepting work. Fixture text is reference data;
it never grants authority or supplies execution IDs.

## Durable identities and recovery

The existing evaluation run/result store provides the batch lease and fixture
receipts. Its `answer` stage means the completed brainstorm result, including
native judging; it is not an unfinished cross proposal. Every retained summary
also binds the original native brainstorm result hash. Replays revalidate the
source/evidence-backed brainstorm result before exporting the summary.

Migration v259 separates brainstorm invocation IDs from their subscription
grant IDs. Ordinary single runs retain protocol 1; evaluation fixtures use
protocol 2 with host-derived IDs. Repeated identical question rows have distinct
fixture identities and proposal caches. All dispatch still reserves against
the original grant. Older readers reject the fixture protocol; older writers
cannot create rows lacking the new grant binding. Both schema generators and
registered migrations carry the change. It is tested only in isolated databases
here; no production migration is applied.

A later failed fixture stops the batch. Prior successful fixtures and validated
cross proposals remain reusable. The failed fixture never becomes a cached
rejection or grade. An incomplete report is always `inconclusive`, even if its
completed subset meets the score thresholds. Valid empty results are completed
fixtures with an explicit empty outcome and null usefulness; they do not become
parseable judged ideas. Missing completion or ambiguous attempts retain the
account lane and block replay until reconciliation. Expired identical grants
can export already completed receipts without new inference.

The private JSON report is version 2, with selected/completed counts, the durable
run ID, explicit empty outcomes and a bounded failure classification when work
stops. Subscription monetary cost stays null. The legacy API report retains its
version and public metrics exports. Paid embedding/reranking limits are shared
across the batch; a USD-only cap cannot authorize native generation.

## Verification and upgrade scope

Shared PGLite/PostgreSQL fake-executable tests cover the real CLI dispatcher,
multiple fixtures, aggregate exhaustion, later-fixture failure and retry,
expired receipt export, changed inputs/evidence, concurrent owner refusal,
lost acknowledgments, corrupted summaries, distinct duplicate questions,
unsettled calls and mid-run configuration drift. Legacy suites run in separate
processes. The standard repository gates and source build also apply.

This is source development. Installation, migration of the existing brain,
worker replacement, live runtime qualification and private activation remain
separate authorized steps. Full CI/admin UI/PgBouncer and live subscription
behavior are not established by the isolated checks.

### Verified development checkpoint

All inference below uses the fake native executable with fresh temporary
configuration, discovery disabled and network tripwires. PostgreSQL runners
create and stop disposable clusters.

| Command | Result |
| --- | --- |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-think.serial.test.ts` | 311 passed; 1,139 assertions |
| `python3 /tmp/maxbrain-test-postgres-think.py` | Same 311 passed and 1,139 assertions; cluster stopped |
| `python3 /tmp/maxbrain-test-postgres-calibration-schema.py` | v259 catalog refresh, then catalog/replay: 12 passed; 31 assertions; PgBouncer skipped; cluster stopped |
| `python3 /tmp/maxbrain-codex-brainstorm-regressions.py` | Seven separate legacy processes: 110 passed; 291 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 74 passed; admin build skipped; one test-registration type error found |
| `python3 /tmp/maxbrain-stream-check.py bun run typecheck` | Passed after removing the unused extra test-registration property |
| `python3 /tmp/maxbrain-stream-check.py bun run build` | Compiled 3,693 modules |
| `git diff --check` | Passed |

The new shared evaluation contract contributes 16 cases and 53 assertions on
each engine. Logs use `/tmp/maxbrain-brainstorm-eval-`: `contract.log`,
`postgres.log`, `schema.log`, `regressions.log`, `verify.log`,
`typecheck-final.log` and `build.log`. These results verify source behavior,
not an installed upgrade or live subscription acceptance.
