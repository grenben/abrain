# Private Codex proposal caching

**Say to your agent:** *“Show which private evaluation paths have durable
admission and validated caching, and which still need implementation.”*

## Source behavior

`withCodexProposalCache` establishes a host-owned scope with a namespace and
an authority binding hash. Callers must bind that hash to the authorized
corpus/source incarnation and protocol; model output cannot choose it. Native
synopsis generation uses `cachedCodexProposal`; without a cache scope it still
makes the normal admitted call. No CLI or installed configuration enables this
cache automatically.

The cache resides in the **subscription context's database**, not an arbitrary
benchmark database. Registered migration **v271** adds its bounded raw response
storage with row-level security on both PGLite and PostgreSQL. Each entry retains
the originating subscription run. Namespace, authority binding, model, complete
prompt, schema, semantic protocol version and generation parameters determine
the request identity. Ordinary reads do not import legacy parsed-text caches.

Every hit checks current routing, cancellation, host authority, the transaction
fence and a real unexpired grant. It then checks the retained response digest,
the complete original schema and the caller's semantic validator. Corruption or
an invalid source quote fails explicitly, with no regeneration or fallback.
Reusing a successful result needs no fresh inference attempt; exhausting an
attempt allowance does not prevent authorized reuse before its deadline.

Only a native call that completed, validated and was accepted by the existing
subscription ledger can create an entry. Publication rechecks the host fence.
Competing writers retain the first accepted entry instead of overwriting it.
Failure after an accepted call leaves its measured charge in the ledger; it
does not refund the call. Refusals, missing completion, malformed output and
semantic failures never become cached answers.

Cache hits omit provider usage, avoiding counting the original tokens again.
The proposal result reports subscription cost and remaining quota as `null`.
This is application response reuse, separate from provider prompt-cache tokens.

## Verification

The shared fake-executable contract exercises the real native synopsis,
gateway, subscription ledger and cache on both storage engines. It checks raw
schema transport, successful replay with unchanged admission counters,
cross-run provenance, changed evidence/bindings/protocols, corrupt stored output,
schema and quote revalidation, routing, missing/expired/stale authority,
cancellation, post-call fencing, storage bounds and migration replay.

```bash
bun test --timeout=30000 test/ai/codex-think.serial.test.ts
bun test --timeout=240000 test/e2e/codex-think.test.ts
bun test --timeout=240000 test/schema-catalog-golden.test.ts test/schema-migrations-replay.test.ts test/schema-bootstrap-coverage.test.ts
bun test --timeout=240000 test/e2e/schema-catalog-golden.test.ts test/e2e/schema-migrations-replay.test.ts
GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify
bun run build
git diff --check
```

Tests use fresh synthetic state, fake Codex, discovery disabled and a network
tripwire. Native PostgreSQL uses a disposable loopback cluster stopped after
the tests. No real subscription inference or production migration is involved.

The final shared contract passes **139 tests / 504 assertions on each engine**,
including 16 cache cases. Existing facts/atoms/synopsis contracts pass 15 / 89.
PGLite schema checks pass 29 / 163; PostgreSQL schema checks pass 12 / 31 with
one unavailable PgBouncer check skipped. Repository verification passes 75
checks with the external admin build skipped; typecheck and the 3,658-module
compiled build pass. Diff checks are clean. The first contract run exposed an
unwanted transaction fence without a cache scope; that regression was repaired
before the final runs.

Restoring only the previous synopsis integration makes the same cache suite
fail seven cases (nine pass); the developed file is restored afterward. Evidence
logs are `/tmp/maxbrain-cache-{contract-final,postgres-final,schema-final,pg-schema,
facts,verify-final,build,discrimination}.log`. This evidence covers the changed
checkout; it is not a full CI or live subscription result.

## Remaining evaluation integration

This implements the cache foundation and native synopsis seam. LongMemEval
still needs a durable run owner outside its reset/recycle database, explicit
subscription admission, separately metered paid retrieval, reader/extractor/
judge native schemas, safe scope construction, cache metrics and honest null
pricing in aggregate reports. Its existing custom synopsis generator remains
refused under strict mode. These tests do not establish full private benchmark
support or authorize an additional database/account lane.

Installed GBrain retains its original capabilities. An eventual upgrade must
include the reviewed artifact and registered migrations through v271, followed
by authorized runtime qualification and activation gates. Production native
isolation, live subscription behavior and full feature coverage remain open.
