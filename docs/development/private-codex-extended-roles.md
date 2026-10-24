# Extended private Codex roles

This development branch implements the 18 extended caller roles on the shared
role/tier foundation. Runtime qualification and production activation remain
separate: no real Codex subscription model is called by the synthetic tests,
and no production policy, service, database or executable is changed.

## Caller behavior

| Role | Tier | Implemented behavior and synthetic contract |
| --- | --- | --- |
| `auto-think` | deep | Own role survives nested think calls, retained batches and prepared publication; automatic-think contract. |
| `calibration-think-ab` | deep | Both comparisons retain the A/B identity, profile/evidence provenance and partial-trial recovery; A/B contract. |
| `parser-fallback` | utility | Native parsing checks its role before raw-cache lookup and dispatch; parser contract. |
| `parser-polish` | utility | Explicit scan preview returns separate formatting without replacing parsed evidence; polish contract. |
| `brainstorm` | deep | Cross generation and retained brainstorm workflow use the generator role; brainstorm pipeline contract. |
| `brainstorm-judge` | utility | Exact-ID judging has independent activation and model selection; brainstorm judge contract. |
| `skillopt-judge` | reasoning | Native scoring and validation preflight use the judge role; scoring and optimizer contracts. |
| `skillopt-optimizer` | deep | Reflection, workflow preflight and queued producers carry optimizer identity; optimizer recovery contracts. |
| `skillopt-bootstrap` | deep | Benchmark proposals and queued bootstrap preflight require bootstrap activation; drafts still require review. |
| `nightly-probes` | reasoning | Scheduled grant and cross-modal panel require the parent role; reader/extractor keep their separate roles. |
| `longmemeval-reader` | reasoning | Direct readers check activation and database pins before native proposals; evaluation contract. |
| `longmemeval-fact-keys-paper` | utility | Paper extraction uses its own native proposal and model selection; fact-key contract. |
| `longmemeval-fact-keys-production` | reasoning | Production extraction preserves benchmark identity through the shared fact extractor; fact-key contract. |
| `longmemeval-synopsis` | utility | Benchmark synopses retain their identity through the shared reindex and summary service; synopsis-tier contract. |
| `longmemeval-extractor` | utility | Reader-input extraction uses its own activation and schema; evaluation and nightly contracts. |
| `longmemeval-judge` | deep | Direct and shared benchmark judgments use the judge identity; evaluation contract. |
| `contradiction-probe` | utility | CLI, direct judge and probe runner check the same role and applicable pins; contradiction contract. |
| `iterative-minions` | subagent | Queue preflight, rollout and sequential host-action handler retain the action role; queue/worker/recovery contracts. |

Every role above has source implementation; real-model acceptance is **not run**
and activation is **off**. A disabled optional feature still does no work. A
requested private role that is disabled fails before inference; subagent and
optimizer queue preflight also refuses it before inserting a job or allowance.
Composite features require their selected dependency roles. Enabling
`nightly-probes`, for example, does not grant its reader or extractor permission.

The implementation passes trusted role identity to the resolver and gateway,
including nested core helpers. Four distinct model pins remain independent.
Role/policy changes invalidate private caches and retained workflow identities;
legacy scalar identities keep their existing shape where an identity already
exists. Parser raw caches advance to `private-parser-cache-v2`, so old entries
cannot bypass activation. Existing counters are never reset to obtain a retry.
Policy scopes recheck after awaited host authority checks, including retained
results that need no new model call. Auxiliary embedding/reranking admission
continues to use its independent monetary budget.

## Parser presentation preview

`conversation-parser scan <slug>` remains deterministic. The explicit
`--polish` option requires strict private mode, the `parser-polish` role and a
host allowance, or explicit local limits:

```sh
gbrain conversation-parser scan conversations/example --polish --json \
  --codex-request-id 123e4567-e89b-42d3-a456-426614174000 \
  --codex-max-attempts 1 --codex-max-turns 1 \
  --codex-deadline <future-UTC-timestamp>
```

The JSON envelope includes a separate `presentation` array with original
message indices. Only whitespace and paragraph formatting may change; words,
numbers, spelling, URLs, quoted literals and code remain intact. This deliberately
bounded first implementation is not a rewriting or grammar-correction feature.
It never replaces the stored transcript or extraction input. Inputs are bounded
to 100 nonempty messages and 64 KiB; outputs require exact ordered coverage.
Malformed, refused, incomplete, changed-evidence or cancelled results fail.
Only the allowance and validated proposal cache persist. Reusing a request ID
with changed evidence, source incarnation, policy or limits refuses the request.

## Verification and limits

Existing fake-executable contracts run through real CLI/worker/feature callers,
native schemas, database ledgers and publication/recovery paths. Tiered fixtures
enable only required roles and put unused tiers on different synthetic models.
Additional cross/judge, nested A/B and queued-action tests assert distinct
executable model arguments. Revocation tests cover cached parser results,
asynchronous A/B fences, queue admission and scheduled-nightly admission.
The final handoff records exact commits, completed file suites, counts and logs.

This checkpoint does not qualify a real executable or model, enable a native
provider tool loop, authorize remote delegation, publish generated benchmark
drafts, or establish a full-project CI result. The no-call audit remains
conservative. Production cutover still requires the integrating session's core
role work, real-model evidence, backup/rollback and service-switch gates.
