# Native Codex optimizer workflow checkpoint
> **Historical checkpoint:** This document describes the private 0.60.317.0 source lineage, not validation or activation of the upstream synchronization. Private migrations v261–v290 are being ported as v315–v344; integration remains in progress.

This checkpoint implements the private optimizer core in source. It is not an
installed upgrade or evidence of live subscription inference.

## Actual dispatch and algorithm

The real `runSkillOpt` entry selects `codex-run.ts` under explicit strict private
configuration. It requires an enclosing durable root subscription grant, the
original trusted local operation context and an explicit read-tool/prefix scope.
Ordinary USD caps cannot grant subscription calls. Current tool coverage remains
`get_page`; broader read tools, remote delegation, ablations and write capture
are incomplete and fail explicitly.

Both patch and rewrite modes run baseline evaluation, training rollouts,
schema-constrained reflection, selection validation, optional independent held-out
validation and final tests. The implementation reuses the existing deterministic
split, learning-rate schedules, body-only edits, rejected-edit identity,
median-of-three and epsilon acceptance rules. Held-out regression prevents
acceptance. Valid empty proposals return `no_improvement`; refusal, malformed
output, failed admission and failed evaluations throw instead of creating scores.

The existing benchmark validator now also accepts a bounded in-memory snapshot,
so the native run does not reopen mutable files while parsing. Bootstrap review,
selection-size, disjoint held-out, bundled-mutation and model-provenance gates
remain enforced. The declared bounds are 100 benchmark tasks, 100 held-out tasks,
20 epochs, 20 tasks per batch, 20 edits per step, 100 steps, a 12,000-byte initial
skill, and the existing smaller transport/history limits. A run can also exhaust
its granted calls/turns before those upper bounds. Inputs fail explicitly rather
than being silently truncated.

## Durable progress and publication

Registered migration **242** adds `codex_skillopt_runs` on both engines. It retains
the complete input snapshot/hash, deadline, fenced owner lease, checkpoint,
accepted result and hashes. Repetition IDs feed the child-job protocol added in
migration 279. Retries reuse its original histories, proposal caches and completed
stages. Runtime/model changes stop a run before another call. Active or unresolved
attempts block recovery and retain their subscription account lane.

Checkpoint commits preserve best text, genuine scores, rejected edits and
decisions. The accepted final result is recorded **before** file effects. A stale
owner cannot advance checkpoints or publish. Publication holds the current
authority/optimizer fence and a per-path database advisory lock, rechecks the
input files and directory identity, then uses the existing owner-only atomic
draft writer and directory flush.

For an unmanaged skill, an authorized mutation updates `SKILL.md`; no-mutate
mode writes `skillopt-proposed.md` beside it. That native draft path is returned
explicitly. The original bytes and accepted bytes remain in the durable plan.
After a file write followed by SQL rollback or lost acknowledgment, exact accepted
bytes reconcile the same plan without more inference. Different user edits fail
revision checks and are preserved. A filesystem effect is not rolled back by SQL;
these are per-file recovery guarantees, not a transaction spanning filesystem and
database. Uncoordinated external filesystem writers must still be quiesced during
publication. Native history lives in the database, not the legacy version-store
files.

Managed canonical roots retain the existing writer guard. The shared-skill wrapper
still stages outside canonical roots and publishes through the existing prepared
coordinator. Its whole-run staging/request recovery is **not yet integrated** with
this native run; the standalone recovery tests do not prove that shared path.

`candidate.ts` reuses the shared publication validator for protected frontmatter,
nonempty bodies and balanced Markdown fences. Native reflection/rewrite proposals
apply it before cache acceptance. Their cache version is now
`codex-skillopt-reflect-v2`, so older semantic contracts are not reused silently.

## Accounting and diagnostics

Receipts have `final_cost_usd: null`, unknown remaining quota, aggregate admitted
attempts/turns, measured token subtotals and a count of attempts lacking usage.
Tokens are summed from actual attempt rows across the root and its children once.
Allowance root/child counters are not summed as independent spend. Job diagnostics
identify subscription admission explicitly; CLI receipt formatting does not
print unknown subscription cost as `$0.00`. Paid auxiliaries remain independently
admitted; the current scoped page-read registry performs none.

## Deterministic verification

Fixtures use synthetic files/pages, fresh homes, fake qualified Codex executables,
disabled discovery and a forbidden-network tripwire. Every PostgreSQL target is
a disposable authorized local cluster, stopped after testing.

| Command | Result |
| --- | --- |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-actions.serial.test.ts` | 72 passed, 309 assertions, including 12 new whole-workflow cases |
| `python3 /tmp/maxbrain-test-postgres-group-actions.py` | Same 72 passed, 309 assertions; cluster stopped |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-actions.serial.test.ts -t 'stale optimizer owner\|edit made after validation'` | Two additional final cases passed, 12 assertions |
| `python3 /tmp/maxbrain-test-postgres-optimizer-final.py` | Same two cases and assertions on PostgreSQL; cluster stopped |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-actions.serial.test.ts -t 'changing the configured runtime mid-run'` | Final runtime binding: 1 passed, 4 assertions |
| `python3 /tmp/maxbrain-test-postgres-optimizer-runtime.py` | Same runtime test on PostgreSQL; cluster stopped |
| `python3 /tmp/maxbrain-optimizer-regressions.py` | 35 isolated legacy/shared-publication suites: 406 passed, 3,668 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-think.serial.test.ts -t 'native skill optimization proposals'` | Final versioned reflection contract: 29 passed, 84 assertions |
| `python3 /tmp/maxbrain-test-postgres-calibration-schema.py` | Migration/catalog/replay parity: 12 passed, 31 assertions; PgBouncer skipped |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 passed; admin UI build explicitly skipped |
| `python3 /tmp/maxbrain-stream-check.py bun run typecheck` | Passed |
| `python3 /tmp/maxbrain-stream-check.py bun run build` | Development executable compiled |
| `git diff --check` | Passed |

The final shared contract contains 15 optimizer cases. Focused reruns verify the
three additions and final runtime fence; a full 75-case rerun was not needed.
Logs use `/tmp/maxbrain-optimizer-`. Full container CI, PgBouncer, admin UI and
live subscription/runtime acceptance were not run.

## Remaining work and installation

The subsequent [CLI admission checkpoint](private-codex-skillopt-cli.md) connects
single foreground commands to explicit root grants and read scopes. The
[background-job checkpoint](private-codex-skillopt-jobs.md) adds retained queue
submission and worker execution. Next integrate cycle, batch/fleet, bootstrap
and remote producers, plus durable shared-skill staging and
prepared-publication recovery. Those paths must preserve independent budgets,
source grants and stable identities rather than creating fresh allowances.
Broader tool coverage and real runtime qualification also remain incomplete.

Migration 280 was applied only to disposable test databases. No production
database, installed executable, pin or service was changed. Installation,
migration of the real target, worker cutover, live checks and activation remain
separate upgrade steps. The production runtime qualification allowlist is empty.
