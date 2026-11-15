# Private Codex workflow recovery evidence
> **Historical checkpoint:** This document describes the private 0.60.317.0 source lineage, not validation or activation of the upstream synchronization. Private migrations v261–v290 are being ported as v315–v344; integration remains in progress.

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

Those first three optimizer cases use an **unmanaged synthetic skill**. The
additional managed-publication and scheduled-cycle cases below exercise their
own entrypoints and receipts. They still do not qualify a deployed background
service or a maintenance pass containing all other GBrain phases.

## Managed publication and scheduled optimizer cycle

`test/helpers/codex-managed-cycle-process-crash.ts` adds four restart boundaries:

- **Shared result:** kill after the optimizer result is durable, before canonical
  publication admission. Recovery publishes the original accepted proposal.
- **Shared committed:** kill after the canonical skill bundle commits, before
  the outer optimizer saves its final response. Recovery reuses that receipt.
- **Cycle first draft:** kill after the first of two selected skills writes its
  review draft, before that member's transaction completes. Recovery reconciles
  the first draft and completes the second skill.
- **Cycle complete:** kill after the cycle's completion and cooldown are durable,
  before the queued maintenance handler records its overall success stamp.
  Recovery reuses the completed batch and preserves the original cooldown time.

Shared cases use the real queued shared optimizer and protocol-6 publication
coordinator. Assertions require the same stage, input hash, request ID and grant;
one committed optimization receipt; exactly the original and optimized skill
revisions; matching canonical file/catalog bytes; and unchanged benchmark and
reference files. Recovery and repeated submission stay at 66 simulated calls.

Cycle cases use the real queued global-maintenance handler and cycle dispatcher
with only the `skillopt` phase selected. They retain two sorted members under one
root allowance. A third candidate added after the kill cannot enter the retained
selection. Both original skill files remain unchanged, each selected skill gets
one review draft, and the new candidate gets none. The full two-skill workflow
uses 410 simulated calls: 10 deep optimizer calls and 400 subagent calls. Recovery
after the first draft adds only the second skill's 205 calls; recovery after
cycle completion adds none. Repeating the handler also makes no additional calls.
The global success stamp is absent before recovery and appears only after the
real handler receives a successful phase result.

The cycle has an additional same-host dead-holder grace period. The fixture
confirms that the recorded holder PID is dead, then waits for the real
`HOLDER_TAKEOVER_GRACE_MS` window before normal takeover. It neither deletes the
cycle lock nor changes its timestamps. Only the longer dead job, optimizer and
batch leases are advanced to simulate expiry. This distinction matters: an
immediate restart can correctly report `cycle_already_running` during the grace
window. These tests do not establish full production restart latency.

## Running the lane

Use the [isolated scratch preflight](../../test/ai/README.md). For PGLite, run:

```sh
bun --no-env-file test test/ai/codex-actions-process-crash.slow.test.ts
```

The file includes three queued-action cases (retained read, write before
admission, write after canonical commit), three standalone optimizer cases,
two managed shared-publication cases and two scheduled optimizer-cycle cases.
The PostgreSQL wrapper runs those same ten cases, each in a new disposable
database. Follow the [E2E database lifecycle](../TESTING.md#e2e-test-db-lifecycle-always-follow-this)
and pass only an explicitly provisioned test database URL:

```sh
bun --no-env-file test test/e2e/codex-actions-process-crash.test.ts
```

A missing database URL skips that wrapper; a skip is not PostgreSQL evidence.
The prior six-case lane passed on both engines; the current handoff records the
expanded lane's exact commit, results and test-cluster shutdown. A prior mutation
probe removed exact-byte file reconciliation only in a disposable source copy;
the post-write recovery case failed as expected. The unchanged application passed.

The initial new fixture run failed because it compared stalled-job objects with
numeric IDs. The corrected assertion checks their IDs and reads claim generation
from the database, where that field is exposed. No application behavior changed
to obtain passing tests. Sanitized handoff receipts retain that initial failure,
the mutation result, tested source hashes and final checks; raw fixture logs and
databases remain local. The first expanded fixture also attempted cycle recovery
before the real dead-holder grace had elapsed; those two refusals are retained.
The corrected fixture waits through that protection. Initial fixture-only type
errors were corrected without changing application runtime behavior.

## Remaining migration gates

This covers the named deterministic process-restart boundaries, including
completed managed publication and a two-skill optimizer-only maintenance pass.
It does not close full live optimizer/held-out-quality acceptance, a maintenance
pass spanning all other phases, mid-publication managed-file/SQL interruption,
production worker lifecycle or protected real-data acceptance. Auxiliary vector
stages and a complete nightly probe remain separate, explicitly budgeted work.

Fresh selected-content rehearsal, paired database/content/configuration backup
and restore/rollback, service-switch preparation, graph catch-up, sync baseline,
target-runtime qualification and controlled activation remain required. Production
Codex roles and schedules remain disabled; no live data, installed application,
service, credential or production setting changes as part of this test lane.
