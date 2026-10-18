# Native Codex evaluation roles

**Say to your agent:** *“Show which benchmark roles have native Codex schemas,
and which parts of the full subscription benchmark still need integration.”*

## Implemented source paths

LongMemEval's actual `generateAnswer`, `extractAndInsertClaims`, `runJudge` and
`judgeRow` dispatch to bounded native proposals under strict private mode.
Injected inference clients are refused. Other modes retain the legacy clients.
The host gateway factory is recognized by identity and frozen against mutation.

The reader binds the complete prompt and sanitized delivered sessions into its
schema. An answered response needs distinct citations with exact quotations
from those sessions. Text in the question cannot ground a citation. A valid
abstention has a fixed statement and no citations; malformed empty output is
an error. Receipts preserve citations, protocol, cache status and measured usage.
Quotation checks establish provenance, not the truth of a paraphrased answer.

The extractor validates all rows before any insertion: at most 32 claims, bounded
verbatim text, mentioned entities, real dates anchored in the excerpt or supplied
session date, and a numeric metric or an event. Invalid rows, duplicate proposals,
authority fields and malformed output reject the whole batch. Valid empty output
is explicit. The old parsed-text cache is bypassed; scoped native reuse retains
the raw proposal and revalidates it through the v274 cache.

Private entity resolution uses the existing strict resolver with storage errors
propagated. It refuses ambiguous identities and cannot turn a failed lookup into
a guessed slug. The full batch is inserted atomically under source-incarnation,
archive, worker and cancellation checks. Empty extraction also needs a current
fence. Foreign admission/target brains remain refused until the benchmark's
explicit temporary-brain ownership scope is implemented.

The judge returns exactly one schema-constrained yes/no value bound to its
rubric/input hash. The existing verdict parser validates it before acceptance.
It does not retry an ambiguous native attempt automatically. Refusal, malformed
output and missing completion remain error outcomes; admission and cancellation
remain explicit failures. The durable ledger retains attempt truth. When the
wrapper cannot establish failure usage or attempt count, its receipt uses null.
Native execution uses the adapter's byte/time bounds and schema limits. Gateway
budget metadata requests at least 256 tokens for the envelope and evidence hash;
this is not evidence of a provider-enforced token cap.

Native reader/judge protocol versions enter resume hashes. Role defaults and
explicit reader/judge/extractor pins resolve through the strict policy; supplied
host context exposes the applicable DB pins too, including at direct SDK entry.
The no-call inventory includes
these roles, and pin migration includes `models.eval.longmemeval_judge`.

## Admission and honest reporting

A USD-only judge cap refuses unpriced calls. An enclosing host subscription
scope separately authorizes native dispatch, which verifies the real durable
grant and shared lane. Its existence does not authorize paid embeddings or
reranking. The pure judge preflight receives this host state explicitly.

Judge aggregate cost is null if any attempted row has unknown cost. The known
priced subtotal and unknown-row count are retained. Ledger reports follow the
same rule; terminal output says unknown instead of printing a fabricated $0.
Cache hits have no new measured provider usage. A partly answered private run
fails when later questions fail, including exhaustion without judging enabled.

## Verification and limits

The shared fake-Codex contract runs on PGLite and PostgreSQL. It exercises native
transport, citations, abstention, malformed output, refusal, completion, injected
clients, pins, cache identity, full-batch validation, source provenance, entity
lookup failures, publication fencing and honest aggregate accounting.

Two tests run the real keyword benchmark over two questions and separate
temporary database resets. The enclosing admission database retains all four
reader/judge attempts, and unknown cost stays null. With only one allowed reader
attempt, the first answer survives, the second row reports exhaustion, and the
run fails. These tests use the supported optional `--no-trajectory` arm; they
do not establish full preprocessing or mixed retrieval support.

```bash
bun test --timeout=30000 test/ai/codex-think.serial.test.ts
bun test --timeout=240000 test/e2e/codex-think.test.ts
bun test --timeout=60000 test/longmemeval-reader.test.ts test/longmemeval-extract.test.ts test/longmemeval-judge.test.ts
bun test --timeout=60000 test/entity-resolve.test.ts test/entity-resolve-slug-fallback.test.ts test/entity-resolve-exact-name-floor.test.ts test/entity-resolve-prefix-dirs.test.ts
bun test --timeout=60000 test/eval-longmemeval-gateway-routing.test.ts
bun test --timeout=60000 test/eval-longmemeval-reader-mode.slow.test.ts
bun test --timeout=60000 test/eval-longmemeval-judge.slow.test.ts
bun test --timeout=60000 test/eval-longmemeval-brain-recycle.test.ts
bun test test/ai/private-route-audit.test.ts
GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify
bun run build
git diff --check
```

The shared contract passes **176 tests / 616 assertions on each engine**,
including 37 native evaluation cases. Legacy reader/extractor/judge tests pass
69 / 438; entity resolution passes 60 / 97. Separately run benchmark regressions
pass 4 / 25 (gateway), 4 / 36 (reader modes), 12 / 263 (judge), and 1 / 5
(brain recycling). Audit/pin/policy checks pass 24 / 97. Repository verification
passes 75 checks with the external admin build skipped; typecheck and the
3,663-module compiled build pass. No size ceilings were raised. Full CI and
PgBouncer checks were not run in this checkpoint.

Two intermediate typecheck errors (union narrowing and a test literal type)
were corrected before the final successful verification. Restoring the prior
reader, extractor and shared judge dispatchers makes 28 of the 37 new cases
fail; the developed sources are restored afterward. Logs use
`/tmp/maxbrain-eval-` with `contract-complete.log`, `postgres-complete.log`, `legacy.log`,
`entity.log`, `caller-0.log` through `caller-3.log`, `routing-0.log` through
`routing-2.log`, `verify-head.log`, `build.log`, and `discrimination.log`.
Both disposable PostgreSQL lifecycle and provider tripwire checks completed;
the test cluster was stopped.

The full benchmark still needs explicit CLI grant creation in its durable host
database, fact-key integration, complete paid retrieval admission, and
retained run/result recovery. Existing admission/foreign-brain safeguards stay
enforced while that work proceeds. Full A–G acceptance remains incomplete.

No installed executable, configuration, credentials, database or service changed.
Production runtime qualification remains unverified; no live inference occurred.
An eventual authorized upgrade must include the reviewed source/build and
registered migrations through v274, plus the remaining activation gates.

## Disposable benchmark ownership follow-up

The harness now creates its in-memory targets through a closed factory. An
existing engine cannot be registered as disposable, and a factory object cannot
reconnect to a persistent database. The command checks ownership before writing
configuration, including for injected or recycled engines. Reset preserves the
brain identity and refuses any database holding subscription grants, so it cannot
erase attempts, unresolved account-lane holds or proposal history. Reset,
disconnect and concurrent question scopes cannot overlap.

Private extraction binds the exact temporary engine and its brain identity to a
live host context. Before effects, the host transaction locks the grant and runs
the host's authority hook. A separate scratch transaction checks source identity
and inserts the entire batch. The host hook receives only the host transaction.
Cancellation rolls back scratch effects before their commit. These two databases
do **not** form an atomic transaction: if scratch commits but host acknowledgement
fails, the question becomes invalid and cannot perform further inference. Its
derived state must be rebuilt through the next reset; no durable benchmark result
receipt is claimed here.

A native proposal retained in the host v274 cache can be revalidated and inserted
into a rebuilt corpus without a second inference charge. The real keyword CLI
fixture now runs extraction, reader and judge for two questions, preserving six
attempts/accepted turns in the external host database. Injected expansion,
embedding and readiness transports are refused under private mode. The native synopsis follow-up below adds its arm and tests independently paid hybrid retrieval. Fact keys and the complete CLI allowance lifecycle still need integration.

## Native synopsis and mixed retrieval follow-up

The private `--mode tokenmax` path now invokes the real contextual-retrieval
service with native Codex synopses and a distinct paid embedding allowance.
Pages and chunks run sequentially. An explicit concurrency above one, legacy
`--synopsis-cache`, `--synopsis-max-usd` or injected generator is refused. The
unset legacy dollar default cannot authorize subscription inference. Non-private
runs retain their prior cache, concurrency and dollar cap behavior.

Raw proposals live in the host's v274 cache. The host request ID and native
synopsis protocol bind the namespace; each request also binds its full prompt,
source evidence, schema and model. Rebuilding a temporary corpus can reuse a
validated proposal without repeating its inference charge or copying its tokens
into current usage. Paid embeddings are still admitted and charged independently
on every rebuild. Unknown embedding usage retains its durable reservation.

The owner and target database model pins are both checked. Publication holds the
owner fence while validating and installing the temporary page projection. A
lost owner, changed source, superseded page or cancellation fails the question.
No title fallback or automatic transient retry occurs in the private benchmark.
A fenced empty page is reported as `pages_empty`; a missing page is a failure.
A nonempty page whose chunk projection is missing fails before a completion
stamp or model call, so indexing debt cannot masquerade as clean zero.
The service exposes immutable accounting metadata to the host meter, never
mutable proposal content.

Synopsis results have `billing: subscription`, `usd: null`, measured token
subtotals and a usage-completeness marker. Run-end diagnostics explicitly count
accepted responses and cache hits; the durable attempt ledger remains the
source for failed/ambiguous attempts. Neither remaining subscription quota nor
a dollar price is fabricated. Native synopsis protocol identity enters retrieval
hashes and the no-call route inventory.

The real tokenmax CLI fixture runs import, native summary generation, paid
re-embedding and hybrid vector search. It uses fake Codex and synthetic embedding
transport, with a network tripwire; embedding opt-in changes only the disposable
fixture configuration and is restored afterward. This does not qualify real
Codex isolation or activate the installed brain.

Full benchmark CLI grant creation, dataset/request binding and durable result recovery remain incomplete. An authorized future installation still needs migrations through v274 and runtime qualification.

## Native fact-key follow-up

The private `--fact-keys chunk|page` arm now supports both `paper` and
`production` extraction. Paper mode retains the published user-fact instruction
and requires bounded facts with exact source quotations. Production mode calls
GBrain's actual facts extractor, including its configured prompt, attribution,
date grounding and deterministic filters. Individual fact embeddings are
explicitly disabled because this arm embeds the keyed chunk inputs itself.
Private configuration read failures fail instead of selecting default behavior.

The arm reads the canonical page snapshot. A caller's unrelated `content` value
cannot supply evidence for another page's vectors. Duplicate pages, missing or
unsealed projections, oversized batches, injected clients, legacy cache paths,
conflicting owner/target model pins and USD-only native admission are refused.
`--keyword-only` conflicts with private fact keys, which necessarily embed data.
At most 256 pages/chunks are prepared per batch. The production extractor retains
its shipped 8,000-character source window; paper input is separately bounded.

All native proposals are validated before embedding, and every vector is ready
before publication. The host fence wraps one scratch transaction containing the
existing prepared projection installs. Source, incarnation, revision and chunk
identity checks apply even to valid empty extraction. A conflict on a later page
rolls back the earlier page's vector update. Paid calls remain accounted even
when publication fails. This atomicity applies to the scratch database; it is
not a distributed transaction with the host admission database.

Exact embedding-input hashes are written in that same transaction. They bind
the fact-key protocol, model, vector column and actual keyed text. Original
`chunk_text` stays unchanged. Generic projection rebuilds cannot mistake these
vectors for embeddings of plain or title-wrapped text. The target must be a
factory-owned temporary brain under an active host scope.

Both modes retain raw native responses in the host v274 cache. Every hit repeats
schema and semantic validation and reports no new native token charge. The
production extractor now uses that cache only when a host explicitly supplies a
scope; ordinary calls retain their normal admission. Private malformed or
truncated output cannot trigger legacy repair/salvage retries. Valid empty
output is separate from refusal, invalid JSON, failed configuration reads and
failed source lookup. Cache entries are never made from those failures.

Row receipts carry the native protocol, accepted-response/cache counters,
measured usage and `usd: null`. Paid chunk embeddings remain independently
metered, including on rebuild. Both role/model selections enter the no-call
inventory and the protocol enters retrieval hashes.

Full CLI grant creation, immutable dataset/request binding and durable result recovery still need implementation. No installed executable, service, credential or activation changed.
