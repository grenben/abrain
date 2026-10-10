# Private Codex take proposals

Source development only: this does not install, migrate or activate a brain.
The production runtime qualification registry is still empty.

## Production path

Strict private `propose_takes` uses the real gateway with a native JSON Schema.
The legacy injectable extractor cannot bypass it. Current CLI/DB/file/environment
and reasoning-tier routing go through the strict resolver. Conflicting explicit
models fail before dispatch. A host subscription envelope is required; USD-only
admission and provider fallback cannot authorize this path.

Each call accepts at most 48,000 page characters and 100 existing fence rows,
and proposes at most 20 claims of 8–200 characters. Output includes a known take
kind, bounded weight, holder, optional domain and exact source quotation.
Whole-batch semantic validation rejects duplicate/already-captured claims,
invented quotations, unsupported fields and holders absent from the evidence
(except the established `brain`/`world` labels). This establishes quote provenance,
not an independent proof that every paraphrase is logically supported.
No content repair or native agent loop runs here. Calls are bounded to 120 seconds
and the remaining host envelope; the phase handles at most 100 pages.

Private cache identity includes `codex-take-proposals-v1`, model, prompt version
and attribution/date-grounding flags. The cache also checks source incarnation.
A valid empty array writes a rejected sentinel with this identity. Invalid or
refused output never writes that sentinel or any partially accepted claim.
All failed judgments report failure; mixed results remain partial. Refusal or
missing terminal completion retains unresolved subscription ownership.

## Persistence and authority

Migration **v250** adds nullable `take_proposals.codex_evidence`. Private rows
retain exact quotation, page revision, source incarnation, host principal and
subscription run identity. Existing rows retain SQL NULL evidence. The model
cannot provide authority or operation IDs. Proposed takes remain pending review;
this phase does not modify canonical takes or auto-accept claims.

`persistTakeProposalBatch` commits a private page's entire proposal batch (or its
valid-empty sentinel) in one existing maintenance transaction. It checks the
host claim, locks active source identity, rechecks current writer permissions
and compares the input page revision/body before insertion. An error inserting
the second claim rolls back the first. A committed batch is found by the page
cache on rerun, so a later phase does not regenerate it. A rolled-back
batch may be re-extracted within a separately admitted attempt.

Publication errors stop further pages and preserve counts of earlier committed
work. Optional receipt pages use the original writer ceiling and current grant,
source identity and host claim inside their own transaction. Receipt failure
cannot undo proposals or pretend they never committed; it produces a warning.
Receipts and rollups are grouped by source. Receipts use unknown/null subscription
USD, and rollups distinguish failed rounds from completed rounds. Managed brains
keep their existing receipt-page omission. Canonical take acceptance and its
prepared-write recovery remain a separate path requiring further acceptance.

## Verification and limitations

`test/helpers/codex-take-proposals-contract.ts` runs the production phase, gateway
and persistence through a hash-qualified synthetic executable. It captures argv,
stdin and schema, blocks network fetches and uses fresh credential-free homes.
Fixtures cover source scope, evidence and model provenance, cache reuse, valid
empty results, whole-batch rejection, SQL-trigger-induced partial insertion
failure, stale revisions, writer revocation, receipt grant restrictions and
unresolved inference. These are deterministic fixtures, not live Codex calls.

PostgreSQL
tests use an authorized disposable cluster and stop it afterwards. No production
schema or installed executable is changed. Deployment still needs the verified
source build, reviewed migrations v243–v250 as applicable, runtime qualification,
authorized isolated live acceptance and explicit activation.

### Commands and results

All commands ran through an environment scrubber with fresh HOME/GBRAIN_HOME/
CODEX_HOME, discovery disabled and test env-file loading disabled. Native fixture
scratch used `/var/tmp`; no real inference binary or credential was used.

| Command | Result |
|---|---|
| `bun test --timeout=60000 test/ai/codex-take-proposals.serial.test.ts test/extract/receipt-writer.test.ts` | 30 passed, including all 16 private proposal cases |
| `bun test --timeout=60000 test/propose-takes.test.ts test/propose-takes-per-claim.test.ts test/propose-takes-served-model.test.ts test/propose-takes-truncation.test.ts test/propose-takes-config-max-tokens.test.ts` | 127 passed |
| `bun test --timeout=60000 test/schema-catalog-golden.test.ts test/schema-bootstrap-coverage.test.ts test/schema-migrations-replay.test.ts test/migrations-fresh-install.test.ts` | 39 passed, golden regeneration disabled |
| `bun test --timeout=240000 test/e2e/codex-take-proposals.test.ts test/e2e/schema-catalog-golden.test.ts` | 24 passed, 1 PgBouncer check skipped; fixed goldens, fresh PostgreSQL 16 cluster stopped afterwards |
| `bash scripts/check-test-discriminates.sh test/ai/codex-take-proposals.serial.test.ts src/core/cycle/propose-takes.ts` | Previous source `40a84d3`: 7 passed / 9 failed; restored source passes |
| `GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 passed, 0 failed, 1 admin UI skip |
| `bun run typecheck` | Passed after final timeout/rollup changes |
| `bun run build` | Passed, 3,618 modules |
| `git diff --check` | Passed |

Schema goldens were first regenerated and reviewed: each changed catalog adds
only the nullable evidence column. Both engines then passed with regeneration
disabled. An initial fixture queried the root engine from a transaction and
stalled; only that identified synthetic process was stopped, and the fixture
now uses its transaction handle. The legacy tombstone assertion now checks the
bound status value instead of looking for a SQL string literal.

Native process-crash injection, live subscription quality and canonical proposal
acceptance are not established by these fixtures. The repository's admin UI and
PgBouncer checks remain unavailable here; neither is counted as passed.
