# Private Codex think checkpoint

This is an implementation in the development checkout. Installed GBrain remains
unchanged; the production Codex runtime qualification registry is still empty.

## Implemented behavior

`runThink` keeps the existing retrieval, prompt assembly, trajectory, calibration,
quote checking and result formatting. In strict private mode it requires a
host-owned subscription envelope for the same brain before retrieval. Explicit
model pins still pass through the deep-tier resolver. Injected clients and stub
responses cannot bypass the private gateway or admission boundary.

The synthesis call transports the actual `codex-think-v1` JSON Schema through the
gateway to the ephemeral adapter's `--output-schema` file. The response includes
an evidence hash bound to the complete rendered prompt, an answer, structured
citations and gaps. Bounds are 16,000 question characters, 128 KiB of rendered
prompt/system text, 4,096 output tokens, 80 citations, 16 gaps and 120 seconds per
call, further limited by the durable subscription envelope. There is no content
repair or provider fallback in this path.

Each structured citation must match an inline marker, its order, and an actual
retrieved page or take row. Duplicate citations, invented rows, unlisted markers,
extra authority fields and ambiguous same-slug pages from different sources fail
semantic validation before acceptance. Private take fusion uses page ID and row,
so federation cannot silently combine same-slug takes. A citation demonstrates
retrieval provenance, not that every prose claim follows logically from it.

The existing quote verifier remains active. Private quote grounding excludes the
question itself: a fabricated quote copied from a question cannot become source
evidence. Calibration profile lookup now carries private think's source scope;
remote callers receive only explicitly published profiles. Local unpublished
profiles remain available to their authorized local caller.

Refusal, missing terminal completion, malformed output, invalid citations,
subscription exhaustion and cancellation propagate as explicit failures. They
cannot enter the legacy permissive parser, a fallback provider or a successful
result. Valid empty output returns `empty_answer` with `synthesisOk: false` and is
distinct from parsing failure. Required gather-stream and trajectory-query failures are redacted and
stop private synthesis. Existing non-private degradation behavior is retained.

Embedding and reranking remain separate providers. A bare subscription envelope
cannot authorize them: an enclosing auxiliary invocation guard is required and
its admission/settlement remains in force. A denied auxiliary call cannot be
silently swallowed to complete private synthesis. Measured Codex tokens are
retained; this change does not assign a USD price to subscription inference.

## Coverage and open work

| Area | Before | Current source evidence | Remaining acceptance |
|---|---|---|---|
| Think synthesis | Gateway, prompt-only JSON and permissive parsing | Native schema, bounded proposal, citation closure, explicit failures | Runtime qualification and live behavior |
| Calibration context | Latest profile without source scope in think | Scoped lookup; remote published-only filter | Broader permission/federation review |
| Retrieval identity | Take fusion keyed by slug/row | Private fusion keyed by page ID/row | Entire hybrid cache/inner error census |
| Direct CLI | No private subscription allowance surface | Host-context calls supported; missing allowance fails before retrieval | Explicit CLI grant wiring; save/take publication now covered by the follow-up checkpoint |
| Auto-think | Uses runThink with legacy admission/publication | Inherits validated private synthesis when host-admitted | Cycle budgets, canonical receipts, crash recovery and cooldown gates |
| Calibration A/B | Injected runner and direct result insert | Existing harness remains unchanged | Actual private runner, failed-trial handling, scoped durable receipts |
| System One decisions | Optional Typesafe/LLM proxy slots | Explicitly configured Codex slots can use closed typed schemas and host admission; TypeSafe, ordinary LLM and cross-provider fallback routes conflict before private dispatch | Slot calibration and feature-path receipts, real runtime qualification |

The existing `rounds` option is still single-pass scaffolding with an explicit
warning for values above one. This checkpoint does not claim an iterative think
retrieval loop. No answer cache or new database migration was added. The existing
save/take paths are not proven replay-safe by these synthesis tests.

## Deterministic verification

`test/helpers/codex-think-contract.ts` uses the real engine, retrieval, dispatcher,
gateway, adapter and subscription ledger, with a hash-qualified fake executable.
Each wrapper uses fresh HOME, GBRAIN_HOME and CODEX_HOME, discovery disabled, no
real credentials and a forbidden-network tripwire. Captured argv, prompt, schema,
0600 permissions and environment keys establish transport. PostgreSQL runs in a
disposable cluster stopped afterwards.

The mixed-workflow test exercises the production invocation guard using a
synthetic embedding callback and a bounded parent guard. It does not prove a real
embedding provider or external subscription account quota.

| Command | Result |
|---|---|
| `bun test --timeout=60000 test/ai/codex-think.serial.test.ts` | 24 passed, 67 assertions |
| `bun test --timeout=240000 test/e2e/codex-think.test.ts` | 24 passed, 67 assertions; disposable cluster stopped |
| `bun test --timeout=60000 test/think-trajectory-injection.test.ts` | 11 passed, 22 assertions |
| `bun test --timeout=60000 test/think-pipeline.test.ts test/think-with-calibration.test.ts test/think-quote-verify.test.ts test/think-gateway-adapter.test.ts test/think-envelope-salvage.test.ts test/calibration-cli.test.ts` | 122 passed, 293 assertions |

Initial failures were fixture defects: missing required calibration columns and
a take citation absent from that fixture's actual query results. Corrected
fixtures pass. Final verification:

- `GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify`: 75 passed, 0 failed, 1 admin
  build skip; includes typecheck, architecture, size, isolation, registry and
  generated-document checks. The final gate initially caught an unregistered
  `retrieval_failed` code; the code is now registered and its documentation
  regenerated, with no waiver or ceiling increase.
- `bash scripts/check-test-discriminates.sh test/ai/codex-think.serial.test.ts src/core/think/index.ts`:
  the original `99183f5` dispatcher produced 1 pass / 20 failures for the initial
  21-case contract. The developed dispatcher was restored; the expanded 24-case
  contract passes on both engines.
- `bun run build`: passed, 3,628 modules. This builds the checkout's artifact;
  it does not replace an installed executable.
- `git diff --check`: passed.

The admin build would require an external dependency fetch and remains skipped.
Full CI, PgBouncer, real runtime isolation and live subscription checks remain
unverified. Installed and activated status are unchanged.

Recoverable saves and take writes are developed in the
[think publication follow-up](private-codex-think-publication.md). The earlier
verification counts above describe the synthesis checkpoint.
