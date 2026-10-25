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
accepted turns with a two-hour deadline; each selected role defaults to two
attempts and turns. The explicit calibration repair case below permits four.
The batch supports up to eight distinct roles. A failure
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
managed publication, the expected storage mode and replay without additional model
calls or duplicate writes. Atoms, synthesis and enrichment require matching files;
new concepts preserve their documented database-only storage with committed
receipts, citations and five provenance links. Triage caches the same synthetic
file subsequently used by synthesis; concept and enrichment cases have separate
controlled sources. A concept assertion may resume verification of an already
accepted publication without another model call; the original failure is retained.
These are phase acceptance cases, not a single complete production cycle.
Select both dream roles when creating a synthesis batch; synthesis requires the
triage role to remain enabled even when its verdict is already cached.

```sh
python3 scripts/private-codex-live-acceptance.py --live --auth-file /path/to/codex/auth.json --models /path/to/approved-tier-models.json --roles atoms,dream-triage,dream-synthesis,concepts,enrichment
```

The core batch adds `take-proposals`, `take-calibration`, `contextual-synopsis`,
`edge-contradictions` and `fence-repair`. Take and relationship proposals must
remain advisory, calibration retains source/holder-scoped host metrics and its
real voice judgment, and fence repair applies a saved preview while preserving
the claim, confidence, visibility and matching canonical file. Replays check
that proposals, profiles and writes are not duplicated.

The edge case runs normal typed-link extraction first: the page-write effect
alone adds plain mentions, which are not competing state relationships.
Explicit `works at` statements seed two relationships in each of the `all`
and `world` visibility projections. The phase judges `all`; the case checks
that both projections remain unchanged after its advisory proposal.

Calibration needs `calibration-voice-judge` enabled as a supporting role. The
explicit `--support-roles` option records that dependency in the retained policy
without running a separate standalone case. Supporting calls consume the parent
case's original allowance; one generation and voice review consume two turns.
For a new batch only, `--calibration-repair` explicitly reserves four attempts
and turns for that case, covering the existing one-rewrite/second-review path.
This option cannot extend a resumed allowance. A two-call case that exhausts
its grant remains exhausted and is not silently upgraded. The total selected
and supporting roles cannot exceed eight. Resumption
retains the original supporting roles and must omit `--support-roles`.

The contextual case exercises the actual synopsis transformer with its own role
identity. This standalone transformer has no cache unless its caller supplies
a cache scope; this case does not claim cache replay. It also calls the real reindex service to verify
that missing embedding authorization refuses before inference and leaves the
vectors unchanged. It does not authorize paid embeddings or qualify full
contextual reindexing.

```sh
python3 scripts/private-codex-live-acceptance.py --live --auth-file /path/to/codex/auth.json --models /path/to/approved-tier-models.json --roles take-proposals,take-calibration,contextual-synopsis,edge-contradictions,fence-repair --support-roles calibration-voice-judge --calibration-repair
```

`results.json` records each pass or failure, model, elapsed time, ledger usage,
commit/tree, dirty state, tracked-diff hash and harness hash. Per-run receipts
record the terminal exit status and credential cleanup checks. A passed semantic
assertion and an accepted model turn are both required. The harness blocks HTTP
from its own process; only the contained subscription subprocess may call its
provider. No fake executable or injected model output is involved.

The automation cases cover `auto-think`, `iterative-minions`, `brainstorm`,
`brainstorm-judge`, `skillopt-judge`, `skillopt-optimizer` and `skillopt-bootstrap`.
Automatic think retains a source-grounded draft; its fixture disables automatic
publication. The action case uses the real queue, claim, handler and completion
paths for one scoped page read and its grounded final answer. Brainstorm uses
normal retrieval, one cross and the separate judge, retaining an unpublished
result. A separate judge case checks exact IDs, axis bounds and the host verdict.
Skill scoring and reflection use explicitly synthetic completed trajectories;
they do not claim a full optimizer campaign or model-generated rollout quality.
Bootstrap writes an owner-only draft whose review marker remains enforced.
Stored outputs check no-call replay and no duplicate state.

New batches declare the fixed `codex-subscription` job account lane before
admission; older manifests retain their original lane. Queued action children
consume their existing case's two-call cap and the original 16-call parent cap.
Attempt receipts include descendant ledgers once. No new child grants increase
the aggregate budget. The action case qualifies inline queue/handler behavior,
not a background daemon, native provider tools, write actions or delegation.
Brainstorm requires its judge role in the retained batch.

```sh
python3 scripts/private-codex-live-acceptance.py --live --auth-file /path/to/codex/auth.json --models /path/to/approved-tier-models.json --roles auto-think,iterative-minions,brainstorm,brainstorm-judge,skillopt-judge,skillopt-optimizer,skillopt-bootstrap
```

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

The content batch passed atom discovery/extraction, cached triage feeding
synthesis, concept publication and enrichment. Atoms published two verified
quotations, synthesis published a reflection plus its required summary, concepts
retained five source links, and enrichment cited its supporting fact. Publication
receipts committed; replay required no additional model calls or writes.

Two failed acceptance rows are retained as harness corrections. The initial
concept assertion incorrectly required a file for a newly generated concept;
verification resumed against the same accepted database-only publication. The
enrichment fixture initially lacked the input file corresponding to its database
stub, so the normal missing-file guard refused publication after inference.
An isolated correction exclusively created that missing synthetic input after
checking the stub and the absence of admitted writes. The retry reused the
cached model result and published successfully. The harness now seeds the file
before claiming ownership and checks its agreement before inference. No runtime
publication guard was weakened, no allowance was reset, and these retries made
no additional provider calls. All five content roles used one accepted turn each.

The core batch passed grounded take proposals, calibration with its real voice
gate, contextual synopsis, advisory edge contradictions and preview-bound fence
repair. The calibration repair case used four calls: generation, rejected voice
review, rewritten generation and accepted review. Its source/holder metrics
retained four correct forecasts out of five, and replay added no profile or
model call. The profile remains unpublished. Fence repair preserved the claim,
confidence and private visibility, with matching file/database content and no
duplicate writes. Take and edge proposals remained advisory.

Four failed acceptance rows remain. The original two-call calibration allowance
could not cover its existing repair path and stays exhausted; a separately
declared four-call case passed. The original contextual assertion incorrectly
expected standalone caching and consumed two calls. A separate corrected
one-call case passed and verified that reindexing refuses unauthorized embedding
spend before inference; full contextual reindexing is not qualified. Edge setup
failed twice before inference because plain mentions and unrecognized wording
did not form typed relationships. Its retained synthetic fixture was corrected
through the normal revision-checked write and extraction paths; its first model
call passed. Two preparation writes without a revision were refused, and a later
preparation assertion was corrected to distinguish visibility projections. Those
preparation outcomes remain in the sanitized receipt. No runtime guard or old
allowance was weakened. Fresh execution of the corrected edge seeding branch
is not separately claimed.

Together these batches have passing live evidence for twenty-four roles. Results
are reconciled across source checkpoints, including five earlier failed role
calls (one OCR and four polish), two content-harness failures and the four core
acceptance failures, not a full green run on one commit. Fifteen automation and
evaluation roles still need live acceptance. Passing phase cases do not replace
complete-cycle, interruption/recovery, fresh backup/rollback or production cutover
gates. Small synthetic cases also do not establish sustained model availability,
statistical quality or native Mac runtime compatibility.

For review, export only source, sanitized result metadata and checksums. Never
archive the whole fixture directory: it contains a synthetic database, local
provider artifacts and temporary runtime state. Do not include authentication
files or raw provider/session logs in handoffs.
