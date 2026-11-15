# Private Codex pin migration
> **Historical checkpoint:** This document describes the private 0.60.317.0 source lineage, not validation or activation of the upstream synchronization. Private migrations v261–v290 are being ported as v315–v344; integration remains in progress.

Source implementation only. These commands do not install a build or activate
private mode. The installed GBrain retains its original capabilities.

## Preview and apply

`private-codex pins` operates on one explicitly selected configuration plane.
Use the verified source build and a controlled cutover with other configuration
writers stopped. The database plane requires the existing selected brain to have
registered migration **v266**; these commands never apply startup migrations.
Correct conflicting file/environment pins before connecting a database with strict
mode already enabled, since the existing connection bootstrap validates routing.

```sh
gbrain private-codex pins preview --plane file --model codex-cli:MODEL --json
gbrain private-codex pins apply --plane file --model codex-cli:MODEL --expect HASH --yes --json
gbrain private-codex pins preview --plane database --model codex-cli:MODEL --json
gbrain private-codex pins apply --plane database --model codex-cli:MODEL --expect HASH --yes --json
```

Replace `MODEL` with the intended configured model and `HASH` with that plane's
reviewed `plan_hash`. A changed plan refuses. Unset slots stay unset, allowing
strict mode's configured default to select Codex. Existing conflicting registered
generative pins become the selected model; conflicting fallback chains become a
single Codex entry. The tool preserves credentials, private activation, database
targets, embedding/reranker providers and monetary limits.

Preview lists only registered model slots and environment-variable presence.
It never prints environment values or copies full configuration into receipts.
Malformed pin values refuse without echoing them. File preview opens no database;
database preview uses an explicit existing-brain connection. Neither dispatches
inference or model discovery. Ordinary configuration reads never migrate pins.

For a four-tier policy, replace `--model` with `--models` on both preview and
apply, using the same JSON object:

```sh
gbrain private-codex pins preview --plane database --models '{"utility":"codex-cli:UTILITY","reasoning":"codex-cli:REASONING","deep":"codex-cli:DEEP","subagent":"codex-cli:SUBAGENT"}' --json
```

Each registered role pin maps to its role's tier; existing tier pins map directly.
The global `models.default` is removed because it cannot express distinct tiers.
This deletion appears in the reviewed plan and rollback restores its original
value. Unset slots stay unset. Tiered plans use receipt version 2; scalar version 1
receipts remain readable. Neither form changes `private_codex.enabled_roles`.
The four model names above are placeholders, not qualified runtime selections.

## Receipts, recovery and rollback

```sh
gbrain private-codex pins receipts --plane file --json
gbrain private-codex pins rollback --plane file --id UUID --expect HASH --yes --json
gbrain private-codex pins receipts --plane database --json
gbrain private-codex pins rollback --plane database --id UUID --expect HASH --yes --json
```

Use the receipt's ID and original plan hash. Database pin changes and receipts
commit in one transaction with a configuration-table lock. Rollback refuses when
a changed pin has subsequently drifted. Unrelated database settings can change
without preventing rollback.

File receipts live beside configuration under `private-codex-pins`, with private
permissions, a native migration-writer lock and bounded history. The journal is
durable before configuration replacement; directory durability is confirmed before
settlement. After interruption, repeat the same apply/rollback command. Recovery
recognizes the retained before/after file hashes, completes that plan, or refuses
on unrelated bytes. Rollback preserves configuration values, but JSON formatting
can change. File drift checks cover the whole configuration file.

File migration is not transactional with database migration. Its lock coordinates
migration writers, not every existing configuration writer or external editor.
The final hash check detects observed drift, but cannot provide a universal
compare-and-swap against a writer that ignores the lock. Keep other writers
stopped through preview, apply and verification. A pending ambiguous receipt
blocks new migrations; do not delete it to force another plan through.

## Deterministic evidence and limits

Synthetic fixtures exercise the real CLI, native file lock, atomic replacement,
PGLite/PostgreSQL transactions and receipts. Network is forbidden and fixtures
contain no real credentials. Tests cover no-write preview, apply/rollback drift,
concurrent application, receipt failures, crashes before/after file replacement,
retained-plan recovery, and argument refusal before database connection.

```sh
bun test --timeout=60000 test/ai/codex-pins.serial.test.ts test/codex-pin-database.test.ts
bun test --timeout=240000 test/e2e/codex-pin-database.test.ts
```

Native PostgreSQL uses separately authorized isolated infrastructure. File fixtures
must run outside managed brain trees so the normal filesystem guard remains active.
Historical scalar-checkpoint evidence: CLI regression discrimination reverted only `src/cli/commands/private-codex.ts`:
eight tests pass and two fail; restored integration passes all ten.

At that scalar checkpoint, the combined file/PGLite suite passed 16 tests (83 assertions); the native
PostgreSQL contract passes six (32 assertions). Migration, schema generation and
PGLite catalog checks pass 220 tests. PostgreSQL catalogs and column parity pass
eight tests; the optional PgBouncer case is unavailable. `bun run verify` passes
75 checks, including typecheck, architecture, size and documentation guards;
the admin UI build is explicitly skipped. `bun run build` compiles 3,607 modules.
The shadowed-pin regression also discriminates: reverting `private-policy.ts`
produces 12 passes and one failure. Full CI and live subscription acceptance are
not established by these focused checks.

The inventory is explicitly incomplete: other feature overrides, worker launchers,
environment changes, queued-job drain/park/resubmit and runtime qualification still
require acceptance. The no-call audit cannot report complete coverage. Pin migration
does not prove live subscription behavior or authorize deployment/activation.
