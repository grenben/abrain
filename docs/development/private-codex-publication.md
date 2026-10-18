# Private Codex publication checkpoint

This source checkpoint implements bounded **pattern publication**. It does not
activate private mode or qualify the installed Codex runtime. The subsequent
[synthesis checkpoint](private-codex-synthesis.md) adds bounded synthesis and the
transcript → triage → reflection → pattern fixture.

## Implemented path

Under explicit strict private configuration, `runPhasePatterns` selects
`runPrivatePatterns` before the legacy probe and agentic queue. Managed persistence
and an active source with an authorized local writer are required. A new proposal
also requires a durable subscription allowance. Recovery reads the accepted plan
before considering new evidence or making another inference call.

One native-schema proposal considers at most 100 public, non-quarantined source
pages, with a 600-byte excerpt each. It proposes at most eight new `note` pages.
The complete response is validated before retention: output prefix and slug grammar,
nonempty content, distinct evidence, exact quotations, and explicit source-scoped
wikilinks. Other link markup and model-authored authority are refused. Existing or
deleted targets are never overwritten. Schema, lifecycle, or semantic failures fail
explicitly; there is no content repair, agentic fallback, or provider fallback.

Migration **v261** adds an immutable accepted-plan payload with a digest, source
incarnation, protocol version, and a unique pending slot per source/incarnation/kind.
The host stores writer authority, evidence identities/revisions, expected target
revisions, complete page contents, and the intended watermark. Source purge cascades
the retained content with its source. Ordinary reads do not migrate the database.

Each page has a deterministic request UUID derived from its plan and ordinal. The
existing persistence journal returns the canonical request identity and rejects
changed intent. The existing coordinator handles file publication, receipts, source
ownership and indexing debt. Evidence is locked and revalidated in the same
publication transaction as the page and its source-scoped `derived_from` links.
The proposal includes host-generated quotations and provenance frontmatter.

The batch is **not atomic**. After a partial commit, recovery reuses the same plan
and receipts. It never asks the model to regenerate the remaining pages. A pending
or failed receipt leaves the plan accepted and requires reconciliation; no
watermark advances. A clean-zero proposal still retains a plan and rechecks the
evidence before completion. Completion requires every planned page's committed
receipt. Cancellation preserves already committed effects and the recovery plan.

Worker publication checks lock the current job claim in each admission transaction
and in plan retention/completion. The journal's host fence runs again after a
connection loss, including when the retry changes transaction lanes. Once admitted,
a prepared write remains owned by the persistence coordinator for recovery.

## Deterministic evidence

`test/helpers/codex-publication-contract.ts` drives the real pattern dispatcher,
gateway, fake Codex executable, plan table and prepared-write/file/receipt paths on
PGLite and PostgreSQL. It covers valid publication, full-proposal rejection,
clean zero, partial commit recovery without another call, conflicting plans,
changed inputs/evidence, existing targets, cancellation and source archival.
`codex-job-contract.ts` tests actual worker ownership changes against the publication
fence; `persistence-admission-connection-loss.test.ts` checks that this fence survives
an uncertain admission and transaction-lane replacement.

All inputs are synthetic, environments are scrubbed, discovery is disabled and
network inference is forbidden. The production runtime qualification registry stays
empty. Passing these tests proves the checkout, not subscription availability or an
upgrade of the installed brain.

### Verification commands and results

All commands below ran in scrubbed environments in the isolated development
checkout. No installed brain or production database was opened.

- `bun test --timeout=60000 test/ai/codex-publication.serial.test.ts`: **16 passed**.
- `bun test --timeout=60000 test/ai/codex-jobs.serial.test.ts`: its shared contract
  passed **23 tests**, including transactional worker fencing, in the earlier
  41-test focused run with publication and admission reconnect tests.
- `bun test --timeout=60000 test/ai/codex-publication.serial.test.ts test/persistence-admission-connection-loss.test.ts test/managed-maintenance.test.ts test/managed-maintenance-links.test.ts test/cycle-patterns.test.ts test/cycle-patterns-source-scope.test.ts test/schema-bootstrap-coverage.test.ts test/schema-catalog-golden.test.ts`:
  **86 passed**, before the final completed-plan replay fixture was added.
- `bun test --timeout=240000 test/e2e/codex-publication.test.ts test/e2e/codex-subscription-jobs.test.ts test/e2e/schema-catalog-golden.test.ts`:
  **46 passed**, one optional PgBouncer check skipped; catalog regeneration disabled.
  After the completion guard was tightened, the publication file alone passed all
  **16 tests** on a fresh PostgreSQL cluster. Every cluster was stopped afterward.
- `bun run typecheck` and `bun run build`: passed after the final source changes.
- `GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify`: **74 passed**, one function-size failure,
  one explicit admin-build skip. Queue cleanup was extracted without raising any
  ceiling, removing the old dispatcher exception; `bun run check:function-size`
  then passed. Thus all 75 exercised checks passed across these runs.
- `git diff --check` and `git diff --cached --check`: passed.

Counts overlap. An extra combined run incorrectly put
`cycle-patterns-completed-outcome.serial.test.ts` in the legacy pattern test process;
its module mock polluted a provider-gate expectation. The completed-outcome fixture
passed, and `cycle-patterns.test.ts` passed separately afterward, following the
repository's one-process-per-serial-file rule. No production behavior was changed
to accommodate the mixed-process failure. Admin UI build and transaction-mode
PgBouncer remain unverified in this checkpoint; neither was provisioned here.

## Remaining limitations and upgrade handoff

- Bounded private synthesis now uses this retained-plan path; its coverage and
  remaining limits are recorded in the [synthesis checkpoint](private-codex-synthesis.md).
- Patterns v1 creates new public notes. Updating existing patterns needs a separately
  validated edit proposal and conflict workflow; it currently refuses such proposals.
- An accepted plan with a terminal conflict blocks new proposals for that source.
  Operator inspection/repair tooling for parked plans remains incomplete. Do not delete
  plan/receipt rows to bypass reconciliation.
- Full queue-handler publication races, process-crash injection at every persistence
  seam, cross-worker database contention and live cancellation acceptance remain open.
- No migration was applied to the installed database. Future authorized deployment
  must include v261, a consistent executable across workers, and the broader runtime,
  routing, accounting and action-loop gates in the status document.
