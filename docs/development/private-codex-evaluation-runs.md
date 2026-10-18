# Private Codex evaluation runs

## Implemented boundary

The real LongMemEval command now enters a host-owned run lifecycle when invoked
under a durable subscription context. The owning database retains the run and
results; temporary benchmark brains can be reset or recycled. The installed
GBrain and production database are unchanged. The trusted local CLI creates explicit durable grants and binds independent
auxiliary budgets. This module never infers subscription permission from a
dollar cap or JSONL file.

The v275 migration is registered and uses the same schema fragment for PGLite
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
257, worker restart and explicit activation after the remaining acceptance gates.

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

## Explicit local CLI allowances

`gbrain eval longmemeval` accepts these trusted local flags:

- `--codex-max-attempts N` and `--codex-max-turns N`: integers from 1 to 1,000;
  turns cannot exceed attempts.
- `--codex-deadline UTC`: an absolute ISO UTC timestamp. New grants must end
  in the next 24 hours. Recovery supplies the exact original deadline.
- `--codex-request-id UUID`: optional for a new request, mandatory in practice
  for retrying the same allowance rather than creating another one. The CLI
  prints the generated ID after the grant/claim transaction commits.
- `--aux-max-usd N`: optional separate paid embedding/reranking cap. Omission
  authorizes no paid auxiliary calls. This is independent of the legacy
  `--max-usd` judge flag, whose default never authorizes private auxiliary work.

For example, after explicit deployment/activation and runtime qualification:

```bash
gbrain eval longmemeval synthetic.jsonl --keyword-only --no-trajectory \
  --no-embed-cache --output results.jsonl \
  --codex-max-attempts 10 --codex-max-turns 10 \
  --codex-deadline "<UTC-deadline-within-24-hours>" \
  --codex-request-id "<request-UUID>"
```

Flags are validated before opening an owner. The CLI uses the canonically
selected brain as the allowance/receipt owner, requires schema v275, and opens
it without startup migrations. It does not import benchmark pages there. Help
and explicitly pure keyword retrieval need neither a host connection nor an
allowance. Generative or hybrid work without allowance flags fails before an
owner is opened; an enclosing host context uses its existing allowance and
cannot add nested local flags.

Only after the actual dataset and effective settings are loaded does one
transaction create/reuse the allowance and claim the run. Missing data,
conflicting pins and changed request identities cannot create an unbound grant.
All local requests use the same account lane as jobs in that owner database.
This is not account coordination across unrelated owner databases.

The run binding now uses `codex-longmemeval-run-v2`. It includes each named
auxiliary budget's owner brain ID, stable key and cap, including inherited named
scopes. A changed cap/key/owner conflicts before dispatch. Storage protocol
remains v275/protocol 1; no additional migration is required. Earlier development
v1 bindings are not silently adopted: preserve their receipts and use an
explicit new request UUID for a v2 run. Do not rewrite old bindings or counters.
Unidentified custom invocation guards remain the enclosing host's responsibility;
they do not create local CLI allowances.

A new expired request is refused. An identical stored expired request can export
accepted receipts without extending its deadline or counters. Any missing work
still requires a live allowance. Reports retain null subscription cost/quota
and show the auxiliary cap separately. Neither failure nor exhaustion selects
an API generative fallback.

Additional checks run the shared allowance contract on both owner engines and
`test/ai/codex-eval-cli.serial.test.ts`: separate real CLI processes reuse one
stored answer with no second native call, preserve owner pages, and trigger no
network, unexpected subprocess or owner migration. Runtime qualification in
that test registers only its synthetic executable; the production qualified
hash registry remains empty.

## Local allowance verification checkpoint

All commands below ran from the development checkout with fresh temporary
HOME/GBRAIN_HOME/CODEX_HOME, discovery disabled, no real credentials and fake
native executables. The wrapper supplies that environment; temporary managed
fixtures use `TMPDIR=/var/tmp`.

| Command | Result |
| --- | --- |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-think.serial.test.ts` | 253 passed; 906 assertions |
| `python3 /tmp/maxbrain-test-postgres-think.py` | Same 253 passed; 906 assertions against disposable PostgreSQL; cluster stopped |
| `python3 /tmp/maxbrain-eval-allowance-regressions.py` | Seven independent suites: 66 passed; 1,287 assertions, including two real CLI processes with one fake Codex call |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-pins.serial.test.ts` | 10 passed; 51 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-upgrade-jobs.serial.test.ts` | 15 passed; 71 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 checks passed, including typecheck, architecture, size and generated registries; one admin build check explicitly skipped |
| `python3 /tmp/maxbrain-stream-check.py bun run build` | Compiled 3,676 modules |
| `git diff --check` | Passed |

The first CLI structural run exposed pin/job subcommand helpers placed in the
command-entrypoint directory. They now live in `src/cli/private-codex/`; the
existing command-table invariant passes without an exception. Logs use
`/tmp/maxbrain-eval-allowance-` with `contract.log`, `postgres.log`,
`regression-0.log` through `regression-6.log`, `pins.log`, `jobs.log`,
`verify.log` and `build.log`. No schema changed in this follow-up. Full container
CI, admin UI build and PgBouncer checks were not run. No installed executable,
production database, activation or live subscription behavior changed.
