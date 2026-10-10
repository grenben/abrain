# Private Codex evaluation runs

## Implemented boundary

The real LongMemEval command now enters a host-owned run lifecycle when invoked
under a durable subscription context. The owning database retains the run and
results; temporary benchmark brains can be reset or recycled. The installed
GBrain and production database are unchanged. Direct local CLI grant creation
and immutable auxiliary-budget identity are still separate integration work;
this module never infers permission from a dollar cap or JSONL file.

The v257 migration is registered and uses the same schema fragment for PGLite
and PostgreSQL. `codex_eval_runs` binds a protocol version, hash, question count,
required result stage, owner token and lease. `codex_eval_results` retains
bounded, hashed JSONB receipts keyed by run, question and stage. No receipt is
accepted from an error, degraded retrieval or failed judgment.

## Identity and recovery

The binding covers dataset bytes, selected question content/identities, parsed
material options, resolved retrieval/reader/judge/extractor identities and
private routing configuration. Output and input file locations are excluded;
the actual dataset and expansion-replay bytes are bound. Expansion replay is
captured once, bounded to 4 MiB, and parsed from that snapshot. Changing a path's
contents after admission cannot replace the consumed snapshot. Each run accepts
at most 1,000 questions and each result is bounded to 512 KiB.

One owner holds a 15-minute lease, renewed at host authority fences. Another
owner cannot claim it while live. Even after lease expiry, any active or
unresolved native attempt blocks recovery. There is no TTL release or refund of
a subscription attempt. Old tokens cannot retain results or settle completion.
An ambiguous attempt leaves the run `needs_reconciliation`; operator resolution
of that attempt is a prerequisite for restart.

The reader/retrieval result commits before judgment. A successful judgment has
its own immutable receipt. A failed judge does not become a negative verdict:
restart reuses the accepted reader and performs only the missing judgment,
subject to the original allowance. Full results commit before file emission.
A lost acknowledgement after commit reuses the receipt; it does not regenerate
the answer. The first failed private question stops the remaining batch.

On resume, JSONL is a derived export. A supplied question row must exactly match
a canonical host receipt. Error rows and summary lines cannot mark questions
done. Unsettled questions recover through their retained answers. Legacy or
edited rows do not acquire authority from matching model/config hash strings.
The same run identity cannot change its dataset, selected questions or settings.
Completed receipts can be exported after the subscription deadline because that
path performs no new inference or embedding; current host ownership still
applies. An incomplete expired run cannot make another paid/native call.

These guarantees cover host receipts and disposable derived data. They do not
claim distributed atomicity between host, scratch database and filesystem.
The canonical host receipts are authoritative if a JSONL write fails. Existing
non-private resume and judge-backfill behavior is preserved.

## Deterministic verification

Tests use synthetic data, fake Codex executables and forbidden-network guards.
No real credentials or inference CLI are used. Shared fixtures exercise the
actual command, changed request rejection, forged resume rows, replay after
expiry, judge failure, ambiguous completion, post-commit failure, exhaustion,
expired leases, competing owner tokens and captured replay bytes. Catalog and
migration-replay checks cover fresh and migrated isolated engines.

```bash
python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-think.serial.test.ts
python3 /tmp/maxbrain-test-postgres-think.py
python3 /tmp/maxbrain-test-postgres-calibration-schema.py
python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=240000 test/schema-catalog-golden.test.ts test/schema-migrations-replay.test.ts
python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify
python3 /tmp/maxbrain-stream-check.py bun run build
git diff --check
```

Live subscription, runtime isolation qualification, installed-worker consistency,
full CI, PgBouncer and admin UI remain outside these checks. Deployment requires
separate authorization, including installation, registered production migration
237, worker restart and explicit activation after the remaining acceptance gates.

### Checkpoint results

- Shared production-path contract: **241 tests / 861 assertions** on PGLite and
  independently **241 / 861** on native PostgreSQL.
- Nine legacy evaluation regression files: **96 tests / 808 assertions**.
- PGLite catalog and migration replay: **15 tests / 46 assertions**. Goldens
  were generated deliberately, then checked without update mode.
- PostgreSQL catalog and migration replay: **12 tests / 31 assertions**, with
  one PgBouncer case skipped because no isolated PgBouncer target is configured.
- Repository verification: **75 passes, zero failures**, with the external
  admin build explicitly skipped. Typecheck, architecture/size, registry,
  generated-schema and documentation checks pass. No ceiling was raised.
- Compiled build: **3,673 modules**. `git diff --check` passes.

Logs use `/tmp/maxbrain-native-eval-run-`: `contract-final.log`, `postgres.log`,
`regression-0.log` through `regression-8.log`, `schema.log`,
`pglite-schema.log`, `verify.log`, and `build.log`. The regression commands were
run serially by `/tmp/maxbrain-native-eval-run-regressions.py`, each with fresh
configuration and no credentials. An initial synthetic query included a token
absent from its fixture corpus, which correctly returned no evidence; the
fixture was corrected before the passing final contract. Verification proves
this source checkout, not an installed or live subscription deployment.
