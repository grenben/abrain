# Private Codex contextual summaries

## Source behavior

Native synopsis proposals and exact-quote validation existed before this
checkpoint. The new v2 schema also binds the response to a host-generated hash
of the prompt and chunk. Bounds cover chunk bytes, complete prompt bytes and
output tokens; failures stay typed errors rather than title-only fallbacks.
The synopsis protocol version participates in corpus generation, so older
synopsis-derived embeddings do not share the new identity.

`contextual-retrieval-private.ts` closes the direct service route: absent pins
select configured Codex; explicit arguments, shadowed legacy arguments,
DB/tier/environment pins are checked. Injected synopsis functions are refused
in strict private mode. Pure `none` mode retains its deterministic behavior.

Mixed preparation requires the existing host subscription context and a
separate invocation spending guard. Native attempts retain their subscription
ledger; paid embedding calls use the existing durable reservation/settlement
paths. Unknown embedding usage leaves a pending hold. A missing or exhausted
auxiliary allowance cannot publish vectors. Preparation is bounded to 256
chunks and private synopsis calls run sequentially before batched embedding.

Publication keeps the existing revision/projection/context compare-and-swap
and atomic vector/mode/generation transaction. It now checks the current worker
claim inside that transaction, locks and rechecks the source incarnation and
archive state, and rejects cancellation before publication. A replacement
worker cannot publish the prior claim's prepared vectors.

## Queue identities and migration

Private `contextual_reindex_per_chunk` jobs require `expected_source_id`.
Their subscription run identity is **v2**, binding that source's incarnation;
other job identities remain v1. Queue preflight and direct handler entry check
the same model/source requirements. Old contextual grants are refused rather
than reinterpreted. Use the existing explicit drain/park/resubmit workflow;
resubmission must include the source and fresh bounded subscription consent.
Nothing in an ordinary read rewrites stored jobs.

Registered migration **v285**, `precise_auxiliary_spend`, widens the reservation
estimate, actual charge and spend-log fields from NUMERIC(12,4) to
NUMERIC(20,12) cents on both engines. A 17-token embedding fixture costs
0.000034 cents and previously rounded to zero per call. The new storage retains
that charge and its rollup. Existing values survive widening and repeated
application; already-lost historical precision cannot be recovered. No installed
or production database is migrated during development.

## Verification

Credential-free fake Codex, captured native schema files/argv/stdin, forbidden
network tripwire, fake embedding transport and fresh isolated storage exercise
actual service, queue, handler, subscription ledger, spending ledger and
projection publication paths. Tests include invalid output/refusal, valid
quotes, independent cap refusal, retained unknown-usage holds, multiple chunks,
attempt exhaustion, source/pin conflicts, replacement workers, cancellation,
revision drift, old job identity refusal and migration precision replay.

```bash
bun test --timeout=30000 test/ai/codex-think.serial.test.ts
bun test --timeout=240000 test/e2e/codex-think.test.ts
bun test --timeout=60000 test/ai/codex-jobs.serial.test.ts
bun test --timeout=30000 test/ai/codex-facts.serial.test.ts
bun test --timeout=60000 test/contextual-retrieval-service-pure.test.ts test/synopsis-chat-failure-class.test.ts
bun test --timeout=60000 test/embedding-completion-atomic.serial.test.ts
bun test --timeout=60000 test/contextual-synopsis-model.serial.test.ts
bun test --timeout=60000 test/contextual-reindex-lease-release.test.ts
bun test --timeout=60000 test/eval-longmemeval-synopsis-tier.serial.test.ts
bun test --timeout=240000 test/schema-catalog-golden.test.ts test/schema-migrations-replay.test.ts test/schema-bootstrap-coverage.test.ts
bun test --timeout=240000 test/e2e/schema-catalog-golden.test.ts test/e2e/schema-migrations-replay.test.ts
GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify
bun run build
git diff --check
```

Native PostgreSQL checks use a disposable loopback cluster stopped afterward.
Catalog checks do not expose numeric scale, so separate real-ledger assertions
check all three columns' 12 decimal places, preservation of old charges, and
small new values in both the reservation and log. PgBouncer is unavailable.

## Remaining caller integration

The current production service callers are the contextual Minion handler and
LongMemEval's synopsis tier. Import and ordinary reindex paths share pure helpers;
the old service header overstated their direct use. The LongMemEval wrapper
still supplies a custom generator with legacy USD-only metering and parsed-text
caching. That private evaluation path needs native subscription admission,
validated cache integration and honest null pricing; the strict service rejects
its unsafe injection until that work is implemented. Non-private evaluation
behavior is preserved. Full feature acceptance is therefore still partial.

## Results

The combined fake-Codex contract passes 123 tests / 452 assertions on each
engine, including 26 contextual cases. Existing job contracts pass 23 tests /
96 assertions; facts/atoms/synopsis pass 15 / 89; contextual pure/failure tests
pass 48 / 83; projection publication regressions pass 12 / 133. Separately run
caller regressions pass 10 / 35 (models), 7 / 15 (leases), and 2 / 25 (non-private evaluation). Schema checks:
PGLite 29 / 163; PostgreSQL 12 / 31 with one PgBouncer skip. Repository checks:
75 pass, 0 fail, 1 admin-build skip. Build bundles 3,655 modules; diff checks pass.

Restoring the prior service, subscription-job binding and synopsis adapter
produces 108 passing and 15 failing tests; the developed sources are restored
after the check. Logs use `/tmp/maxbrain-contextual-` with suffixes
`full-final.log`, `postgres-final.log`, `jobs.log`, `facts.log`, `legacy.log`,
`publication-regression.log`, `schema.log`, `pg-schema.log`, `verify.log`,
`build.log` and `discrimination.log`.

## Upgrade boundary

This checkpoint is implemented in source and tested without real inference.
Installed GBrain retains its original capabilities. Deployment still requires
the reviewed branch/artifact, registered migrations through v285, worker
consistency and job dispositions, and explicit activation authorization.
The production Codex executable qualification registry remains empty; native
pre-execution isolation and bounded live subscription checks remain unverified.
Embeddings remain a separate provider with separate spending authorization.
