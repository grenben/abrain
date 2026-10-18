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

Migration **v280** adds nullable `take_proposals.codex_evidence`. Private rows
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
keep their existing receipt-page omission. Canonical acceptance uses the separate
operator-reviewed path described below.

## Canonical acceptance and recovery

`acceptProposal` recognizes private proposal metadata even if private inference
has since been disabled. Acceptance itself makes no model call. It requires the
retained quotation, content hash, revision and source incarnation; missing legacy
private evidence refuses instead of silently using the legacy acceptance path.
The original proposal remains unchanged when the reviewer edits claim, kind,
holder or weight. Canonical provenance names the proposal and marks edits.

`take-proposal-codex-plan.ts` freezes reviewer inputs and a host-generated request
UUID, together with a fingerprint of the original proposal and evidence. The plan
lives in v230's existing JSONB evidence column; no additional migration is needed.
`take-proposal-codex-accept.ts` uses the existing page preparation, authorization,
journal admission and coordinated publication. A locked transaction commits the
proposal claim, frozen plan and journal request together. This also serializes
acceptance by distinct local writer identities. An insertion failure rolls back
all three; no canonical effect has been authorized yet.

A retry reconciles the retained receipt before checking an old page revision:
its own successful write changes that revision. Omitted edits reuse the frozen
review; conflicting explicit edits or changed proposal evidence fail. Receipt
identity and intent digest must match, including after receipt compaction and
when a different currently authorized writer resumes. Only a committed receipt
with an actual canonical row number permits the completion stamp. The final
transaction locks and revalidates the proposal again, so a concurrent proposal
change leaves its committed receipt intact without stamping changed inputs. A failure
between effect commit and that stamp resumes the same receipt without appending
another take. Pending, failed, missing or ambiguous receipts never cause fresh
admission under a new principal or request ID.

Before new admission, the source must still be active and the body hash, exact
quote and page revision must match. Admission checks expected source incarnation;
the existing journal locks/rechecks source and authority, and the consumer checks
the expected revision before effects. Changed pages need fresh reviewed proposals,
including other proposals from a batch after one acceptance changed their page.
Historical stranded private claims without a retained plan require explicit
reconciliation. An admitted failed write stays retained for inspection; acceptance
does not implicitly regenerate proposals or blindly retry it. Non-private
proposal behavior remains on its existing path.

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
source build, reviewed migrations v273–v250 as applicable, runtime qualification,
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

Native process termination and live subscription quality are not established by
these fixtures. Canonical acceptance has additional deterministic checks below. The repository's admin UI and
PgBouncer checks remain unavailable here; neither is counted as passed.

### Canonical acceptance checkpoint

`test/codex-take-accept.serial.test.ts` starts with the real private proposal
persistence seam and publishes through a fresh managed brain. The PostgreSQL
wrapper exercises the same contract. All content, registrations and subscription
allowances are synthetic. A network tripwire is active and no inference CLI is
on the scrubbed executable path.

Coverage includes reviewed edits, source quotations, stale revisions, source
identity checks, writer revocation, concurrent distinct writers, real receipt
compaction and writer rotation, proposal changes before locked admission, extra
retained fields, and missing/ambiguous receipts. SQL triggers inject journal
insertion failure and completion-stamp failure. A transaction wrapper injects an
exception immediately after committed admission, before waiting for effects;
the queued request is then recovered through the real consumer. These are
controlled fault injections, not a claim of OS-level process-crash coverage.

| Command | Result |
|---|---|
| `bun test --timeout=60000 test/codex-take-accept.serial.test.ts` | 19 passed, 82 assertions |
| `bun test --timeout=240000 test/e2e/codex-take-accept.test.ts test/e2e/takes-propose-accept-managed.test.ts` | 23 passed, 99 assertions; fresh PostgreSQL cluster stopped afterwards |
| `bun test --timeout=60000 test/take-proposals.test.ts test/takes-propose-accept-managed.test.ts` | 24 passed, 84 assertions |
| `bash scripts/check-test-discriminates.sh test/codex-take-accept.serial.test.ts src/core/take-proposals.ts src/core/persistence/page-mutations.ts` | At the 18-case checkpoint: pre-change source `1fb3a92` gave 6 passed / 12 failed. Restored source passed all 19 final cases, including the added completion-race case. |
| `GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 passed, 0 failed, 1 admin build skip; includes final typecheck, architecture, size, registry and documentation checks |
| `bun run build` | Passed, 3,620 modules |
| `git diff --check` | Passed |

The first fixture run exposed two fixture errors: a missing revision on an update
and a synthetic writer rewrite inconsistent with compaction counters. The corrected
fixtures use a conditional page update and real local writer rotation. An initial
test-only fetch cast failed typecheck and was corrected. Admin UI, PgBouncer,
full CI and live runtime acceptance are not established by this checkpoint.
The installed executable, production database and activation remain unchanged.
