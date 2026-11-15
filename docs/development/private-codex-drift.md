# Private Codex drift judgments
> **Historical checkpoint:** This document describes the private 0.60.317.0 source lineage, not validation or activation of the upstream synchronization. Private migrations v261–v290 are being ported as v315–v344; integration remains in progress.

This checkpoint changes source only. Private configuration and the production
runtime qualification gate still apply; no installed service is activated.

## Behavior

`runPhaseDrift` uses `codexDriftJudge` in strict private mode, including when a
caller supplies the legacy injectable judge. Each call sends a native schema
with the host's take identity, a bounded confidence/weight, short reasoning and
an exact quotation from the supplied timeline evidence. Local schema and semantic
validation happen before accepted-turn accounting. There is no content repair
or provider fallback. The gateway retains measured tokens and unknown USD cost.

Private candidate reads are scoped to the selected source and live pages. The
cycle dispatcher passes its resolved source. At most 200 candidates are selected;
the phase cap further bounds calls. Evidence uses at most 12 timeline entries,
with each summary bounded to 1,800 characters and its source label to 128.
Claims over 8,000 characters and evidence over 24,000 characters refuse rather
than silently dropping input. Each call has the existing bounded runtime timeout
and the shared subscription envelope. A USD budget alone cannot authorize it.

Malformed output, invented quotations, wrong identities, invalid ranges and
refusals cannot become stable judgments. All failed judgments produce a failed
phase with no new report. Mixed results, cap exhaustion and held publication
are partial; a report names its failed judgments explicitly. Missing terminal
completion retains unresolved subscription ownership and blocks another call.
The disabled, empty-candidate and dry-run paths need no model.

The phase remains report-only: it does not adjust take weights. Private reports
stay in the selected source, have private visibility and the `codex-drift-v1`
protocol marker, and cite the take/page revision and exact evidence quotation.
They describe the evidence snapshot supplied to the judge, not a claim that the
underlying page stayed unchanged during inference. Source archival or incarnation
mismatch refuses publication. Unmanaged publication checks the host claim and
locks source identity in its write transaction. Managed publication uses existing
prepared maintenance requests, revision checks and admission fencing. Full
managed-consumer crash/fencing acceptance remains separate work.

Legacy non-private routing, injectable judges and report behavior are preserved.
The deprecated `dream.drift.model` pin is also in the reviewed pin migration list.

## Deterministic evidence

`test/helpers/codex-drift-contract.ts` drives the production phase and gateway
with a hash-qualified synthetic executable. It captures argv, stdin and the
native schema, forbids network fetches and uses isolated homes without credentials.
It checks source isolation, unchanged takes, private publication, bad proposals,
mixed results, exhaustion, conflicting current/deprecated pins, source archival,
publication claim checks, dry runs, evidence bounds and unresolved lifecycle.

- `bun test --timeout=60000 test/ai/codex-drift.serial.test.ts`: 20 passed.
- `bun test --timeout=240000 test/e2e/codex-drift.test.ts`: 20 passed on a fresh
  authorized PostgreSQL 16 cluster with pgvector; cluster stopped afterwards.
- Focused drift, auto-think, budget, attribution and gateway fallback tests:
  85 passed across five files.

- `bun test --timeout=60000 test/dream-publication-hold.serial.test.ts`:
  13 passed in its own process. Its mocks now preserve unrelated module exports.
- `bun test --timeout=60000 test/ai/codex-pins.serial.test.ts`: 10 passed.
- `bash scripts/check-test-discriminates.sh test/ai/codex-drift.serial.test.ts src/core/cycle/drift.ts`:
  prior production source at `2daacac` gives 3 passed / 17 failed. The harness
  restores the working source afterwards.
- `GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify`: 75 passed, 0 failed, 1 explicit
  skip. Includes typecheck, architecture, registries, generated artifacts and
  size checks. The admin build was attempted separately by ordinary `verify`
  but dependency downloads failed DNS resolution; its skip is not a pass.
- `bun run build` and `git diff --check` pass. Cycle phase translation is
  extracted into `runCycleDrift`; both cycle size baselines are lowered.

Serial suites must run in separate processes. An initial combined run leaked
publication mocks into the private suite; that run is not passing evidence.
Initial fixture mistakes (timeline source field, forbidden direct incarnation
rewrite) were corrected to exercise the actual storage contract.

These tests establish checkout behavior with synthetic inference. They do not
qualify the real Codex executable, prove live subscription behavior or upgrade
the installed GBrain.
