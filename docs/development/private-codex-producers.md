# Private Codex command and schedule allowances

These interfaces are implemented in the development checkout. They do not activate
the installed brain, qualify a runtime, or complete feature publication/recovery.
The production runtime qualification registry is still empty.

## Explicit queued command

`gbrain jobs submit` accepts three required flags for private generative jobs:

- `--codex-max-attempts N`: total provider attempts across worker retries, 1–1000.
- `--codex-max-turns N`: accepted turns, 1–max-attempts.
- `--codex-deadline UTC_ISO`: absolute UTC deadline, in the next 24 hours.

The existing strict private file configuration must already be present. These
flags cannot activate it. Job JSON, `--yes`, and `--max-usd` do not grant subscription
permission. The grant commits with the job; idempotent resubmission must reuse the
same payload and allowance, including the original deadline. Dry-run validates the
flags and route, prints null monetary cost/quota, and inserts no job or allowance.

Auxiliary API calls require a separate, explicit positive `--max-usd` cap. Without
it, a subscription-only job cannot call paid embeddings/reranking. In this private
submission path `--max-usd off` is rejected. Existing non-private consent remains
unchanged. PGLite still requires `--follow` or deliberate `--queue-only`.

This enables the submission/admission path for supported job names, not acceptance
of every handler. Private native-loop subagents still refuse. Synthesis/pattern
publication and the host action loop remain unfinished.

## Explicit recurring allowances

The trusted file plane optionally accepts `private_codex.scheduled_jobs`, with
entries for `autopilot-cycle` (legacy full cycle),
`autopilot-global-maintenance`, and `nightly-quality-probe`. Each entry has
this shape:

```json
{
  "maxAttempts": 10,
  "maxTurns": 8,
  "windowMs": 3600000,
  "auxiliaryMaxUsd": 0.25
}
```

This is recurring authorization: limits apply to each scheduled occurrence.
There are no automatic defaults. Attempts/turns have the same bounds as the CLI;
`windowMs` is a positive integer at most 24 hours. The optional positive
`auxiliaryMaxUsd` separately authorizes API work for that job. Configuring these
fields is a later activation decision, not a development or audit side effect.

The scheduler uses `slot start + windowMs` as the absolute deadline. Polling or
restarting within the same slot reuses it. An expired slot refuses; a newer slot
coalescing onto an active earlier job cannot extend that job's allowance and
currently reports `subscription_identity_conflict`. This is an explicit deferral
limitation; no new allowance is created. Existing scheduler cadence/single-flight
checks and the durable one-call account lane still apply. Other automatic producers
are not yet wired to recurring subscription grants.

`nightly-quality-probe` uses one UTC-day occurrence with an immutable deadline,
attempt and turn counters, owner brain, fixture hash, route/search snapshot and
policy identity. It opens the grant only after the probe's due-time, embedding and
fixture gates. It requires `auxiliaryMaxUsd` because retrieval may make paid API
calls. In private mode the reader, extractor and three judge slots resolve to the
configured Codex model; judge proposals run sequentially and are validated before
acceptance. A one-model judge panel is recorded as `panel_collapsed` and
`inconclusive`, even when the batch's own score is a pass. This is diagnostic
coverage, not an independent cross-model quality verdict. The real daemon step
has a ten-question end-to-end fixture on PGLite and PostgreSQL: it imports the
embedded LongMemEval data, uses a metered embedding transport, runs native
reader/extractor proposals, scores the batch, and records the collapsed panel.
That fixture uses a synthetic Codex executable and embedding transport; live
provider/runtime qualification remains separate before private activation.

Source-freshness-only `autopilot-cycle` jobs, deterministic `extract_facts` parsing
and the result aggregator do not need subscription grants or model configuration.
Missing, empty, unknown or mixed cycle phase lists remain conservatively generative.
Optional inference inside otherwise deterministic paths still meets the gateway's
strict routing and admission guards. Claude transcript connectors remain unchanged.

## Cycle accounting and diagnostics

The cycle `BudgetMeter` treats Codex separately from USD. Price overrides and
`allow_unpriced` cannot authorize it or give it a fictitious API price. With an
explicit host allowance it permits the plan to reach the gateway, which still
atomically enforces attempts, turns, deadline, ownership and concurrency before
inference. API estimates retain their independent USD cap. Mixed totals are null;
human reports say `unknown (subscription)`. Subscription ledger entries use schema
version 2 and include the separately metered API total.

`private-codex audit --json` reports configured schedule allowances without opening
a database or calling a provider. Its overall status remains incomplete. See the
[capability matrix and upgrade gates](private-codex-status.md).

## Deterministic verification

All runs use empty temporary credential/config homes, discovery disabled and fake
Codex executables. The shared job contract passed 22 cases on both PGLite and
native PostgreSQL 16.15 with pgvector 0.8.7. The PostgreSQL target was a fresh
isolated cluster and was stopped afterward. Production paths exercised include
CLI dry-run/submission, scheduler submission, queue binding, worker ownership,
gateway admission and cycle accounting. No installed services were changed.

```sh
bun test --timeout=60000 test/ai/codex-jobs.serial.test.ts test/autopilot-global-maintenance.test.ts test/autopilot-fanout.test.ts test/jobs-submit-numeric-flags.test.ts test/ai/private-policy.serial.test.ts
bun test --timeout=60000 test/ai/codex-jobs.serial.test.ts test/budget-meter.test.ts test/minions-spend-enforcement-child.test.ts test/jobs-submit-identity-stamp.test.ts test/autopilot-fanout-wiring.test.ts
GBRAIN_TEST_ALLOW_DATABASE_URL=1 GBRAIN_CI_DISABLE_TEST_ENV_FILE=1 bun test --timeout=240000 test/e2e/codex-subscription-jobs.test.ts
```

The first focused run passed 108 tests; the final focused run passed 63. Their
coverage overlaps and the totals must not be added. Native PostgreSQL passed 22.
These checks prove this source checkout, not live subscription behavior.

`bun run verify` passed 75 checks, with zero failures and one explicit skip:
`check:admin-build` was disabled because its script installs dependencies outside
the authorized locked setup. Typecheck, architecture/size guards, registries,
generated files and documentation checks passed. `bun run build` compiled the
CLI successfully; both Git diff whitespace checks passed. No ceilings were raised.
