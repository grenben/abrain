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

The official [0.162.0 release](https://github.com/openai/codex/releases/tag/rust-v0.162.0)
points to source commit `c138238`. The release's Linux musl archive was checked
against its published SHA-256 (`8daf67f6261161aa5939d8d42a516032d760406216779d7ce6040f242140ff73`),
and the extracted executable is byte-for-byte identical to the local binary
(SHA-256 above). This ties the inspected executable to the official release
artifact, although it does not qualify its tool boundary. Its tagged
[`PreToolUse` parser](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/hooks/src/events/pre_tool_use.rs)
sets `should_block` for a trusted exit-2 hook with a nonempty stderr reason,
but leaves it false for hook execution errors, other nonzero exits, an exit-2
hook without a reason, and serialization failure. Its tagged
[tool plan](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/core/src/tools/spec_plan.rs)
gates shell tools on `Feature::ShellTool` while registering `apply_patch`
separately when the model and environment support it. These source paths make
the deny hook and `features.shell_tool=false` insufficient as a complete
pre-execution boundary. The tagged
[hook discovery code](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/hooks/src/engine/discovery.rs)
classifies hooks supplied by `-c` session flags as non-managed and only installs
an enabled hook handler when its hash is trusted or hook trust is explicitly
bypassed. GBrain's current argv does neither. The configured deny hook therefore
cannot be assumed to run, even for a tool path it covers.

The [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
describe controls, but do not independently prove that this exact binary denies
all native tools and ignores all untrusted configuration/instructions. Cached
upstream main-branch source is not proof of this installed binary's behavior.

Qualification still needs credential-free adversarial tests of the effective
tool registry, hook trust, configuration inheritance, instruction loading and
process-tree settlement.
Then separately authorized isolated live checks must exercise schema/image
transport, cancellation and subscription authentication. Do not remove the
gate or silently switch to another provider to make those checks green.

Bounded-feature development and fake-executable/storage tests can continue
independently while this runtime boundary remains incomplete.

## Executable identity at launch

The admission check hashes the configured binary before reserving an attempt.
At the actual proposal call, GBrain opens and hashes it again, keeps that file
descriptor open through the child run, and launches `/proc/self/fd/3` on Linux
(`/dev/fd/3` on macOS), passing the verified descriptor as child fd 3. A rename
or symlink replacement of the configured pathname between verification and
spawn cannot select different bytes. The fake-executable transport test replaces
the pathname after opening and verifies that the original script runs. The
original inode could still be edited in place by an actor with write access to
it; runtime qualification and host file permissions must account for that
separately. This descriptor pin closes the pathname race; it does **not**
qualify the real Codex runtime or change the empty production allowlist.

## Per-call conservative model catalog

The proposal adapter now writes one private `model-catalog.json` beside its
schema and instructions and passes it through `model_catalog_json` under
`--strict-config`. Its one selected model advertises `tool_mode: direct`,
`shell_type: disabled`, no apply-patch tool, no experimental tools, and no
search capability. The selected model slug still goes to the provider; unknown
or incompatible model/catalog metadata fails rather than retrying with the
provider's tool-capable catalog. The file is mode 0600 in the per-call 0700
scratch directory. Fake-executable transport tests check its contents and
argv, while the production runtime allowlist remains empty.

The same scratch directory contains a 0600 `.gbrain-codex-root` marker. The
argv sets `project_root_markers` to that name so project-config discovery
stops at the per-call directory instead of walking into an ancestor checkout
or shared temporary directory. The exact 0.162.0 binary accepted this setting
in a signed-in synthetic proposal, and the fake transport test verifies the
marker and flag. The tagged loader still lets managed configuration override
session flags, so this marker is not a complete host-config isolation proof.

A credential-free loopback probe of the exact 0.162.0 binary accepted the
minimal catalog generated by `codex-model-catalog.ts`. The captured Responses
request contained only `get_goal`, `create_goal`, and `update_goal`; it contained
no shell, patch, search, image, MCP, or code-mode tool. A mock provider forced
`get_goal` and the next request carried the tool output `Goal tools require a
persistent thread.` Tagged source explains that `--ephemeral` has no persistent
state database and the goal extension refuses execution on such threads. The
probe did not contact a model or use brain data. It establishes this specific
tool-plan and goal-refusal behavior, not complete pre-execution isolation;
configuration inheritance and other action paths still need adversarial checks.

The exact local 0.162.0 binary was then probed against a credential-free,
401-only loopback provider with the current proposal argv plus
`features.goals=false` and `tools.experimental_request_user_input.enabled=false`.
Six captured requests advertised **zero tools**. Those two settings are now
part of the proposal argv, and the fake transport checks their presence.
A second six-request probe used a synthetic `/etc/codex/managed_config.toml`
visible only in a disposable mount namespace. It re-enabled `request_user_input`,
`get_goal`, `create_goal`, and `update_goal` despite the session settings.
The host's actual `/etc/codex` configuration files are absent, but this
demonstrates that the same binary hash on another host is insufficient for
qualification. Managed-configuration absence or isolation must be a checked
host condition before the production registry can admit the runtime.
With a second synthetic managed file selecting a tool-capable catalog and
re-enabling shell features, six more captured requests advertised
`exec_command`, `apply_patch`, and other native tools despite GBrain's session
settings. The probe provider returned 401 to every request, so no tool was
executed. This confirms the managed-config boundary is an execution-safety
condition, not just a cosmetic tool-list difference.

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

With those changes, adversarial scratch prompts asking for a harmless
scratch-file write, including one that named `apply_patch`, produced only
`thread.started`, `turn.started`, an `agent_message`, and `turn.completed`; the
parser accepted the JSON answer.
They left no marker file and produced no native-action event. The focused fake
transport contract passed 17 tests / 62 assertions after the argv change.
This demonstrates that the current binary can complete the configured JSON
transport. It does **not** prove the required pre-execution denial across all
native and hosted action paths, hook failures, inherited configuration, or
process-tree escapes, so the production allowlist stays empty.
