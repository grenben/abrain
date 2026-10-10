# Private Codex bounded-role follow-up

This is source development, not an installed upgrade or activation. All features
remain behind trusted private configuration and the empty production runtime
qualification registry. Tests register only synthetic executable hashes.

## Implemented paths

- **Drift:** native, source-scoped advisory judgments require host take identity
  and exact evidence quotations. Invalid output cannot become a stable finding;
  private reports preserve source identity and failed-judgment counts. See the
  [drift checkpoint](private-codex-drift.md) for limits and storage evidence.

- **Facts:** the actual extractor sends a bounded native schema, verifies exact
  source quotations, confidence, dates, metric pairs and duplicate claims before
  accepted-turn accounting. Host source/session provenance is retained. Valid
  empty results remain success; the compatibility wrapper propagates private
  failures. Classifiers constrain candidate identities and decision consistency;
  failures never fall back to a duplicate/insert decision. The classifier helper
  has no identified production caller, so its tests do not establish dispatcher
  coverage. Conversation-fact batch admission/publication remains separate work.
- **Atoms:** the special resolver rejects conflicting pins; explicit subscription
  context is required independently of USD limits. Native bounds and whole-batch
  quote/title/concept validation precede acceptance. Private provider/schema/
  admission failures never create content strikes or tombstones. Grounded atoms
  preserve quote provenance; valid empty output retains successful watermarks.
  The quote locator was extracted without changing legacy matching behavior.
- **Take grading:** native verdict/confidence/reasoning/evidence-quote validation
  precedes acceptance. Cache identity has a distinct private version and full
  provider/model ID. The budget check retains that provider identity. Take reads
  receive the existing source scope. Private ensembles execute sequentially;
  failed slots cannot produce a cached ensemble judgment. Existing prepared
  resolution writes remain; concurrent authority/revision recovery acceptance
  has not yet been completed for private grading.
- **Chunk synopses:** a native schema requires a bounded synopsis plus a quotation
  from the actual chunk. Invalid private proposals propagate as typed errors,
  preventing title-only fallback publication. Private chunk generation uses one
  worker and a distinct corpus-generation identity. Deterministic title wrapping
  and hashing remain model-free. Full enrichment/page-summary dispatcher coverage
  is not established by this chunk-synopsis implementation.

## Accounting and migration

Atom receipts and phase reports return `null` total USD and expose the known API
subtotal separately. Unknown embedding prices still refuse mixed-workflow
admission; the subscription envelope cannot authorize paid embeddings.

Registered migration **v225**, shared by both engines, adds
`extract_rollup_7d.subscription_run_count`. The existing `cost_usd` column retains
known API spend. Dashboard, explain and doctor readers expose an unknown total
when a subscription run is present, plus `api_metered_cost_7d_usd`. Legacy rows
retain their prior meaning. Reads work before v225 using optional JSON row-field
lookup; subscription writes never silently retry an older schema without the
counter. Rollups remain best-effort operational caches, not an authoritative
per-attempt ledger. Durable subscription admission remains in v223/v224.

No migration was applied to the installed database. PostgreSQL catalog goldens
were regenerated only from fresh isolated test databases; the diff adds one
column and its nonnegative check constraint. Native/PGLite column parity passes.

## Verification and limits

`test/helpers/codex-facts-contract.ts` drives real feature functions, gateway,
fake executable and database. It captures native schemas/prompts and checks
accepted-turn counts, valid empty output, provenance, failure/tombstone behavior,
cache reuse, pin denial, sequential ensembles and honest aggregate accounting.
Both engine wrappers use synthetic data and deny network inference. The native
wrapper creates/drops its own UUID-named database on the authorized isolated
PostgreSQL cluster; that cluster is stopped afterward.

Focused commands (fresh HOME/GBRAIN_HOME/CODEX_HOME, discovery disabled):

```sh
bun test --timeout=60000 test/ai/codex-facts.serial.test.ts
bun test --timeout=60000 test/grade-takes.test.ts test/grade-takes-ensemble.test.ts
bun test --timeout=60000 test/ai/codex-images.test.ts test/ai/codex-gateway.serial.test.ts test/page-summary-length.serial.test.ts test/contextual-retrieval-service-pure.test.ts
bun test --timeout=60000 test/extract-explain.test.ts test/doctor-extract-health.test.ts test/extract-rollup-expected-limit.test.ts test/schema-bootstrap-coverage.test.ts test/schema-catalog-golden.test.ts
bun test --timeout=240000 test/e2e/codex-facts-atoms.test.ts test/e2e/schema-catalog-golden.test.ts
```

Full synthesis/pattern proposal retention and partial-commit recovery, the private
host action loop, remaining generative roles, operator account reconciliation and
pin/job migration tooling remain incomplete. Runtime native-action/instruction
isolation remains unqualified. Static tests do not prove live subscription behavior.

Final checkpoint evidence: the post-refactor feature/grading/atom/catalog command
passed **81 tests**, including all **15** shared private-role cases. The final
native PostgreSQL role/catalog run passed **23 tests**, with only the optional
PgBouncer check skipped. The earlier image/gateway/synopsis run passed 98 tests;
counts overlap. Migration catalog regeneration initially produced the expected
PGLite fixture drift; the reviewed final run uses regeneration disabled.

Repository verification passed 74 checks initially, failed the function-size guard,
and explicitly skipped the admin build (which installs additional unlocked
packages). Empty-atom completion and grade identity resolution were then extracted
into helpers; the function-size rerun passed without raising any limits. The
compiled CLI and PNG/JPEG/WebP decoder smoke guard passed. Final typecheck and
whitespace checks passed. These checks prove this checkout only.
