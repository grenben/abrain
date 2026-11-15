# Private Codex caller contract tests

An empty `HOME` does not make a temporary directory unmanaged. Ownership
markers are checked through its filesystem ancestors, including
`.git/gbrain-managed.json`; a managed `/tmp` also covers fixtures beneath it.
Bootstrap contracts that intentionally exercise legacy filesystem writes then
correctly refuse with `skill_bundle_required` before inference. Changing the
guard, granting publication authority, or deleting an existing ownership marker
would hide the test-environment problem.

For the private Codex caller contracts, use a fresh scratch directory outside
managed roots and preflight it with the existing guard. From a checkout with
dependencies already installed, this Linux/macOS shell recipe selects `/var/tmp`
but still checks it; that location is not assumed to be safe on every host:

```bash
(
  set -e
  gb_test_root=$(mktemp -d /var/tmp/gbrain-contracts.XXXXXX)
  mkdir "$gb_test_root/home" "$gb_test_root/tmp"
  gb_test_env() {
    env -i PATH="$PATH" HOME="$gb_test_root/home" \
      GBRAIN_HOME="$gb_test_root/home" TMPDIR="$gb_test_root/tmp" \
      GBRAIN_CI_DISABLE_TEST_ENV_FILE=1 GBRAIN_MODEL_DISCOVERY=0 "$@"
  }
  gb_test_env bun --no-env-file -e '
    import { managedFilesystemRootFor } from "./src/core/persistence/filesystem-guard.ts";
    for (const path of [process.env.HOME!, process.env.TMPDIR!]) {
      const root = managedFilesystemRootFor(path);
      if (root) throw new Error(`Choose unmanaged test scratch: ${root.root} (${root.evidence})`);
    }
  '
  gb_test_env bun --no-env-file test test/ai/codex-think.serial.test.ts
)
```

Stop on preflight refusal and choose a different scratch parent. This is
environment isolation, not an operating-system sandbox. It supplies no provider
credentials or production database URL, and the contract file uses fake native
executables and disposable PGLite data. It does not run live-model acceptance,
PostgreSQL parity, or the full repository suite. Scratch files remain available
for local diagnosis; do not export their databases or raw logs as handoff evidence.
