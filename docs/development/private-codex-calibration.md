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

## Private profile producer

The private `calibration_profile` dispatcher now uses native pattern/bias proposals
through the gateway and the existing voice gate. The legacy producer remains for
non-private callers. The private producer rejects remote authority, conflicting
reasoning/utility pins and missing subscription admission before inference.
Each source gets its own holder-scoped scorecard, domain pack and evidence hash.
Deleted-page takes are excluded. Cold sources (fewer than five resolved takes)
skip without inference or a success row. Existing grade completion and all four
domain aggregators remain available.

The host supplies metric IDs, exact metric phrases and allowable confidence-bias
tags. Responses require two to four distinct statements, the matching metric
quote/domain, fewer than 25 words, no extra numeric claims and only an allowed
bias tag. These checks establish metric binding; they do not prove all
natural-language implications. One negative voice judgment permits one repair
shared across layers. Invalid proposals and failed judgments stop explicitly.

Bounds: at most 20 sources, 32 domains per source, 80 supplied facts, 2,048 output
tokens for each proposal, 120 seconds per call, and a ten-minute phase bound
shortened by its enclosing deadline. Subscription attempts/accepted turns and
account-lane ownership still apply. USD cost remains null. No auxiliary paid
inference is authorized by the direct command.

Migration **v281** adds retained profile evidence and a unique source/holder/run
receipt key, identically on PostgreSQL and PGLite. The sole profile insert is
transactional and unpublished. Evidence stores protocol/version, source
incarnation, principal, pack identity, snapshot hash, aggregate metrics, supplied
facts and the accepted proposal. It does not archive every underlying take.
Before insertion, source/writer/job authority, pack identity and the evidence
fingerprint are rechecked. Failed insertion creates no success row; loss of the
acknowledgement after commit reconciles the same retained receipt without another
model call. Changed request inputs refuse reuse. Earlier sources' committed
profiles survive a later source failure, with a partial outcome.

Direct private regeneration requires explicit `--codex-max-attempts`,
`--codex-max-turns` and `--codex-deadline` flags. Optional
`--codex-request-id <UUID>` binds retries to the same source incarnation, holder,
model and executable selection. Reuse the identical allowance/deadline; changed
inputs are refused, including simultaneous requests. The command prints the ID
and non-secret allowance summary. It shares workers' `codex-subscription` lane.
Ordinary `gbrain calibration` reads remain model-free. These flags are source
interfaces; they are not instructions to activate the installed executable.

Calibration as a whole remains **partial**. The subsequent
[native A/B checkpoint](private-codex-think-ab.md) implements paired trials,
retained evidence, explicit preferences and source-scoped reports. Full scheduled-worker dispatch, real process crashes,
native runtime isolation and live subscription behavior are not established by
these focused tests. Aggregate hashes represent observed input snapshots; they
are not a historical corpus archive or a general serializable database snapshot.

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

## Profile verification checkpoint

The profile contract uses the real phase, gateway, adapter, durable admission,
CLI dispatcher and database insertion with synthetic data and a hash-qualified
fake executable. No real inference or production database was used.

- PostgreSQL: 26 profile contract cases, 95 assertions passed, including changed
  inputs racing on one CLI request and acknowledgement loss after commit.
- Existing profile/CLI/domain/voice regressions: 85 cases, 189 assertions passed.
- The first native concurrency run exposed two simultaneous shared-to-exclusive
  lock upgrades. Admission now takes the exclusive brain lock before declaring
  the shared persistence protocol; the corrected native contract passes.
- Schema goldens also incorporate the previously implemented v230 take-proposal
  column, whose migration-record golden was stale. No prior migration changed.

| Final command (isolated harness) | Result |
|---|---|
| `bun test --timeout=60000 test/ai/codex-calibration.serial.test.ts` | 26 passed, 95 assertions |
| `bun test --timeout=240000 test/e2e/codex-calibration.test.ts` | 26 passed, 95 assertions; disposable cluster stopped |
| `bun test --timeout=60000 test/calibration-profile.test.ts test/calibration-cli.test.ts test/domain-aggregators.test.ts test/voice-gate.test.ts test/voice-gate-judge-tier.test.ts` | 85 passed, 189 assertions |
| `bun test --timeout=240000 test/schema-catalog-golden.test.ts test/schema-bootstrap-coverage.test.ts test/schema-migrations-replay.test.ts test/migrations-fresh-install.test.ts test/migrations-golden.test.ts` | 41 passed, 222 assertions; goldens fixed after reviewed regeneration |
| `bun test --timeout=240000 test/e2e/schema-catalog-golden.test.ts test/e2e/schema-migrations-replay.test.ts` | 12 passed, 31 assertions; 1 PgBouncer skip; disposable cluster stopped |
| `GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 passed, 0 failed, 1 admin build skip; typecheck, architecture, size, registries and docs included |
| `bun run build` | Passed, 3,627 modules |
| `bash scripts/check-test-discriminates.sh test/ai/codex-calibration.serial.test.ts src/core/cycle/calibration-profile.ts` | Dispatcher reverted to `95d7fc0`: 4 passed / 22 failed; restored: 26 passed |
| `git diff --check` | Passed |

The first negative-control attempt exposed a test-harness issue: the CLI exit
ended the test runner before its summary. The fixture now intercepts that exit,
allowing all failures to be counted and cleanup to run.

The admin build would require an external dependency fetch and was skipped.
PgBouncer is unavailable. Full CI and live checks remain unverified. No production
migration has been applied.
