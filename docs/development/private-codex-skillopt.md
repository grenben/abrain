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

## Native optimizer proposals

The real `runReflect` and `runOneShotRewrite` entries select native schemas in
strict private mode. They require a host subscription allowance, preflight the
explicit optimizer pin and deep tier, refuse injected chat transports and
snapshot the entire input before asynchronous work. Bounds are 64,000 body
characters, 100 scored trajectories, 100 rejected entries and a 128 KiB snapshot.
Incomplete trajectories and failed judgments cannot supply optimization evidence.
Calls request at most 8,192 output tokens with a 120-second timeout; an explicit
unsupported cap or oversized input fails instead of being silently truncated.

Reflection uses tool-specific add/replace/delete schemas with bounded arguments
and reasons, at most 20 edits across the two sequential calls. The host runs
every proposed edit through the existing pure body patcher. Missing or ambiguous
targets, edits inside code fences, no-op edits, invalid text, generated frontmatter
and conflicting batches fail the entire proposal. Success reflection sees the
original body and prior failure edits and must produce a valid subsequent batch.
No partial candidate is returned if either call fails. A deliberate empty edits
array is a usable result. A body rewrite requires a complete nonempty body and
sufficient requested output headroom; transport truncation is still an error.

`codex-skillopt-reflect-v1` binds retained proposals to the host run, model, mode,
full captured inputs and prior edits. Accepted failure reflection survives a
later success-reflection failure, so retry reuses it without a second charge.
Every retained proposal passes schema and semantic validation again. Reports
separate cache hits, new measured tokens and null subscription price/quota.
There is no content repair, provider fallback or candidate publication here.
Validation demonstrates a safe patch candidate, not its quality or authorization
to publish. The existing validation gate and future durable publication remain
separate requirements.

## Remaining optimizer work

The legacy rollout uses `gateway.toolLoop` without durable action history and
therefore is not the selected private host action loop. Native structured
[benchmark-bootstrap proposals](private-codex-skillopt-bootstrap.md) now validate
complete review drafts under an existing host allowance. Whole-run subscription
admission, durable candidate recovery and prepared skill publication remain
separate work. The current tests of the real validation gate supply synthetic
completed trajectories; they do not prove native rollout execution. File-based
legacy optimizer checkpoints are not sufficient evidence of private recovery.

Installed GBrain, credentials, services, databases and private activation remain
unchanged. Runtime pre-execution isolation and bounded live subscription
acceptance remain unverified. No real inference CLI or provider is used in the
deterministic checks.

## Verified development checkpoint

The later [durable rollout checkpoint](private-codex-skillopt-rollouts.md) adds
actual scoped read jobs and real multi-repetition validation gates. Results
below describe the earlier judge/proposal checkpoint and synthetic rollouts.

These commands use fresh temporary configuration, discovery disabled, synthetic
fixtures, fake Codex executables and provider/network tripwires. Native
PostgreSQL runs use an authorized disposable cluster that is stopped afterward.

| Command | Result |
| --- | --- |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test --timeout=30000 test/ai/codex-think.serial.test.ts` | 365 passed; 1,301 assertions |
| `python3 /tmp/maxbrain-test-postgres-think.py` | Same 365 passed and 1,301 assertions; cluster stopped |
| `python3 /tmp/maxbrain-skillopt-judge-regressions.py` | Eleven separate legacy/diagnostic suites: 161 passed; 412 assertions |
| `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 passed, including typecheck; 0 failed; admin build explicitly skipped |
| `python3 /tmp/maxbrain-stream-check.py bun run build` | Compiled 3,695 modules |
| `git diff --check` | Passed |

The native judging contract contributes 25 cases and 78 assertions per
engine. It covers actual schema transport, strict numeric scores, exact quotes,
malformed/refused/incomplete output, changed input/cache identities, conflicting
pins, explicit admission, exhaustion, live judge cancellation, deterministic
scorers, first-failure gate stopping and the actual host median/epsilon decision.
The gate receives synthetic completed trajectories in these tests; native
rollout execution is explicitly outside this checkpoint. Full container CI,
admin UI and live subscription/runtime qualification were not run.

The new reflection/rewrite contract contributes 29 cases and 84 assertions per
engine: actual native schema transport, sequential conflicting edits, whole-batch
rejection, accepted-proposal recovery, deliberate empty results, explicit pin and
input bounds, snapshot identity, allowance exhaustion and active cancellation.

Logs use `/tmp/maxbrain-skillopt-proposals-`: `contract.log`, `postgres.log`,
`regressions.log`, `verify.log` and `build.log`. Separate legacy-suite logs use
`/tmp/maxbrain-skillopt-judge-regression-0.log` through `regression-10.log`. The build is a development artifact; it has
not replaced installed GBrain.
