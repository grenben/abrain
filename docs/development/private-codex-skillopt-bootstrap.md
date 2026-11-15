# Private Codex benchmark generation
> **Historical checkpoint:** This document describes the private 0.60.317.0 source lineage, not validation or activation of the upstream synchronization. Private migrations v261–v290 are being ported as v315–v344; integration remains in progress.

**Say to your agent:** *“Generate reviewable skill benchmarks through native
Codex schemas, preserve failed outcomes and retain accepted proposals.”*

## Implemented source paths

Both actual bootstrap generators (`runBootstrap` from routing examples and
`runBootstrapFromSkill`) select native Codex in strict private mode. The guarded
entry requires an existing host subscription allowance tied to its engine.
A USD cap alone cannot authorize generation. Private results report null monetary
cost and remaining quota, measured new tokens and proposal-cache hits. The legacy
non-private paths retain their behavior.

The optimizer's explicit pin and deep tier pass through the strict resolver.
There is one ephemeral native call for the complete selected batch, using the
actual output schema, a 120-second timeout and an 8,192-token requested cap.
No native tools, content repair, provider fallback, malformed-row salvage or
partial-success report is used. Refusal, missing terminal completion, cancellation,
quota exhaustion and invalid proposals remain explicit failures.

The host supplies full skill text (at most 64,000 characters), selects routing
intents, and assigns canonical draft task IDs. Input snapshots are bounded to
128 KiB; the from-skill task count and selected routing count are 1–50. Routing
input permits at most 1,000 rows, rejects malformed rows, and preserves selected
intents in order. Zero selected intents is an input outcome before inference.
Changed, omitted, duplicate or added generated tasks fail the whole proposal.

Each task needs 2–4 distinct checks. Numeric arguments are integers with explicit
bounds; strings must be nonempty and control-free. Tool checks must refer to
tools declared in the skill frontmatter and cannot simultaneously require and
forbid the same tool. These predicates authorize no tool execution. Regex
generation uses an anchored flat subset: no groups, alternation, backreferences,
unbounded quantifiers or optional quantifiers, with at most one bounded
repetition (1–64). Unsupported patterns fail; they are never silently dropped.
Generated rules are weak drafts, not proof of benchmark quality.

## Draft writes and recovery limits

Inputs and existing output are read as bounded regular UTF-8 files (at most
1 MiB each). Symlinks, devices, FIFOs and multiply linked files are refused.
The selected skill directory identity, skill contents, routing contents and
existing output are rechecked before writing. Writes use an owner-only unique
temporary file with file and directory synchronization; new output is published
without overwriting a concurrently created file. Existing output requires the
caller's explicit force option. Observed concurrent changes refuse the write.

The host authority fence is held during the synchronous draft write. The
filesystem effect is not rolled back by a SQL failure. Accepted native proposals
are retained first under `codex-skillopt-bootstrap-v1`, bound to the host run,
model, complete input, output path and directory identity. After a lost draft
acknowledgement, retrying unchanged inputs with the same live grant and force
reuses that proposal and compares exact output content. No new inference or
token charge is needed. This is proposal reuse and draft reconciliation; it is
not a durable whole-optimizer publication receipt or expired-grant recovery.

Every generated file retains the pending-review sentinel. Ordinary benchmark
loading refuses it until the review acknowledgement is supplied. Existing
filesystem and database ownership guards still prevent these draft writers from
changing managed canonical worktrees; published skill bundles must go through
the prepared skill writer. This checkpoint adds no storage migration.

## Remaining integration

The local skillopt command still needs a complete private whole-run allowance
and recovery lifecycle. The native bootstrap entry can run under an existing
host allowance; an ordinary standalone USD-budgeted CLI invocation is not
automatically admitted. Durable rollouts, candidate publication and full
optimizer recovery remain in [the skillopt integration](private-codex-skillopt.md).
The installed executable, production database and activation remain unchanged.
Live runtime isolation and subscription acceptance are still unverified.

## Deterministic verification

The shared fake-executable contract runs real bootstrap and guarded-entry code
on PGLite and isolated native PostgreSQL. It checks schema transport, host task
IDs, exact routing coverage, all check kinds, malformed output, unsupported
regexes, missing declarations, duplicate/contradictory rules, file bounds,
symlinks, input/output drift, pending review, cached recovery after a lost write
acknowledgement, explicit admission, exhaustion, strict pins and cancellation.
No real inference CLI, authentication file or provider is used.

| Command | Result |
| --- | --- |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-think.serial.test.ts` | 392 passed; 1,406 assertions |
| `python3 /tmp/maxbrain-test-postgres-think.py` | Same 392 passed and 1,406 assertions; disposable cluster stopped |
| `python3 /tmp/maxbrain-skillopt-bootstrap-regressions.py` | Five separate suites: 56 passed; 138 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 73 passed; admin build skipped; two integration issues found and corrected below |
| `python3 /tmp/maxbrain-stream-check.py bun run check:agent-contract` | Passed after switching the new refusals to the current error constructor |
| `python3 /tmp/maxbrain-stream-check.py bun run check:durable-flush` | Passed after using the shared cross-platform directory flush |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-think.serial.test.ts -t 'native skill benchmark generation'` | Final affected PGLite contract: 27 passed; 105 assertions |
| `python3 /tmp/maxbrain-test-postgres-bootstrap.py` | Final affected PostgreSQL contract: same 27 passed and 105 assertions; cluster stopped |
| `python3 /tmp/maxbrain-stream-check.py bun run typecheck` | Passed on the final source |
| `python3 /tmp/maxbrain-stream-check.py bun run build` | Compiled 3,698 modules |
| `git diff --check` | Passed |

The final affected-contract reruns include explicit symlink and open-file identity
checks as well as the portable directory flush and current error envelopes. They
use Linux filesystem fixtures; they do not claim a native Windows runtime test.
Full container CI, admin UI, PgBouncer and live subscription checks were not run.
This checkpoint adds no schema change, so storage migration replay was not rerun.
Logs use `/tmp/maxbrain-skillopt-bootstrap-`, including `contract.log`,
`postgres.log`, `regressions.log`, `verify.log`, `agent-contract.log`,
`durable-flush.log`, `final-focused.log`, `final-postgres.log`,
`final-typecheck.log` and `build.log`. The build is a development artifact only.
