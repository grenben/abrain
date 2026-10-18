# Codex runtime qualification remains incomplete

The production `QUALIFIED_SHA256` registry in `codex-qualification.ts` is empty.
Only test fixtures register synthetic executable hashes. GBrain refuses real
Codex dispatch before reserving a subscription attempt until the runtime's
pre-execution isolation is proven. Post-hoc rejection of native-action events
does not prove those actions were prevented.

## Read-only local evidence

The inspected local standalone package identifies version **0.162.0**, target
`x86_64-unknown-linux-musl`, variant `codex`, layout version 1. Its binary SHA-256:

```
50ed828f357c655a3c82054d346cab8434f24901f14ec19b8267571bdd008b38
```

`codex exec --help`, run with empty temporary HOME/CODEX_HOME and a filtered
environment, lists `--strict-config`, `--ephemeral`, `--ignore-user-config`,
`--ignore-rules`, `--output-schema` and `--image`. This establishes advertised
interfaces, not effective tool/config/instruction isolation. The version and
digest are evidence only; they are deliberately not added to the allowlist.
No inference or credential-file access was used for this inspection.

## Precise unresolved boundary

The official [hooks documentation](https://learn.chatgpt.com/docs/hooks) says
non-managed hooks require trust, multiple configuration layers can contribute
matching hooks, and tool hooks do not cover every execution path. Hosted web
search is one documented exclusion; malformed unsupported permission fields
are not a denial guarantee. Accordingly, the configured `PreToolUse` deny hook
alone cannot establish the required boundary.

The [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
describe controls, but do not independently prove that this exact binary denies
all native tools and ignores all untrusted configuration/instructions. Cached
upstream main-branch source is not proof of this installed binary's behavior.

Qualification still needs corresponding pinned runtime source/build evidence
and credential-free adversarial tests of the effective tool registry, hook trust,
configuration inheritance, instruction loading and process-tree settlement.
Then separately authorized isolated live checks must exercise schema/image
transport, cancellation and subscription authentication. Do not remove the
gate or silently switch to another provider to make those checks green.

Bounded-feature development and fake-executable/storage tests can continue
independently while this runtime boundary remains incomplete.

## Disposable live transport probe — 2026-10-18

The signed-in local 0.162.0 binary was invoked from a private scratch directory
with GBrain's filtered environment, schema file, read-only sandbox, deny hook,
and ephemeral JSONL arguments. This was a standalone transport probe; the
production qualification allowlist remained empty and no brain data was used.

The first invocation returned a valid JSON answer but emitted three
`item.completed` error records before `turn.started`. They identified the
deprecated `features.codex_hooks` and `features.memory_tool` keys and an
unstable-feature warning for `skip_host_skill_discovery`. GBrain's strict
lifecycle parser correctly rejected that stream as `malformed_lifecycle`.
The argv now uses `features.hooks=true`, omits the redundant deprecated
`memory_tool` key, and suppresses the unstable-feature notice while retaining
`skip_host_skill_discovery=true`.

With those changes, an adversarial scratch prompt asking for a harmless
scratch-file write produced only `thread.started`, `turn.started`, an
`agent_message`, and `turn.completed`; the parser accepted the JSON answer.
It left no marker file and produced no native-action event. The focused fake
transport contract passed 17 tests / 62 assertions after the argv change.
This demonstrates that the current binary can complete the configured JSON
transport. It does **not** prove the required pre-execution denial across all
native and hosted action paths, hook failures, inherited configuration, or
process-tree escapes, so the production allowlist stays empty.
