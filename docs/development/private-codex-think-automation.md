# Private think CLI and automatic questions

Development checkpoint on `codex/private-subscription-v1`, based on `bb13e68`.
Installed GBrain, production data, configuration and services are unchanged.
This implements source behavior; fake executables do not qualify a live runtime.

## Before and after

| Area | Before this change | Current source |
|---|---|---|
| Local `think` | Core subscription and publication support; CLI supplied no allowance | Explicit attempts, accepted turns, deadline and stable request UUID wrap generation and required saves |
| Paid retrieval | Core required an enclosing paid guard | CLI has a separate durable `--max-usd` budget; unknown usage keeps its reservation |
| Automatic questions | Standalone legacy function; no actual cycle dispatcher entry | Opt-in `auto_think` phase in ordinary, scheduled and queued cycles |
| Private automatic completion | No retained batch or complete-batch cooldown | v271 stores source-bound questions, accepted answers and completion; every selected answer and required save must succeed |
| Managed API-mode save | Direct maintenance transaction | Existing canonical prepared-write path, retaining legacy citation behavior |

Earlier descriptions of automatic think as already dispatched were incorrect.
Tracing `runCycle` showed the standalone function had no production dispatcher.
The phase is still disabled unless `dream.auto_think.enabled` is explicitly true.
Nothing in this change changes an installed setting.

## CLI contract

In strict private mode, local `think` accepts:

- `--codex-max-attempts N`: integer 1–1000.
- `--codex-max-turns N`: integer 1–attempts.
- `--codex-deadline <UTC ISO timestamp>`: future absolute time within 24 hours.
- `--codex-request-id <UUID>`: optional; generated and printed if omitted.
- `--max-usd <amount>`: optional, separate paid embedding/reranking authorization.

All three subscription bounds are required. Neither a USD cap nor `--yes`
authorizes subscription calls. Reuse the printed UUID with the exact question,
source scope, model, options, limits and deadline to reconcile a request.
Changing the source incarnation, paid cap or input under the UUID is refused.
Thin clients cannot transmit these flags as spending authority. An existing
host subscription scope is inherited without accepting additional CLI grants.

`withThinkSubscription` binds the allowance to source incarnations under the
brain persistence lock and uses the existing shared account lane. It wraps both
`runThink` and save/take publication. The pre-existing v270 retained plans and
canonical receipts implement save recovery; this change does not replace them.
Subscription cost and remaining quota remain null. Measured token counts remain
available. The auxiliary guard reserves the full known maximum before dispatch;
unknown prices are refused, and unknown usage retains the monetary hold.

## Automatic questions

The cycle phase uses the enclosing host's durable subscription allowance.
A phase USD setting only limits independently authorized auxiliary work; it does
not authorize it. Questions are sequential: at most 20 selected from a validated
configuration of at most 100 distinct, nonempty questions, each at most 16,000
characters. Dry runs consume no allowance and retain no batch.

Migration v271 registers `codex_auto_think_runs` for both storage engines. A batch
binds the original source incarnation, authority, selected questions, settings,
model and any job fence. Acceptance serializes against topology changes; one
unfinished batch per source is enforced by a partial unique index. Another run
cannot replace it. Resume the original run and inputs; changed inputs fail.

Accepted answers are retained before their required effects. Draft-only answers
remain in this owner-side table. Saved answers use the v270 publication plan,
evidence checks and actual committed receipts. A retry skips completed questions
and uses retained accepted answers. Cooldown starts only when every selected
question completes, and is source scoped. A valid empty answer, refused proposal,
malformed response, admission refusal or publication failure leaves the batch
incomplete and cooldown unchanged. Reports use bounded failure codes.

The cycle signal and deadline reach the native process adapter. Cancellation
awaits local process settlement. The existing ledger retains ambiguous attempts
as unresolved and holds their account lane; another batch cannot hide them.
Committed publication receipts remain durable even when cancellation prevents the
batch from advancing. Original worker fences are rechecked on batch writes.

## Verification

All tests used fresh isolated homes, discovery disabled, synthetic databases and
fake inference. The shared contract installs a forbidden-network tripwire.

| Command | Result |
|---|---|
| `bun test --timeout=30000 test/ai/codex-think.serial.test.ts` | 47 passed, 166 assertions |
| `bun test --timeout=240000 test/e2e/codex-think.test.ts` | 47 passed, 166 assertions, disposable PostgreSQL |
| `bun test --timeout=60000 test/auto-think-phase.test.ts test/cycle-auto-think-config-zero.test.ts test/think-save-source.test.ts test/autopilot-global-maintenance.test.ts test/cycle-phase-containment.test.ts test/cycle-phase-deadline-drift.test.ts` | 54 passed, 310 assertions |
| `bun test --timeout=60000 test/managed-phase-matrix.test.ts -t 'auto_think\|every cycle phase'` | 2 passed, 42 assertions; PGLite, other phases filtered |
| `bun test --timeout=60000 test/think-cli-source-flag.serial.test.ts` | 13 passed, 36 assertions |
| `bun test --timeout=60000 test/managed-phase-matrix.test.ts -t 'auto_think\|every cycle phase'` with isolated PostgreSQL | 3 passed, 54 assertions, both engines; other phases filtered |
| `bun test --timeout=240000 test/schema-catalog-golden.test.ts test/schema-migrations-replay.test.ts test/schema-bootstrap-coverage.test.ts` | 29 passed, 163 assertions |
| `bun test --timeout=240000 test/e2e/schema-catalog-golden.test.ts test/e2e/schema-migrations-replay.test.ts` | 12 passed, 31 assertions; 1 PgBouncer skip |
| `GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 passed, 0 failed, 1 admin-build skip; includes typecheck and architecture/size/registry/docs checks |
| `bun run build` | Passed, 3,645 modules; checkout artifact only |
| `git diff --check` | Passed |

Catalog goldens were regenerated deliberately on both engines, then verified
with updates disabled. Differences add only the v271 table, constraints and
indexes. Native clusters were stopped after testing. No production migration was
applied. Admin UI dependency fetching, PgBouncer and full CI remain unverified.

The contract covers captured native schema transport, stable CLI replay, changed
inputs/caps, independent paid holds, swallowed admission errors, retained draft
recovery, valid empty output, committed saves, cooldown, foreign brain and pin
refusal, active cancellation, unfinished-batch exclusion, original worker-fence refusal before inference and
the real dispatcher.
The prior 35 core think/publication tests remain included. An initial fault spy
bound transaction calls to the root PGLite connection and deadlocked; corrected
receiver binding preserves the transaction. The cancellation fixture also now
observes rejection without blocking the test before it can send cancellation.

Discrimination: `bash scripts/check-test-discriminates.sh test/ai/codex-think.serial.test.ts src/commands/think.ts src/core/cycle.ts`
restored the previous `bb13e68` CLI and dispatcher temporarily: **45 passed,
2 failed**. The failing checks were the explicit CLI save and actual cycle phase;
all source files were restored. No size ceiling was increased.

## Limits and upgrade handoff

This is not full A–G acceptance. The production runtime qualification registry
is still empty; native pre-execution isolation remains a blocker to live use.
The shared subscription lane covers one brain database, not unrelated databases.
The CLI currently requires a future deadline even for receipt-only replay;
expired requests need the existing host receipt/reconciliation path. Automatic
batches with an expired allowance, ambiguous attempt or stale worker fence stay
pending. Operator inspection, disposition and lease rebinding tooling, a draft
browsing command, complete process-kill coverage and calibration A/B trials remain
open. No automatic lease reclamation or new-run regeneration bypass is provided.

After separately authorized deployment and passing remaining runtime gates:
build the verified source, preserve/back up the actual database target, apply
registered migrations through v271 using the installation's supported procedure,
upgrade all consumers and restart the actual services. Then perform bounded live
schema/image, maintenance, action-recovery and cancellation checks before explicit
activation. No installed executable was replaced in this development session.
