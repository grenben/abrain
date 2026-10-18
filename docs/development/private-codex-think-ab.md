# Private calibration A/B trials

Source checkpoint based on `2e7755c`. Installed GBrain, its production database
and configuration are unchanged. No live inference or activation was performed.
The overall private Codex implementation remains incomplete.

## Changes

The former `runAbTrial` required an injected `thinkRunner`; its comment claimed
production wiring that did not exist. It could also record empty or failed
answers as completed comparisons. The private branch now calls the real native
`runThink` twice, sequentially, with an enclosing subscription allowance and no
provider fallback. Strict mode rejects injected runners and remote authority.
The legacy injectable harness remains outside private mode, with explicit empty
answer and invalid preference refusals.

Migration v272 adds `codex_think_ab_trials` with RLS and parity across PGLite and
PostgreSQL. Each trial binds a host UUID, subscription run, source incarnation,
question, holder, model, original local authority and optional worker fence.
It retains the actual calibration profile and each validated answer before the
next inference. Both calls use the same source, holder and model. A missing
profile fails before inference instead of silently comparing two baselines.

The existing think evidence capture now also supports retained read comparisons.
Each answer keeps its native schema-bound prompt digest, citations, measured
usage and bounded page/revision/take evidence. Profile and original evidence
changes are checked before inference and answer acceptance. A changed retrieval
set, take fingerprint, source incarnation, question, model or trial identity
refuses completion. Original worker fences cannot be replaced during replay.
The comparison is not a historical archive of every retrieval subsystem or a
serializable whole-corpus snapshot; broader trajectory/lineage coverage remains
part of the existing think acceptance gaps.

Generation stops on refusal, malformed output, missing completion, valid empty
answers, exhaustion, cancellation or storage failure. A retained baseline can be
reused for the second call. Neither failed nor partial trials contribute to win
rates. Local cancellation propagates to native process settlement; unresolved
attempts keep the existing subscription lane occupied.

A preference is explicit host input. Recording it inserts `think_ab_results` and
links the trial to the database-returned result ID in the same transaction. Lost
acknowledgements replay that ID; a competing or changed preference is refused.
Ready trials can be inspected and rated without inference, including after the
generation allowance expires. Source and original authority checks still apply.
The report remains deterministic, now parameterizes its 1–3650 day window and
honors the CLI's resolved source. Ordinary profile reads remain model-free.

## Source CLI interfaces

These commands are implemented in the development checkout, not the installed
executable. They do not activate private configuration themselves.

- `calibration ab-run <question>` requires strict private configuration and the
  existing three `--codex-max-attempts`, `--codex-max-turns`, `--codex-deadline`
  flags. At least two attempts/turns are needed for an ordinary complete pair;
  a smaller allowance can leave a retained partial trial. Optional
  `--codex-request-id <UUID>` is the trial ID. Reuse it with identical inputs
  and allowance to resume. `--max-usd` separately authorizes paid retrieval.
- `calibration ab-show <UUID>` reads the retained pair and status with no model.
- `calibration ab-rate <UUID> --prefer baseline|with_calibration|neither|tie`
  records an explicit preference; optional `--notes` is bounded to 4000 characters.
- Each accepts `--source` and `--json`; `ab-run` also accepts `--holder` and
  `--model`. `calibration ab-run --help` describes these interfaces.

Answers are displayed before a separate rating command. No default preference,
model-generated vote or implicit rejection is created. CLI JSON omits retained
authority objects. Subscription monetary cost remains unknown/null; token usage
is retained, and the existing independent paid-retrieval guard remains active.

## Deterministic evidence

The common fake-Codex contract exercises the real CLI, gateway, schema files,
subscription ledger, think retrieval and SQL transactions on both engines.
Credentials are absent, network calls are forbidden, discovery is disabled,
homes are fresh, and native PostgreSQL uses disposable clusters stopped after
checks. Existing think, publication and automatic-think tests remain included.

The new cases cover paired native prompts, source/profile isolation, evidence
hashes and citations, stable replay, partial recovery, refusal/malformed/missing
completion, profile/take drift, injected-runner refusal, remote denial, quota
exhaustion, changed input, canonical rating IDs, acknowledgement loss, competing
preferences, worker lease loss, active cancellation, CLI dispatch and scoped
reports. Focused legacy tests preserve report thresholds and non-private behavior.

| Command | Result |
|---|---|
| `bun test --timeout=30000 test/ai/codex-think.serial.test.ts` | 65 passed, 249 assertions |
| `bun test --timeout=240000 test/e2e/codex-think.test.ts` | 65 passed, 249 assertions, disposable PostgreSQL |
| `bun test --timeout=60000 test/think-ab.test.ts test/calibration-cli.test.ts test/think-with-calibration.test.ts` | 48 passed, 112 assertions |
| `bun test --timeout=240000 test/schema-catalog-golden.test.ts test/schema-migrations-replay.test.ts test/schema-bootstrap-coverage.test.ts` | 29 passed, 163 assertions |
| `bun test --timeout=240000 test/e2e/schema-catalog-golden.test.ts test/e2e/schema-migrations-replay.test.ts` | 12 passed, 31 assertions; 1 PgBouncer skip |
| `GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 passed, 0 failed, 1 admin-build skip; includes typecheck, architecture/size, registry and docs checks |
| `bun run build` | Passed, 3650 modules; checkout artifact only |
| `git diff --check` | Passed |

Catalog goldens were deliberately regenerated on both engines, inspected for
only the new v272 table, constraints and indexes, then tested with updates off.
No existing migration or size ceiling was changed. Admin UI dependency fetching,
PgBouncer, full CI and live-runtime qualification remain unverified. Local logs
are `/tmp/maxbrain-ab-{contract-final,postgres,regression,schema,pg-schema,verify,build}.log`.

Discrimination: `bash scripts/check-test-discriminates.sh test/ai/codex-think.serial.test.ts src/core/calibration/think-ab.ts src/commands/calibration.ts`
restored the `2e7755c` harness and command temporarily: **61 passed / 4 failed**.
The developed files were restored. The failures exercise actual native harness,
CLI and scoped-report behavior, rather than missing imports.

## Remaining acceptance and upgrade

The production executable qualification registry remains empty. Real native
pre-execution isolation, live subscription behavior, full process-kill coverage,
operator reconciliation/lease rebinding and remaining generation roles are still
open. An ambiguous or expired partial trial is retained for inspection; this
change does not authorize resetting its allowance or replaying unknown effects.

After separately authorized deployment and the remaining gates: build the
verified source, preserve/back up the actual database target, apply the registered
migrations through v272, update every consumer and restart the actual services.
Bounded authorized live schema/image, maintenance, iterative recovery and
cancellation checks must pass before explicit activation. The installed GBrain
retains its original capabilities.
