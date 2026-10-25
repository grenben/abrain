# Bounded real-model acceptance

This operator-run harness uses the admitted protected Linux executable, an
explicitly supplied subscription login, four approved model pins and synthetic
data. It does not install or activate GBrain. Native macOS is not qualified by
these results. This is not part of the automatic test suite.

Run from a clean source checkout after reviewing the chosen roles and pins:

```sh
python3 scripts/private-codex-live-acceptance.py --live --auth-file /path/to/codex/auth.json --models /path/to/approved-tier-models.json --roles chat,query-expansion,ocr,facts,classifiers,page-summary,think
```

The models file must contain exactly the keys `utility`, `reasoning`, `deep` and
`subagent`, each with an explicit `codex-cli:` model ID. No automatic model
discovery or API fallback is used. The host must satisfy the protected runtime
ownership and namespace checks. The launcher requires a currently valid ChatGPT
login, makes a private temporary copy and removes that copy in its cleanup path;
it verifies that the original login bytes remain unchanged.

Each batch creates a private `/var/tmp/gbrain-live-roles-*` directory and prints
its path before starting. The parent allowance is sixteen attempts and sixteen
accepted turns with a two-hour deadline; each selected role gets at most two
attempts and turns. The batch supports up to eight distinct roles. A failure
stops the batch and returns a nonzero exit status after resource cleanup.

Resume with the printed root and the same role selection. A failed role requires
`--retry`; neither resumption nor retry resets counters or extends the deadline.
Already passing roles are retained, not rerun. Their individual source hashes
remain historical evidence; a resumed batch is not automatically an exact-commit
green run. Do not create a fresh batch to evade an exhausted allowance.

```sh
python3 scripts/private-codex-live-acceptance.py --live --auth-file /path/to/codex/auth.json --root /var/tmp/gbrain-live-roles-EXAMPLE --roles chat,query-expansion,ocr,facts,classifiers,page-summary,think --retry
```

Additional implemented cases are `patterns`, `parser-fallback`, `parser-polish`,
`calibration-voice-judge`, `take-grading`, `drift` and `contradiction-probe`. They
call actual feature functions. The patterns case enables the canonical writer
only in its disposable synthetic database and requires committed publication
receipts, generated files and source provenance edges. Judge-only cases do not
qualify the corresponding background phase or its publication/recovery path.
Contextual embeddings and other API auxiliaries are outside this harness.

The content batch adds `atoms`, `dream-triage`, `dream-synthesis`, `concepts` and
`enrichment`. It uses normal discovery and real phase entrypoints, then checks
managed publication, file/database agreement and replay without additional model
calls or duplicate writes. Triage caches the same synthetic file subsequently
used by synthesis; concept and enrichment cases have separate controlled sources.
These are phase acceptance cases, not a single complete production cycle.
Select both dream roles when creating a synthesis batch; synthesis requires the
triage role to remain enabled even when its verdict is already cached.

```sh
python3 scripts/private-codex-live-acceptance.py --live --auth-file /path/to/codex/auth.json --models /path/to/approved-tier-models.json --roles atoms,dream-triage,dream-synthesis,concepts,enrichment
```

`results.json` records each pass or failure, model, elapsed time, ledger usage,
commit/tree, dirty state, tracked-diff hash and harness hash. Per-run receipts
record the terminal exit status and credential cleanup checks. A passed semantic
assertion and an accepted model turn are both required. The harness blocks HTTP
from its own process; only the contained subscription subprocess may call its
provider. No fake executable or injected model output is involved.

The first seven-role batch retained one utility-model OCR failure and a passing
reasoning-model retry on the same image. Its early prototype recorded HEAD and
harness hash, but did not record the dirty source delta. That batch must be
reported with its retained OCR routing patch and an explicit provenance caveat,
not as a completely green run on a clean commit. The first prototype also
returned zero after the semantic failure because database cleanup reset the
exit status; the failure row is authoritative. The committed harness publishes
its final verdict after cleanup.

The next seven-role batch passed parsing, voice judgment, take grading, drift,
contradiction detection and managed pattern publication. Parser polishing failed
local output validation twice on the utility model. A separate bounded comparison
also failed twice on the reasoning model. Content-free preservation diagnostics
identified changed content; read-only observation of the last synthetic response
showed that the model copied the enclosing JSON record into `prose` instead of
formatting its `text` field. The caller now explicitly identifies that input field.
The corrected caller passed a separate bounded verification on the original
utility model, preserving canonical evidence and quoted spacing. Each earlier
grant and failure remains intact; no allowance was reset. The original generic
errors do not retrospectively prove that all four failures had the same cause.

Together these batches exercise fourteen roles. Their passing results are
reconciled across source checkpoints, including five retained failed attempts
(one OCR and four polish), not a full green run on one commit. The remaining
twenty-five roles still need live acceptance. Even the passing caller smokes do
not replace managed workflow, rollback, interruption or production cutover gates.

For review, export only source, sanitized result metadata and checksums. Never
archive the whole fixture directory: it contains a synthetic database, local
provider artifacts and temporary runtime state. Do not include authentication
files or raw provider/session logs in handoffs.
