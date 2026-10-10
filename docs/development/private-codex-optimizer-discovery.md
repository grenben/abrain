# Optimizer discovery producers

Say to your agent: “Optimize this skill using only the explicitly selected read
tools and page prefixes, retaining the same request for recovery.” This checkpoint
connects the [native discovery registry](private-codex-discovery.md) to optimizer
producers. It does not install or activate the development source.

## Selecting tools

The private single-skill CLI accepts repeated `--read-tool NAME` flags. Supported
values are `get_page`, `list_pages` and `search`. Supplying no flags retains the
original `get_page` scope. Explicit flags select exactly those tools; for example,
`--read-tool get_page --read-tool list_pages` permits discovery followed by a full
page read. Source, read-prefix and subscription allowance flags remain required.

`search` is the explicitly keyword-only native discovery tool. It does not call
embedding, expansion or reranking providers. Listing/search retain the same
visibility filters, bounded results and honest coverage labels described in the
registry contract. No native tools or arbitrary shell/network access are added.

The CLI adds `readRegistry: "codex-discovery-v1"` to its trusted optimizer scope
when discovery tools are selected. SDK callers must supply that registry explicitly
alongside `allowedTools` and `allowedSlugPrefixes`; a tool name alone does not
enable it. Invalid/duplicated tools refuse before admission. Benchmark drafting
does not execute read tools and rejects `--read-tool` flags. Batch/fleet and remote
optimizer producers remain incomplete.

## Identity and recovery

The scope is retained in the optimizer's original input, carried through each
validation phase, and bound to every child rollout job and accepted trajectory.
Foreground and background producers both preserve it. Queued shared optimizers
also carry it through staging and canonical publication with the existing revision,
authority, ownership and receipt checks.

The request UUID, tools, registry, prefixes and limits must remain unchanged for
replay. Changing the read scope cannot reuse a completed request as new work or
reset its allowance. Child iterations consume the same aggregate root allowance;
extra reads can use more accepted turns and attempts, so size the explicit envelope
for the intended workflow. Monetary subscription cost remains null.

Selected child workers must advertise the discovery feature for both direct
subagent jobs and optimizer jobs that create child rollouts. An older child is
rejected before launch. Existing requests without discovery retain their original
payload and schemas. No production job was rewritten or resubmitted here.

## Deterministic evidence

Tests use synthetic skills and benchmarks, fake qualified Codex executables,
fresh isolated homes/databases, disabled model discovery and forbidden network
and Anthropic construction. They exercise real CLI, queue, rollout, validation,
ledger and shared publication seams.

- `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-actions.serial.test.ts --timeout=180000 -t 'discovery-enabled|discovery CLI|older child cannot execute'`: seven passed, 36 assertions.
- `python3 /tmp/maxbrain-test-postgres-read-producers.py`: the same seven passed, 36 assertions on isolated PostgreSQL; server stopped afterward.
- Isolated `bun test test/skillopt/models-four-paths.serial.test.ts --timeout=180000`: eight passed, 31 assertions.
- Isolated `bun test test/skillopt/validate-gate-abort.test.ts test/skillopt/rollout-schema.test.ts --timeout=180000`: ten passed, 19 assertions.

Additional regression evidence:

- The isolated PGLite action command with `-t 'durable Codex optimizer rollouts|local CLI runs the real optimizer|real worker completes a permanently|actual worker publishes the bound shared'` passed 22 tests and 117 assertions. `python3 /tmp/maxbrain-test-postgres-read-regression.py` passed the same 22/117 on PostgreSQL and stopped its server.
- A final PGLite `-t 'discovery CLI invalid tools'` check verifies invalid flags reject before the callback rather than relying on a callback exception: one passed, five assertions.
- `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify`: 75 passed, zero failures, admin UI build explicitly skipped. This includes typecheck, registry, architecture and module-size checks.
- `python3 /tmp/maxbrain-stream-check.py bun run build`: compiled 3,732 modules. Documentation history and `git diff --check` passed. Full container CI, admin UI and PgBouncer were not run.

## Upgrade boundary

Schema head remains 265; this checkpoint adds no migration. An authorized upgrade
must build/install the selected revision and cut workers over to compatible builds.
Production runtime qualification and bounded live acceptance remain required before
activation. Installed GBrain, credentials, database, services and GitHub are
unchanged. These tests do not prove live subscription behavior or full process-kill
recovery. The overall private Codex implementation remains incomplete.
