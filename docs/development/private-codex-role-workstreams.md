# Private Codex role development workstreams

This is a development checkpoint, not activation approval. The inventory has
39 roles: 21 core and 18 extended. Existing scalar-model fixtures do not prove
that a feature works with distinct model tiers. Production runtime qualification,
real-model acceptance, and migration/rollback gates remain separate requirements.

## Shared contract

The new operator-file policy shape uses `private_codex.models` with explicit
`utility`, `reasoning`, `deep`, and `subagent` pins, each `codex-cli:<model-id>`,
plus `enabled_roles`. All four pins and an explicit role list are required;
an empty list disables all tiered dispatch. Model identifiers require actual
runtime/subscription qualification before deployment. This document selects none.

The legacy scalar `private_codex.model` shape remains supported for compatibility.
It does not provide per-role activation. Do not treat scalar compatibility as the
new rollout policy or combine `model` with `models`/`enabled_roles`.

- `PrivateRole`, `PrivateModelTier`, `PRIVATE_GENERATION_ROLES`, and
  `PRIVATE_CORE_ROLES` in `src/core/ai/private-roles.ts` are the inventory.
- `resolveModelDetailed(engine, { privateRole, ... })` checks activation and
  resolves the role's tier while refusing conflicting explicit pins, including
  shadowed pins. An explicitly supplied `tier` must agree with the role.
- `privateModelForRole(policy, role)` is the file-policy lookup with activation
  enforcement. It does not replace applicable database/CLI/environment checks.
- Gateway `chat` and `cachedCodexProposal` take host-supplied `privateRole`.
  Direct `dispatchCodexProposal` takes `role`. Missing identity in tiered mode,
  a disabled role, or the wrong model is refused. Never derive permission from
  a prompt, model output, or untrusted job field.
- Dispatch acceptance and proposal-cache keys bind the complete policy and role.
  `privatePolicyBinding`/`privatePolicyMatchesBinding` bind retained work; scalar
  identities retain their previous model/bin shape, while tiered identities add
  a canonical policy fingerprint. The binding's `model` field is legacy metadata,
  not a model selector for inference.
- No automatic provider fallback, inferred subscription allowance, reset of
  retry counters, or qualification bypass is permitted. Embedding/reranking
  costs retain independent auxiliary API admission.

The no-call route audit reports requested activation, tier and release group
separately from actual dispatch and feature acceptance. It deliberately remains
incomplete until supported by feature and runtime evidence.

Proposal request/cache identities advance to v2. Old v1 proposal-cache entries
are not reused; a resumed workflow may need another admitted attempt or refuse
an exhausted allowance. Existing counters and publication receipts must not be
cleared to make a retry succeed. This cache change is separate from preserving
legacy scalar queue/recovery identities.

## Ownership

Use independent branches and worktrees from the same tested foundation commit.
The integrating session owns shared policy, gateway, dispatcher, cache, model
resolver, queue admission, runtime qualification and deployment tooling. Changes
to these contracts must be coordinated before another workstream depends on them.

The integrating session also owns the 21 core roles: `chat`, `think`,
`query-expansion`, `enrichment`, `contextual-synopsis`, `page-summary`, `ocr`,
`facts`, `classifiers`, `atoms`, `dream-triage`, `dream-synthesis`, `patterns`,
`concepts`, `drift`, `take-grading`, `take-proposals`, `take-calibration`,
`calibration-voice-judge`, `edge-contradictions`, and `fence-repair`.

The second session owns these 18 extended feature callers and their tests:

| Group | Roles | Main source areas |
| --- | --- | --- |
| Think workflows | `auto-think`, `calibration-think-ab` | `src/core/cycle/auto-think*`, `src/core/calibration/think-ab*` |
| Parsing | `parser-fallback`, `parser-polish` | `src/core/conversation-parser/` |
| Brainstorm | `brainstorm`, `brainstorm-judge` | `src/core/brainstorm/`, `src/eval/brainstorm/` |
| Skill optimization | `skillopt-judge`, `skillopt-optimizer`, `skillopt-bootstrap` | `src/core/skillopt/`, `src/core/shared-skills/codex-optimizer*` |
| Scheduled evaluation | `nightly-probes` | `src/commands/*probe*`, `src/core/cycle/nightly-*` |
| LongMemEval | `longmemeval-reader`, `longmemeval-fact-keys-paper`, `longmemeval-fact-keys-production`, `longmemeval-synopsis`, `longmemeval-extractor`, `longmemeval-judge` | `src/eval/longmemeval/`, `src/eval/shared/` |
| Contradiction evaluation | `contradiction-probe` | `src/core/eval-contradictions/`, `src/commands/eval-contradictions*` |
| Bounded host actions | `iterative-minions` | `src/core/minions/handlers/subagent-codex.ts`, `src/core/minions/codex-action-*` |

The second session should request shared changes through the integrator, including
changes to core helpers reused by evaluation features. It must preserve the
existing source/authority/publication boundaries. An inventory entry alone is
not implementation: `parser-polish` needs a real caller with an observable result.

The extended caller implementation and its verification are tracked in
[the extended role checkpoint](private-codex-extended-roles.md).

## Per-group checkpoints

1. Trace real entrypoints through CLI, scheduler, worker, retry, cache and
   publication. Record missing paths and forbidden native-loop assumptions.
2. Add trusted role identity and role-specific model resolution throughout those
   paths. Keep disabled roles refused before inference; coordinate earlier
   producer/queue rejection with the integrating session. Preserve ordinary
   non-private behavior and legacy scalar compatibility.
3. Exercise public feature entrypoints with distinct synthetic tier models and
   registered fake executables, network tripwires, and disposable databases.
   Check the actual model argument, schema and semantic validation, publication
   effects, source isolation, disabled-role behavior, policy changes, exhausted
   allowances, cancellation, crashes and replay where applicable. Use existing
   shared contracts for PGLite/PostgreSQL parity; record any unrun engine lane.
4. Commit a reviewable group after relevant tests and typecheck pass. Record the
   commit, commands, exit codes, pass/fail/skip counts and sanitized receipts.
   Distinguish a clean suite run from reconciled results or targeted reruns.
5. Return a role matrix marking implementation, synthetic acceptance, real-model
   acceptance and activation separately. Integrate small commits and run the
   combined regression gates on the exact resulting tree.

## Remaining shared gates

The extended branch through `57592ea142` is integrated with the core caller
routing, native concepts/fence repair and tier-aware pin migration. The
[core checkpoint](private-codex-core-roles.md) records retained-policy and
producer checks. Selected combined regressions and baseline discrimination
are recorded with the local handoff; full CI remains a release gate.

The production executable allowlist remains empty. No real subscription model
has been accepted, and no role is activated by these source changes. Protected
runtime tests and real-model acceptance must prove the selected four model pins
on the intended production host. Native loops and remote delegation retain
their existing restrictions; the 39-role inventory is not all GBrain surfaces.

Neither session may change the installed package, live brain content/database,
services, credentials or production configuration as part of this development.
Do not interrupt unrelated tests or include private prompts/session logs in
handoffs. Production cutover still requires the selected content-treatment
rehearsal evidence, paired backup/rollback rehearsal, service switch preparation,
graph catch-up, protected-runtime qualification, real-model acceptance, and an
explicit activation decision. Unaccepted extended roles remain disabled at the
core migration.
