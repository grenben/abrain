# Private Codex workflow recovery evidence

The deterministic recovery lane exercises real application entrypoints, queued
optimizer jobs, durable allowances, native proposal validation and file writes
using synthetic data and fake Codex executables. It does not activate production,
use subscription calls or qualify model quality.

## Process termination and restart

`test/helpers/codex-optimizer-process-crash-runner.ts` starts separate seed,
worker and recovery processes. The worker reports readiness only after the
selected production seam has completed; the parent then sends SIGKILL and checks
the actual exit signal. Its three optimizer cases stop after:

1. The first evaluation checkpoint commits, with 15 completed native proposals.
2. The accepted result commits, with all 66 proposals complete and the skill
   file still unchanged.
3. The accepted skill bytes are written, while the enclosing publication
   transaction has not completed.

A fresh process opens the same database. It first confirms that another worker
cannot claim the still-leased job. After the killed process has exited, the test
advances only the queue and optimizer lease timestamps to simulate elapsed time.
The normal stalled-job handler requeues that same job, and a new claim resumes it.
No job identity, progress, accepted result, deadline, allowance or attempt counter
is deleted, reset or refunded. This tests recovery after lease expiry; it does not
measure how long automatic recovery takes on a deployed service.

The final assertions require the original submission, optimizer run and input
hash; unchanged grant identity, deadline and limits; a newer worker claim;
66 attempt rows and accepted turns; and exactly one skill-file write through the
normal draft writer. The checkpoint case makes the remaining 51 proposals;
result/file recovery makes none. Repeating submission returns the completed job
without more calls. Distinct fake tier pins verify one deep optimizer call and
65 subagent calls. Rule-based scoring needs no model judge in this fixture.

The optimized file is an **unmanaged synthetic skill**. These cases do not prove
OS-kill recovery for managed shared-skill bundles, a complete scheduled cycle,
multi-skill publication or a live background service. Existing shared contracts
cover injected failures in those paths separately; do not combine the two forms
of evidence into a claim that every workflow has process-kill coverage.

## Running the lane

Use the [isolated scratch preflight](../../test/ai/README.md). For PGLite, run:

```sh
bun --no-env-file test test/ai/codex-actions-process-crash.slow.test.ts
```

The file includes three queued-action cases (retained read, write before
admission, write after canonical commit) and the three optimizer cases above.
The PostgreSQL wrapper runs those same six cases, each in a new disposable
database. Follow the [E2E database lifecycle](../TESTING.md#e2e-test-db-lifecycle-always-follow-this)
and pass only an explicitly provisioned test database URL:

```sh
bun --no-env-file test test/e2e/codex-actions-process-crash.test.ts
```

A missing database URL skips that wrapper; a skip is not PostgreSQL evidence.
The isolated local PostgreSQL run passed all six cases and stopped its own test
cluster afterward. The three new PGLite cases also passed. A mutation probe
removed exact-byte file reconciliation only in a disposable source copy; the
post-write recovery case failed as expected. The unchanged application passed.

The initial new fixture run failed because it compared stalled-job objects with
numeric IDs. The corrected assertion checks their IDs and reads claim generation
from the database, where that field is exposed. No application behavior changed
to obtain passing tests. Sanitized handoff receipts retain that initial failure,
the mutation result, tested source hashes and final checks; raw fixture logs and
databases remain local.

## Remaining migration gates

This closes a deterministic optimizer process-restart coverage gap. It does not
close full live optimizer/held-out-quality acceptance, complete-cycle and managed
bundle process recovery, production worker lifecycle or protected real-data
acceptance. Auxiliary vector stages and a complete nightly probe also remain
separate, explicitly budgeted work.

Fresh selected-content rehearsal, paired database/content/configuration backup
and restore/rollback, service-switch preparation, graph catch-up, sync baseline,
target-runtime qualification and controlled activation remain required. Production
Codex roles and schedules remain disabled; no live data, installed application,
service, credential or production setting changes as part of this test lane.
