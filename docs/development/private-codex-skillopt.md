# Private Codex skill optimization

**Say to your agent:** *“Complete native Codex skill optimization with honest
judgments, durable rollouts and authorized candidate publication.”*

## Native judge checkpoint

The real `scoreTrajectory` LLM branch now selects bounded native Codex judging
under strict private mode. The rule and qrels scorers remain deterministic and
do not acquire a subscription or model dependency. Non-private LLM behavior is
preserved. This checkpoint does not claim the complete optimizer is activated
or that its existing native-tool rollout loop has been replaced.

Judging requires an existing host allowance. Both task-level and command-level
judge pins are checked; a task override cannot conceal a conflicting command
pin. The reasoning tier and applicable file/environment/database defaults pass
through the strict resolver. Injected chat transports are refused in private
mode. The host snapshots the rubric and complete supplied trajectory before
asynchronous work. Only terminal `end` trajectories can receive a native grade;
truncation, refusal, abort and incomplete turns cannot become numeric scores.

Inputs are bounded to 16,000 characters each for the task/rubric, 64,000 for the
final text, 128 recorded tool calls and a 256 KiB serialized snapshot (the shared
gateway's tighter prompt bound also applies). Each native call is ephemeral,
uses a 120-second timeout and requests 2,048 output tokens. Its native JSON
Schema permits only an evidence hash, numeric score in `[0,1]`, bounded rationale
and an exact quote from the final output. Empty completed text uses a null quote.
Scores are never coerced or clamped. Invalid output, schema/transport failure,
refusal, quota exhaustion and cancellation throw instead of returning score 0.
A valid schema-constrained zero remains an ordinary grade.

Accepted proposals use `codex-skillopt-judge-v1`, bound to the grant, model,
rubric and captured trajectory. Retained results pass current authority and
schema/semantic checks again; cache hits report no new token usage. Measured
judge tokens and null subscription price/quota are exposed separately from
rollout usage. This reuses the existing proposal cache and subscription tables;
no schema migration is added by the judge change.

## Acceptance gate

The actual private `runValidationGate` preflights explicit target/judge/task
pins and their model tiers before any rollout. It bounds task and repetition
counts, evaluates sequentially, and stops after its first failure. Every rollout
must be terminal, including when its judge is a deterministic rule. Judge errors,
invalid scores, incomplete tasks and cancellations cannot yield an accept/reject
decision or a partial zero-filled measurement. Completed grades still use the
existing host median and epsilon rules. Abort reaches an active native judge.
Typed Codex admission, routing and proposal failures are must-abort errors at
optimizer, bootstrap and held-out catch boundaries too.

## Remaining optimizer work

The legacy rollout uses `gateway.toolLoop` without durable action history and
therefore is not the selected private host action loop. Native structured
optimizer/reflection and benchmark-bootstrap proposals, whole-run subscription
admission, durable candidate recovery and prepared skill publication remain
separate work. The current tests of the real validation gate supply synthetic
completed trajectories; they do not prove native rollout execution. File-based
legacy optimizer checkpoints are not sufficient evidence of private recovery.

Installed GBrain, credentials, services, databases and private activation remain
unchanged. Runtime pre-execution isolation and bounded live subscription
acceptance remain unverified. No real inference CLI or provider is used in the
deterministic checks.

## Verified development checkpoint

These commands use fresh temporary configuration, discovery disabled, synthetic
fixtures, fake Codex executables and provider/network tripwires. Native
PostgreSQL runs use an authorized disposable cluster that is stopped afterward.

| Command | Result |
| --- | --- |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-think.serial.test.ts` | 336 passed; 1,217 assertions |
| `python3 /tmp/maxbrain-test-postgres-think.py` | Same 336 passed and 1,217 assertions; cluster stopped |
| `python3 /tmp/maxbrain-skillopt-judge-regressions.py` | Eleven separate legacy/diagnostic suites: 161 passed; 412 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 74 passed, including typecheck; admin build skipped; duplicate documentation entry found |
| `python3 /tmp/maxbrain-stream-check.py bun run check:doc-history` | Passed after consolidating the duplicate entry |
| `python3 /tmp/maxbrain-stream-check.py bun run build` | Compiled 3,694 modules |
| `git diff --check` | Passed |

The new native judging contract contributes 25 cases and 78 assertions per
engine. It covers actual schema transport, strict numeric scores, exact quotes,
malformed/refused/incomplete output, changed input/cache identities, conflicting
pins, explicit admission, exhaustion, live judge cancellation, deterministic
scorers, first-failure gate stopping and the actual host median/epsilon decision.
The gate receives synthetic completed trajectories in these tests; native
rollout execution is explicitly outside this checkpoint. Full container CI,
admin UI and live subscription/runtime qualification were not run.

Logs use `/tmp/maxbrain-skillopt-judge-`: `contract.log`, `postgres.log`,
`regressions.log`, `regression-0.log` through `regression-10.log`, `verify.log`,
`doc-history.log` and `build.log`. The build is a development artifact; it has
not replaced installed GBrain.
