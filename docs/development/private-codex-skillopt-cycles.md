# Scheduled private Codex skill optimization

The `skillopt` maintenance phase uses the retained native batch coordinator when
private Codex mode is explicitly configured. The feature remains off by default.
This source change does not install, activate or run maintenance on a live brain.

## Trusted configuration and admission

The host must supply an existing subscription allowance. Scheduled jobs retain
their durable queue admission, daily limits, shared account lane and worker
fence. A USD-only phase budget cannot authorize Codex calls. Paid auxiliary calls
still require independent admission; current scoped optimizer reads use no paid
embedding or reranking provider. Subscription cost and remaining quota are null.

`cycle.skillopt.codex` is a trusted JSON configuration value with these fields:

| Field | Meaning |
| --- | --- |
| `sourceId` | Explicit source for all benchmark reads |
| `skillsDir` | Absolute directory containing reviewed local skills and benchmarks |
| `allowedTools` | Explicit permitted reads, such as `["get_page"]` |
| `allowedSlugPrefixes` | Explicit source-local scope, such as `["notes/*"]` |
| `readRegistry` | Optional `codex-discovery-v1` for supported discovery tools |
| `maxSkillsPerCycle` | 1–20; defaults to 1 |
| `maxAttemptsPerSkill` | Required positive integer, at most 1,000 and within the host grant |
| `maxTurnsPerSkill` | Required positive integer, at most the per-skill attempts and within the host grant |

Unknown fields, forbidden tools, conflicting explicit cycle source, missing
directories and missing admission fail before inference. The global scheduler
uses the configured source, not the worker's current directory. Private model
pin conflicts retain the strict resolver behavior.

`cycle.skillopt.enabled` controls execution; `--once` bypasses only that feature
flag. Dry-run checks configuration, routing and directory discovery without
grants, benchmark execution, retained selections or publication. It does not
claim full benchmark validation. Automatic work retains one epoch, batch size
4, learning rate 4 with cosine decay, split 4:1:5 and a ten-minute per-skill
runtime limit. Benchmarks must meet existing validation minimums. All generated
changes remain review proposals; original skill files are not replaced.

## Selection, completion and recovery

Migration 283 retains the source incarnation, configuration/model binding and
selected skill names under the original subscription run. Selection is sorted,
bounded and persisted before optimizer effects. Repeating that run uses the
same selection even if new skills appear. Missing selected skills and changed
material inputs fail. Foreground batches cannot adopt a cycle's identity.

Successful cooldowns are source/incarnation scoped and require the exact batch's
completed member receipts. `cycle.skillopt.stale_days` defaults to seven days.
Completion acknowledgement loss does not extend the retained completion time
on retry. Legacy global `last_run.<skill>` timestamps remain separate.

A preflight failure before a batch exists records a failed cycle and imposes a
24-hour error cooldown on that selection, without a success receipt. Once a
batch exists, failures, exhaustion, cancellation and partial publication retain
pending work. A different root cannot begin another cycle for the same source
incarnation while it remains pending. Retry with the original grant and unchanged
inputs; deadlines and limits are never renewed implicitly. Expired or ambiguous
runs still need operator reconciliation; broader disposition tooling is incomplete.

Completion checks actual receipts; it does not claim filesystem batch atomicity.
Committed proposals remain committed after acknowledgement loss and reconcile
without regeneration. Failures expose bounded reason codes, without raw provider
errors or fallback providers. A failed phase blocks the global maintenance stamp.

## Verification and remaining work

`test/helpers/codex-skillopt-cycle-contract.ts` exercises the real phase, cycle
dispatcher, queued maintenance handler, optimizer, ledger and file publication
using synthetic fixtures and a qualified fake Codex executable. See the
[development checkpoint](private-codex-status.md) for exact results.

These tests verify source. Runtime qualification, live subscription checks,
production migrations, installation and activation remain separate gates.
Queued batch submission is available through the public trusted package API;
fleet and shared catalog batch producers remain incomplete. Account-lane
coordination currently spans one database.

**Say to your agent:** *“Inspect the scheduled optimizer's source, read scope,
allowance and pending cycles without running inference.”*

**Say to your agent:** *“Show the retained receipts and recovery steps for this
optimizer cycle before authorizing another run.”*
