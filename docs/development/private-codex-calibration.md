# Private Codex calibration checkpoint

This checkpoint changes source only. The installed GBrain is unchanged and the
production Codex runtime qualification registry remains empty.

## Shared voice review

`calibration/voice-gate.ts` dispatches private judgments to
`voice-gate-codex.ts`. Each call uses the existing gateway, subscription admission,
native JSON Schema and ephemeral Codex adapter. A host candidate hash and mode
bind the response to the actual text reviewed. Verdicts must be `conversational`
or `academic`; a nonempty reason has at most 80 characters and no control
characters. Candidate and rubric are each bounded to 4,000 characters. The
120-second call limit remains subject to the durable subscription envelope.

The utility model resolves through the strict resolver with the active envelope's
engine. Conflicting file/environment/DB/tier pins fail before content generation.
There is no provider fallback, discovery or native tool loop. The private gate
uses its native judge, so a legacy injectable judge cannot bypass validation.

Private voice review permits at most two content candidates. A valid negative
style judgment can authorize one content repair; the repair uses the existing
run-level repair allowance. An enclosing repair scope shares that same allowance.
Judge calls consume attempts and accepted turns independently and do not consume
a second content-repair allowance. Exhaustion stops the workflow.

Generation/provider failures, malformed judgments, refusal, absent completion and
invalid candidates are explicit failures. They never become negative grades or
a successful template. Two valid style rejections end as `voice_gate_rejected`.
Unknown generator exceptions are redacted; typed routing/admission/host errors
remain explicit. Unconfirmed inference retains its existing account-lane ownership.

A caller explicitly requesting `maxAttempts: 0` can still render its local
hand-written template without inference or subscription admission. This path is
separate from failure handling. Non-private judge parsing and template behavior
are unchanged.

## Coverage and remaining calibration work

The dispatcher inventory now distinguishes the actual `calibration_profile`
producer, its voice judge and the calibration A/B harness that invokes `think`.
The supported voice modes are pattern statement, nudge, forecast blurb, dashboard
caption and morning pulse. Tests establish the judge contract for all five;
source inspection currently finds the profile producer as the actual gate caller.
A list of supported modes does not establish five wired product surfaces.

Calibration is **partial**. Its profile producer still needs native structured
pattern/bias proposals, grounded metric checks, strict model selection across its
calls and source-bound persistence. The current legacy scorecard call omits its
source scope. Profile storage needs retained input/protocol provenance and
revalidation before persistence. Failure-aware private publication must replace
best-effort bias-tag failure handling. Domain aggregations, grade completion and
operator review must be preserved. The A/B harness depends on unfinished private
`think` acceptance and is not proven by these voice tests.

## Deterministic checks

`test/helpers/codex-voice-contract.ts` runs the actual gateway and durable ledger
with a hash-qualified fake executable. Captured argv, stdin, schema permissions
and environment keys prove transport without real credentials or inference. A
network tripwire is active. Fresh home/config directories and discovery-disabled
environments isolate each storage contract. PostgreSQL uses a fresh disposable
cluster and is stopped afterwards.

Coverage includes every voice mode, candidate binding, invalid verdicts/reasons,
unknown fields, malformed output, refusal, missing completion, one permitted
repair, repeated negative judgments, nested repair accounting, quota exhaustion,
model-pin conflicts, missing admission, input bounds, abort and explicit local
templates. Legacy voice/profile regressions remain separate from the native
contract. These are deterministic results, not live subscription verification.

### Commands and results

Commands used the credential-free environment scrubber with fresh HOME,
GBRAIN_HOME and CODEX_HOME, discovery disabled and test env-file loading disabled.

| Command | Result |
|---|---|
| `bun test --timeout=60000 test/ai/codex-voice.serial.test.ts` | 21 passed, 102 assertions |
| `bun test --timeout=240000 test/e2e/codex-voice.test.ts` | 21 passed, 102 assertions; disposable PostgreSQL stopped afterwards |
| `bun test --timeout=60000 test/voice-gate.test.ts test/voice-gate-judge-tier.test.ts test/calibration-profile.test.ts` | 49 passed, 120 assertions |
| `bun test --timeout=60000 test/ai/private-route-audit.test.ts` | 1 passed, 8 assertions; audit remains incomplete |
| `bash scripts/check-test-discriminates.sh test/ai/codex-voice.serial.test.ts src/core/calibration/voice-gate.ts` | Pre-change source `3c04403`: 0 passed / 21 failed; restored source: 21 passed |
| `GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 passed, 0 failed, 1 admin build skip; includes typecheck and architecture/size/registry/docs checks |
| `bun run build` | Passed, 3,621 modules |
| `git diff --check` | Passed |

Initial fixture failures used a nonexistent attempt timestamp and an incorrect
model-pin key. Corrected fixtures use `created_at` and `models.tier.utility` and
then passed on both engines. Full CI, admin UI, PgBouncer, real runtime isolation
and live subscription acceptance remain unverified here. No installed binary,
production migration, database target, model pin or service was changed.
