# Scoped Codex discovery reads

Say to your agent: “Let the bounded Codex job discover permitted pages, then read
the evidence it finds.” This describes source development, not installed or live
subscription capability. Runtime qualification and activation remain pending.

## Explicit registry

A trusted native action job may declare `read_registry: "codex-discovery-v1"`
alongside its existing `action_protocol`. This permits `search` and `list_pages`
in its explicit `allowed_tools`, in addition to the existing `get_page` and,
for write jobs only, `put_page`. The unchanged job still binds its source,
incarnation, prefix grants, model and subscription envelope. The model cannot
choose a registry or supply source/authority fields in tool arguments.

The native union schema is generated from the selected operation definitions;
original operation validators also check the arguments. Discovery arguments are:

| Tool | Required model arguments | Behavior |
|---|---|---|
| `brain_list_pages` | `limit` 1–20, `offset` 0–1000 | Visible permitted pages in slug order. |
| `brain_search` | `query`, `limit` 1–20, `offset` 0–1000 | Explicit keyword-only search over safe current text indexes. |

The host executes the existing operation entrypoints under its deterministic
discovery scope. This mode invokes no expansion, embedding or reranking provider.
Ordinary search/query behavior is unchanged. Hybrid `query`, graph exploration,
and broader optimizer read producers still need separate integration; no job
implicitly gains these capabilities.

## Authority and bounded results

Source authorization uses the existing resolver. Prefix grants and visibility
are database predicates before ranking and pagination on both engines. Bare
prefixes mean exact slugs; `prefix/*` grants descendants. Only world-visible,
non-quarantined pages are eligible, with the existing private-lineage checks.
Operator private-page visibility overrides cannot widen this scope. Native
`get_page` also always applies the private-lineage filter.

Results retain only selected identity/content fields, with 600-character keyword
snippets and the existing 16 KB result and 96 KB history bounds. Search retains source,
slug and chunk identity. Listing reports continuation within the offset bound.
Search labels coverage `bounded_indexed_keyword_candidates`: unsafe, stale and
unindexed text is withheld, and the candidate window is bounded. An empty keyword
result does not prove that the brain contains no relevant material.

Database failures remain failed ledger entries with a redacted error, distinct
from successful empty results. Actions are persisted before reads; canonical IDs,
result retention, replay validation and worker fences use the existing ledger.
Lost result acknowledgement reuses that identity. Search does not authorize a
write: replacement still requires the original full-page revision read and its
prepared-write receipt path.

## Compatibility and verification

The optional registry is part of the immutable job payload. Absent registry keeps
the original get-page-only read set; unknown versions refuse. Older source rejects
the new job field. Selected child workers must advertise `codex-discovery-v1`
before a discovery job can launch. No persisted schema migration is needed;
schema head remains 245. Do not remove the field to force an older worker to run
the job, or reinterpret legacy queued jobs.

Synthetic fake-executable tests run actual queue/handler, operation, engine and
ledger paths with isolated homes, no credentials, disabled discovery, forbidden
network and forbidden Anthropic construction. Evidence:

- `python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-actions.serial.test.ts --timeout=180000 -t 'native scoped discovery'`: 10 passed, 32 assertions.
- `python3 /tmp/maxbrain-test-postgres-discovery.py`: final suite: 12 passed, 37 assertions on disposable PostgreSQL; server stopped afterward.
- Final PGLite boundary additions, using `-t 'keyword pagination includes|operation preserves a narrower'`: two passed, five assertions.
- Isolated SQL snapshot/listing regression: `bun test test/engine-sql-sql-text.test.ts test/list-pages-truncation.test.ts test/list-pages-keyset-cursor-op.test.ts --timeout=180000`: 36 passed, 113 assertions.
- Isolated `bun test test/brain-allowlist.test.ts --timeout=180000`: 30 passed, 100 assertions.

The full action/optimizer regression ran through
`python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp bun test test/ai/codex-actions.serial.test.ts --timeout=180000`
and `python3 /tmp/maxbrain-test-postgres-group-actions.py`. Each ran 124 cases:
123 passed and one caught an unintended change to the v1 schema's slug length.
The original schema was restored. The focused rerun
`-t 'actual worker executes sequential|operation preserves a narrower'` and
`python3 /tmp/maxbrain-test-postgres-discovery-final.py` passed both cases with
10 assertions on each engine. Together with the two final discovery additions,
126 distinct action/optimizer cases were exercised; the full long suite was not
redundantly repeated after that localized correction.

The SQL/listing/worker regression initially passed 120 of 121 cases; one SQL
text hash caught a whitespace change. Preserving the original text resolved it:
the final listing/SQL run above includes all 15 SQL snapshot cases.
`python3 /tmp/maxbrain-stream-check.py env TMPDIR=/var/tmp GBRAIN_SKIP_ADMIN_BUILD=1 bun run verify`
passed 75 gates, with zero failures and the admin UI build explicitly skipped.
Final typecheck and compilation passed (3,732 modules). Documentation history and
`git diff --check` passed. Full container CI, admin UI and PgBouncer were not run.

These tests establish source behavior, not production runtime isolation or live
subscription acceptance. Build/install, production migration, worker restart,
GitHub publication and activation were not performed.
