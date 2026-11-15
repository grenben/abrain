# Private Codex conversation-parser fallback
> **Historical checkpoint:** This document describes the private 0.60.317.0 source lineage, not validation or activation of the upstream synchronization. Private migrations v261–v290 are being ported as v315–v344; integration remains in progress.

This source checkpoint adds private native proposals to the optional parser
fallback. It does not install or activate private mode. The production Codex
runtime qualification registry is still empty; deterministic fake-executable
checks do not prove live subscription behavior.

## Behavior

- `llm-base.ts` routes strict private calls to `llm-codex.ts`. Conflicting model
  pins and injected transports fail before cache access or provider dispatch.
  A private caller must supply a native schema and cache version. Non-private
  behavior retains its existing transport, parsing and cache semantics.
- `llm-codex-fallback.ts` generates an object schema with the host's evidence
  hash and at most 200 messages. Schema and semantic checks run before an
  accepted subscription turn: all timestamps must be valid; dates must occur
  as ISO dates in the chunk or match host metadata; clock times must occur in
  the chunk; speakers and verbatim contiguous message text must be present.
  Failed rows are not dropped. These checks do not establish perfect attribution.
- Whole-input bounds are checked before inference: 256 KiB body, 16 windows,
  64 KiB per window, 1–1,000 configured lines per window (100 by default).
  Each response is capped at 512 KiB, and the adapter's lifecycle/process
  bounds also apply. Unknown date spellings cannot override the host date.
- Raw application JSON is cached in the existing brain-local
  `conversation_parser_llm_cache` table with a private protocol envelope.
  Identity includes version, model, system, schema, date-bearing content and
  token bound. Every hit is revalidated; legacy caches and the global Map
  cannot satisfy private reads. Cache errors propagate without hidden inference.
- An explicit valid empty array is a successful parse. Malformed JSON, refusal,
  missing completion, invalid evidence, cancellation and exhausted admission
  are failures. Earlier successful chunks can be reused after a later failure;
  a partial page is never returned as complete.
- The existing extraction dispatcher retains its exact privacy opt-in and
  deterministic-first gate. Native parser failure leaves the page unfinished,
  without terminal facts or a new page checkpoint. Native parser success still
  requires successful fact extraction before completion. Cached parsing never
  manufactures a terminal extraction receipt.

There is no separate polish caller. The `polish` call shape is scaffolding;
strict calls without a schema are refused. This does not add a model dependency
to deterministic parsing. No cache migration is required beyond the existing
v099 table. Other registered migrations remain part of any later upgrade.

## Deterministic verification

Credential-free fresh homes, disabled discovery, a registered fake executable,
real gateway/adapter/subscription ledger, fetch tripwire and isolated databases:

```bash
bun test --timeout=30000 test/ai/codex-think.serial.test.ts
bun test --timeout=240000 test/e2e/codex-think.test.ts
bun test --timeout=60000 test/conversation-parser/llm-base.test.ts test/conversation-parser/llm-fallback.test.ts
bun test --timeout=60000 test/extract-conversation-facts.test.ts
GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify
bun run build
git diff --check
```

The combined contract includes 32 parser cases and 65 existing think,
calibration and automation cases. It captures argv, stdin, environment keys,
owner-only schema permissions and actual schema bodies. It covers partial
chunk retry, quota exhaustion, cache corruption/versioning, unsupported schemas,
active cancellation, source-grounding rejection, real extraction completion and
real extraction failure. PostgreSQL uses a disposable loopback cluster that is
stopped after the suite. Its fixture explicitly configures the same 1536
embedding dimensions as the fresh schema; the production dimension guard is
not bypassed. Embeddings are disabled and no provider credentials are used.

Results: 97 tests / 353 assertions pass on each engine; 37 parser compatibility
checks / 69 assertions and 99 extraction checks / 507 assertions pass. The
no-call route audit passes (1 test / 8 assertions). Repository verification:
75 pass, 0 fail, 1 admin-build skip; typecheck passes. Build bundles 3,653 modules.
`git diff --check` passes. Restoring the two parser entry files to the previous
implementation yields 65 passing and 32 failing tests, proving the new contracts
distinguish that implementation. Source files are restored afterward.

Local evidence logs: `/tmp/maxbrain-parser-full.log`,
`/tmp/maxbrain-parser-postgres.log`, `/tmp/maxbrain-parser-legacy.log`,
`/tmp/maxbrain-parser-extraction-regression.log`, `/tmp/maxbrain-parser-routes.log`,
`/tmp/maxbrain-parser-verify.log`, `/tmp/maxbrain-parser-build.log`, and
`/tmp/maxbrain-parser-discrimination.log`.
Admin UI dependency fetching, full CI, production migrations, installation,
live inference and activation are outside this checkpoint's checks.
