# Private Codex synthesis checkpoint

This checkpoint connects the synthesis dispatcher to bounded Codex proposals and
the retained publication plans introduced in v261. It is source development only:
the installed GBrain, production database, credentials and activation are unchanged.

## Implemented behavior

`runPhaseSynthesize` selects `runPrivateSynthesize` only under explicit strict
private configuration. It validates synthesis/triage pins, refuses a conflicting
decision provider, requires managed persistence and checks the current source and
writer before inference. Preview performs no inference or publication. Other
providers retain the existing synthesis path.

The private path uses existing transcript discovery, exclusion/self-consumption
rules, source-scoped conversation pages, versioned triage and the existing rescue
rule. Private or quarantined inputs do not reach inference. Completed legacy
synthesis is screened out before triage. New completion identities bind the source
incarnation, transcript identity/hash and configured output namespaces. Cached
negative triage results remain judgments, never synthesis completions, and do not
consume the per-phase work cap repeatedly and starve later inputs.

A phase admits at most eight new transcript work items. Each transcript is split
with the existing deterministic chunker: at most eight chunks, further limited by
configured chunk/turn caps, with at most 16,000 characters per chunk. Files are
bounded to 2 MiB using regular-file checks and bounded reads. Oversize inputs fail
explicitly before triage. Phase deadlines reach the adapter through cancellation.
The durable subscription envelope independently bounds calls and accepted turns.

Each chunk produces one native JSON Schema response, with at most four new notes
in the reflection/original namespaces. The host generates slugs, authority,
provenance, citations and request identities. It rejects invented quotations,
numbers, body blockquotes, links and model-authored paths/authority. Exact quote
checks and the existing speaker/numeric/claim verifier run before accepting the
turn. There is no content repair or agentic/provider fallback. A failed chunk means
no proposal from that transcript is published or marked complete.

The daily synthesis submission cap uses an atomic, source-incarnation-scoped
reservation in the existing transactional config store before **each chunk call**.
It includes recent legacy submissions and records uncapped calls, so enabling a
cap later cannot erase their usage. Failed, cancelled and ambiguous attempts
remain charged. A source-row lock serializes concurrent reservations; timestamps
are measured by the database. The retained 24-hour window is bounded to 10,000
entries, and a larger configured cap fails explicitly. No USD estimate authorizes
a subscription call; an explicitly zero synthesis budget still stops new work.

After all chunks pass validation, the host retains the complete plan. It includes
all generated notes and a required deterministic summary listing them. Summaries
have transcript-specific names beneath the existing summary namespace; they do
not overwrite the legacy daily aggregate. Summary-file opt-out and DB-only storage
tiers are honored while retaining the required database receipt.

Publication uses the existing prepared writes, canonical journal IDs, file
publisher, indexing debt, provenance links and receipts. A source page's identity
and revision are locked and rechecked in the publication transaction. File inputs
retain their canonical path, hash, device and inode; changed or replaced files
refuse recovery. A distinct synthesis intent makes an older preparer fail instead
of silently dropping file evidence. Old pattern intents keep their original shape.

All required receipts must commit before the transcript completion marker is
stored. A clean-zero proposal gets a retained plan and validated completion, with
no fabricated output. Pending plans recover before discovery, cooldown or another
inference call. A crash after a reflection commits resumes the saved summary,
without regenerating it. Completion of an entirely successful phase sets a
source-scoped cooldown; deferred or failed work does not. Batches remain non-atomic.

## Deterministic verification

`test/helpers/codex-synthesis-contract.ts` exercises the actual dispatcher, triage,
gateway, fake executable, native schemas, prepared writes, files, receipts and
pattern dispatcher on both PGLite and PostgreSQL. Fixtures cover:

- transcript → triage → reflection → pattern, source provenance and repeat-run completion;
- crash after a reflection commit but before the required summary, followed by no-call recovery;
- fabricated quotes/numbers/paths, private inputs and self-generated transcript exclusion;
- valid clean zero versus a low triage verdict and exhausted subscription admission;
- replaced local files, multiple chunks and explicit input/chunk bounds;
- daily allowance exhaustion, failed-call accounting, concurrent reservations and cooldown;
- summary-file opt-out, no-call preview and conflicting provider pins.

Tests use fresh isolated state, scrubbed environments and a forbidden-network
tripwire. Only registered fake executable hashes are allowed. The production Codex
qualification registry remains empty. These checks do not prove live inference or
an installed upgrade.

### Recorded checks

The commands below ran with a fresh home, discovery disabled, test environment
file loading disabled and no inherited credentials. PostgreSQL commands used a
fresh isolated PostgreSQL 16.15/pgvector 0.8.7 instance, stopped after testing.

| Command | Result |
| --- | --- |
| `bun test --timeout=60000 test/ai/codex-synthesis.serial.test.ts` | 19 passed; 100 assertions on PGLite |
| `bun test --timeout=240000 test/e2e/codex-synthesis.test.ts` | 19 passed; 100 assertions on native PostgreSQL after the final admission change |
| `bun test --timeout=240000 test/e2e/codex-synthesis.test.ts test/e2e/codex-publication.test.ts` | 35 passed before the final uncapped-call accounting adjustment; affected synthesis tests rerun above |
| `bun test --timeout=60000 test/managed-maintenance.test.ts test/cycle-synthesize-md-discovery.test.ts test/cycle-synthesize-chunker.test.ts test/cycle-synthesize-completion-before-triage-5145.test.ts test/cycle-synthesize-summary-page.test.ts test/transcript-discovery-seat.test.ts` | 57 passed |
| `GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify` | 75 passed, no failures; admin build explicitly skipped; includes typecheck, architecture, size, registry and documentation guards |
| `bun run build` | Passed |
| `git diff HEAD --check` | Passed |

These are focused checks and repository guards, not a claim that the full CI
matrix or live subscription acceptance has run.

## Remaining acceptance and limitations

- Production runtime native-action/instruction isolation still requires qualification.
- Publication supports new public notes; updating existing concepts or other arbitrary
  pages, private-visibility derivation and merging legacy daily summary aggregates are
  not part of this checkpoint.
- The filesystem has no transaction shared with unrelated external editors. File
  identity/hash rechecks do not establish atomic exclusion against such editors.
  Capture-consent filtering that changes a discovered corpus file's content currently
  causes an explicit input-identity failure before inference; automatic recovery of
  that filtered-file identity remains incomplete.
- Discovery still uses the existing corpus/page inventory walk. Per-file content,
  prompts, calls and publication are bounded; a resumable, bounded-size inventory
  cursor remains open for very large corpora.
- Content rejected before plan retention can be reproposed on a later authorized run;
  there is no promise to recover inference that never produced a retained plan.
- Operator tools for terminal plan conflicts, full crash/process-kill matrices,
  worker-artifact migration and live cancellation acceptance remain open.
- Host-owned iterative minions, other bounded roles and pin/job migration remain
  incomplete. This is not an activation-ready implementation of every GBrain service.

No additional schema migration was needed: plans use registered v261, and the
bounded admission/cooldown/completion records use existing config transactions.
Future authorized deployment must include the earlier registered migrations, a
consistent artifact across workers and all remaining qualification/activation gates.
