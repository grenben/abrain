# Codex runtime qualification and feature acceptance

The development candidate admits the inspected Linux 0.162.0 digest below.
Every launch still requires the protected inode, supported non-root Linux host,
trusted namespace launch chain and absence of managed Codex overrides. Invalid
or unsupported runtimes refuse before subscription admission. This source
change does not install GBrain or activate a production role or schedule.

On 25 October, the operator-staged root-owned 0555 copy passed the credential-free
boundary, abort and timeout probes at source commit `cd8d0fcba5`. All captured
requests advertised zero tools; forced native calls and typed shell/patch/search
paths were denied, ancestor instructions were ignored, and the synthetic image
reached the mock provider. Abort settled in 446 ms and timeout in 5,281 ms.

The approved `gpt-6-luna`, `gpt-6.1-sol` and `gpt-6-astra` pins each then passed
one bounded signed-in schema/image transport check, including exact quotation
and lifecycle/answer consistency. Those trials used synthetic data and an
isolated temporary login copy; the original login file was unchanged. They do
not establish acceptance of all 39 role workflows. Feature acceptance, managed
publication/recovery and explicit production activation remain separate gates.

The investigation notes below preserve earlier observations, including the
then-empty registry and user-owned executable. Post-hoc lifecycle rejection
alone remains insufficient proof that a native action was prevented.

## Staging a protected copy without activation

`scripts/codex-runtime-stage.py --source /absolute/path/to/codex` verifies the
pinned 0.162.0 Linux build without writes. With an operator's sudo and `--stage`,
it copies only those exact bytes into `/usr/local/lib/gbrain-codex/<sha256>/codex`.
It rejects source symlinks, non-regular or oversized files, changed bytes,
unprotected destination ancestors and conflicting existing destinations. It
never changes an existing file or directory's permissions. The final file is
root-owned, mode 0555, and published without overwriting an existing path.
New directories are set to 0755 on their verified descriptors even under a
restrictive umask. Existing ancestors must allow traversal, and an existing
runtime must allow read/execute access for the non-root GBrain process; inaccessible
paths are refused without changing their modes.
Re-running against the same protected copy verifies it and reports already staged.

The staging helper does not execute Codex, change authentication, select a live
model, modify GBrain configuration, install a service or admit a production
hash. Run the credential-free boundary, abort and timeout probes against the
new copy afterward, followed by the separately scoped real-model acceptance.
Its unprivileged contracts cover source admission and read-only behavior;
actual privileged staging and native host acceptance require operator evidence.

The explicitly signed-in `codex-runtime-live-synthetic-probe.ts --live` step
refuses a mutable inode, symlink, changed bytes, a digest other than the inspected
build, or an unsupported host before launching a runtime with the filtered
credential environment. It holds the checked descriptor through the launch and
records its digest and host check in a successful receipt. This preflight does
not add a production hash or replace the preceding credential-free boundary,
abort and timeout acceptance. Its refusal regressions use synthetic executables
and empty temporary homes; they do not establish live-model acceptance.

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
it. Production-hash admission now requires that the opened inode be root-owned
and neither group- nor other-writable, checked on the same descriptor after
hashing. The local 0.162.0 ELF is owned by `devadmin`, so it fails this
condition despite matching the official release digest. Installing a protected
runtime is a separate host operation; no production hash is allowlisted.

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

Production-hash admission now fails closed on Linux unless GBrain runs as a
non-root user, `/`, `/etc`, `/usr`, and `/usr/bin` are root-owned directories
without group/other write access, `/usr/bin/unshare` and `/usr/bin/true` are
root-owned executable files without group/other write access, and `/etc/codex`
is absent (including a dangling symlink). The check runs after hashing the
executable and before returning its open handle; filesystem errors also refuse
admission. A
synthetic-filesystem test covers absent and present managed layers, symlinks,
mutable parents, a mutable launcher, owner mismatch, and root-equivalent
callers. This removes the known cross-host managed-config override from the
admitted configuration on such a host. It is not mount-level isolation against
privileged host changes; the production hash registry remains empty.

## Linux process-tree containment

The production launcher binds the namespace supervisor to the GBrain process.
A trusted `/usr/bin/setpriv --pdeathsig KILL` installs the kernel parent-death
signal, then trusted `/usr/bin/dash` verifies the expected parent PID before
execing `/usr/bin/unshare`. If GBrain died before signal setup, the parent check
refuses startup; if it dies later, the kernel kills the supervisor and
`--kill-child` tears down the namespace. Host admission checks ownership and
permissions of `setpriv` and `dash` as well as `unshare` and `true`, and its
availability probe uses this same launch chain.

A native bounded heartbeat regression kills only its synthetic GBrain parent
with SIGKILL and checks that a detached namespace descendant stops. Normal
abort/timeout checks cannot establish this crash behavior. A second native
contract supplies a mismatched parent identity and requires refusal before
the executable runs. These checks do not activate a runtime hash or settle an
interrupted subscription ledger; unresolved attempts retain their existing
recovery requirements.

The local host permits unprivileged user and PID namespaces. A disposable
`unshare --user --map-root-user --pid --fork --kill-child --mount-proc` wrapper
successfully launched the exact local Codex ELF through `/proc/self/fd/3`; its
offline `--version` returned 0.162.0. A synthetic PID-namespace init then
spawned a `setsid` child that wrote a short heartbeat. SIGTERM to the wrapper
or its process group did not settle the namespace init, but SIGKILL to the
group stopped the detached heartbeat through namespace teardown. This is a
manual proof of one possible Linux containment mechanism and confirms that
the existing timed SIGKILL escalation matters. The production-hash launch path
now uses that fixed `/usr/bin/unshare` wrapper with a private user, mount, and
PID namespace, `--kill-child`, and a private `/proc` mount. The verified Codex
descriptor remains child fd 3. A focused test starts a bounded `setsid`
heartbeat descendant, aborts the wrapper, and confirms the heartbeat stops
after process-group SIGKILL and namespace teardown. Test fixtures still use
the portable process-group path; unsupported production hosts fail closed.
Before reserving a subscription attempt, production admission also launches a
fixed `/usr/bin/true` probe through the same unprivileged namespace options.
It fails closed on a spawn error, nonzero exit, signal, or two-second timeout.
The focused synthetic test covers a passing and failing probe plus a mutable
probe executable; the actual host preflight passed. This only proves namespace
availability at admission time, not that a subsequent Codex process will run.
The production hash registry remains empty while real-runtime action-path,
host-support, and wider process-crash checks remain incomplete. This local
synthetic settlement result does not establish macOS behavior.

`scripts/codex-runtime-cancel-probe.ts` now exercises the exact real CLI
against a credential-free loopback provider that accepts one request but holds
its response. It uses the production PID-namespace runner and current proposal
argv; the held request must advertise zero tools. Run both modes on a candidate
Linux host:

```sh
bun scripts/codex-runtime-cancel-probe.ts /absolute/path/to/codex gpt-6.1-sol abort
bun scripts/codex-runtime-cancel-probe.ts /absolute/path/to/codex gpt-6.1-sol timeout
```

On this host, abort returned reason `aborted`, `settled: true`, one request
with zero tools, and 432 ms elapsed. The five-second deadline returned
`timeout`, `settled: true`, one request with zero tools, and 5,262 ms elapsed.
The runner reports settlement only after its child closes and its process
group is gone. This adds real-CLI cancellation evidence to the detached-child
synthetic test; it does not prove every descendant or crash path. The local
ELF is still user-owned and not admissible as a production runtime.

## Reproducible local boundary probe

`scripts/codex-runtime-boundary-probe.ts` runs the exact configured ELF by its
open file descriptor inside the production Linux PID-namespace wrapper. It
checks the host boundary, executable hash and inode protection, obtains the
offline version, and uses disposable loopback mock providers to inspect the
tool plan and force unadvertised shell, patch, code-mode, image-read, goal,
and MCP-resource calls. It also injects a typed Responses API
`local_shell_call`, a custom `apply_patch` call, and a client-side
`tool_search_call`, separate response forms from a named function call. One
shell case replaces the deny hook with a script
that exits successfully without denying anything. It also sends a one-pixel
synthetic PNG through the configured `--image` path and checks that an
`input_image` item reaches the mock provider. It places hostile config and
`AGENTS.md` text in an ancestor directory, then
checks whether that instruction marker reached a provider request. A forced
tool call tries to leave a scratch-file marker, which the probe checks before
cleaning up. It uses an empty temporary HOME/CODEX_HOME, synthetic schema and
prompt, and no brain data or subscription credential. Run it with Bun 1.4.3
on each candidate host:

```sh
bun scripts/codex-runtime-boundary-probe.ts /absolute/path/to/codex gpt-6.1-sol
```

On the 2026-10-18 Linux development host, the exact 0.162.0 ELF above passed
the host check. Its six refusal requests advertised zero tools. When the mock
provider forced each of the seven local test calls, including one with a
non-denying hook, Codex returned `unsupported call` as a function output;
neither scratch-file marker was created. The synthetic image was present in
the mock provider request while zero tools were advertised. The hostile
ancestor instruction marker did not reach any provider request. The installed
ELF fails `runtimeFileProtected` because it is owned by `devadmin`, so the
complete probe exits 1. The JSON record preserves the digest, version,
request/tool counts, forced-call outputs, and each result. Even a future green run is only a bounded
probe: it cannot establish that every configuration, instruction, hosted action,
image path, or descendant-crash case is safe. The production hash registry
remains empty.

The typed response extensions ran against the same exact ELF and
credential-free loopback provider. `local_shell_call` produced no follow-up
function-call output or scratch marker. A custom `apply_patch` call returned
`unsupported custom tool call: apply_patch`; a client-side `tool_search_call`
returned a completed search response containing zero tools. All their
requests advertised zero tools, and no scratch marker was created. These
results cover those bounded local dispatch paths. The tagged tool plan emits
hosted web search only when its mode is enabled; GBrain sets
`web_search="disabled"`, and the mock provider saw zero advertised tools.
A provider-side hosted action could occur before a response item reaches the
client, so post-hoc lifecycle rejection cannot establish its prevention.
The full probe still exits 1 because the executable inode is user-owned.

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

## Signed-in synthetic image transport — 2026-10-18

`scripts/codex-runtime-live-synthetic-probe.ts` requires an explicit `--live`
argument and uses the existing Codex login without copying credentials. It
runs one bounded model call through the pinned descriptor and PID-namespace
runner with the current schema/argv, a made-up one-sentence source chunk, and
the same one-pixel PNG. It prints only a validity verdict, lifecycle event
types, and token usage; scratch files are removed after settlement. Run it
only when a signed-in synthetic model call is intended:

```sh
bun scripts/codex-runtime-live-synthetic-probe.ts --live /absolute/path/to/codex gpt-6.1-sol
```

On this host, the local 0.162.0 binary returned a schema-valid answer with
the exact synthetic quote. Its answer file matched the completed lifecycle
text, and the event sequence was `thread.started`, `turn.started`, one
`item.completed` agent message, and `turn.completed`. The reported usage was
1,031 input and 64 output tokens; no native-action event appeared. This proves
one signed-in schema-and-image transport case. The binary is still user-owned,
so `runtimeFileProtected` is false. The production hash registry remains empty,
and one successful model call does not establish all-path action isolation.
