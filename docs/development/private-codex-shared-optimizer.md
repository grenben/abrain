# Native shared optimizer publication
> **Historical checkpoint:** This document describes the private 0.60.317.0 source lineage, not validation or activation of the upstream synchronization. Private migrations v261–v290 are being ported as v315–v344; integration remains in progress.

Say to your agent: “Verify native shared-skill optimization in an isolated test
brain, including interrupted publication and concurrent edits. Keep my installed
brain unchanged.” This checkpoint documents source development; it does not
activate private mode or qualify live Codex inference.

## Behavior

The existing shared-skill optimizer entry now selects a native implementation
when trusted private configuration is enabled. It requires the original trusted
local operation context, an explicit host subscription allowance and a scoped
native tool registry. The current registry permits `get_page` within the caller's
approved prefixes. The model cannot choose the source, revision, request identity,
publication permissions or canonical paths.

Preflight preserves the existing active canonical-owner, source incarnation,
full dependency approval, current revision, filesystem closure, bundled-skill
holdout and mutation-consent checks. Native evaluation input reads accept bounded
regular files and reject symlinks, hard links and nonregular files. The complete
approved closure and benchmark bytes are retained in an immutable plan. Private
staging uses owner-only directories/files, bounded exact-byte verification and
exclusive publication of flushed temporary files. Partial staging can finish
only from absent or matching files; changed staging refuses before inference.

The existing native whole-run optimizer evaluates this staging through its
retained task jobs, aggregate allowance and sequential host action loop. The
shared wrapper retains the accepted result before submitting any canonical write.
It replaces only SKILL.md in the original approved closure and preserves dependency
files and protected metadata. Candidate validation remains mandatory.

## Publication and recovery

Migration **264** registers `codex_shared_skill_optimizations`, immutable identity
hashes, leased ownership, accepted results, complete write admissions and final
responses. The original skill revision stays protected from pruning for the
lifetime of its permanent optimizer record. A future archival protocol must
retire this dependency before those records can be removed safely.

Canonical writes use the existing prepared skill-bundle coordinator with new
**publication protocol 6**. Admission and its complete retained identity commit
in one transaction. The consumer rechecks the current optimizer lease, root
deadline, private runtime/model and, when present, the worker's current job fence
before effects. Older consumers refuse this protocol. Existing authority,
revision compare-and-swap, bundle recovery, receipts and indexing effects remain
part of publication.

A retry with the same request uses the retained staging, optimizer progress,
accepted result and write receipt. It does not regenerate content or reset the
subscription counters. A committed receipt with a lost final acknowledgement can
be recovered. Reusing the identity with changed inputs refuses. Concurrent edits
remain intact. A stale owner cannot publish or clear its replacement's lease.
A failed or unsettled write is an explicit error, never successful optimization.
An interrupted bundle is reconciled through the existing recovery record; this
is not filesystem/database transactional atomicity.

No-mutate runs retain their proposal without changing the canonical skill.
Subscription cost remains null; no API/provider fallback is introduced.

## Verification

The shared contract in `test/helpers/codex-shared-optimizer-contract.ts` drives the
actual optimizer, native fake executable, durable task/action jobs and canonical
prepared writer. It uses synthetic skills and fresh isolated state, with model
discovery disabled, credentials absent and a network tripwire. Each accepted
fixture makes 66 fake calls; replay asserts that this count does not increase.

Covered boundaries include staging loss, result persistence loss, admission loss,
committed-write acknowledgement loss, stale owner replacement, concurrent canonical
revisions, rollback/reconciliation after file publication, changed inputs and
no-mutate behavior. Additional cases cover cancellation before admission and unsafe evaluation files. These injected exceptions do not prove OS process-kill recovery
or live subscription behavior.

Verified commands (the `/tmp` wrappers supply fresh homes, no credentials and,
for PostgreSQL, create and stop a disposable cluster):

- `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-actions.serial.test.ts -t 'native shared optimizer publication' --timeout=180000`: ten cases passed, 60 assertions before the two final boundary additions.
- Full action/optimizer contracts before those final two additions: `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-actions.serial.test.ts --timeout=180000` and `python3 /tmp/maxbrain-test-postgres-group-actions.py`: 101 passed, 475 assertions on each engine.
- Final boundary cases: `bun test test/ai/codex-actions.serial.test.ts -t 'unsafe native evaluation files|cancellation before admission' --timeout=180000` through that isolated wrapper, and `python3 /tmp/maxbrain-test-postgres-shared-boundaries.py`: two cases passed, 12 assertions on each engine.
- `python3 /tmp/maxbrain-test-postgres-calibration-schema.py`: migration/catalog replay parity, 12 passed, 31 assertions; PgBouncer skipped.
- Isolated `bun test test/shared-skills-optimizer.serial.test.ts --timeout=180000`: legacy optimizer, 15 passed, 2,508 assertions.
- Isolated `bun test test/shared-skills-retention-capacity.test.ts --timeout=180000`: PGLite capacity, one passed, 12 assertions; native PostgreSQL case skipped in that invocation.
- `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify`: 75 passed, no failures; admin UI build explicitly skipped. Includes architecture, sizes, generated schema, registry and typecheck gates.
- `python3 /tmp/maxbrain-stream-check.py bun run typecheck`: passed again after final source/test edits.
- `python3 /tmp/maxbrain-stream-check.py bun run build`: compiled 3,722 modules successfully. `bun run check:doc-history` and `git diff --check` passed.

## Limits and upgrade handoff

The trusted local SDK/host-scope path now also has explicit
[CLI and background producers](private-codex-shared-producers.md). Remote producers
still need separate admission and authority binding. Production runtime qualification remains empty. Full container CI,
admin UI build, PgBouncer and live inference acceptance remain separate checks.

The installed GBrain executable, database, services and configuration are unchanged.
A later authorized deployment must build this branch, apply registered migrations
through 264 on the intended target, and cut over compatible consumers after the
remaining acceptance gates pass. Do not run older consumers on native requests.
No production migration, installation, restart, inference or activation occurred.
