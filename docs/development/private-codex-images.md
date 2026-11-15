# Private Codex image validation
> **Historical checkpoint:** This document describes the private 0.60.317.0 source lineage, not validation or activation of the upstream synchronization. Private migrations v261–v290 are being ported as v315–v344; integration remains in progress.

This source checkpoint validates PNG, JPEG and still WebP preparation without enabling the installed
brain. The runtime qualification registry remains empty.

## Runtime gate

On 2026-10-10 the installed launcher still resolved to the standalone Codex 0.162.0
release path. No inference, authentication refresh or credential-file access was
performed. Current official [hook documentation](https://learn.chatgpt.com/docs/hooks)
says hosted tools bypass local tool hooks, and unsupported pre-tool hook outputs
can leave execution proceeding. Those controls do not establish blanket denial
before execution. The [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
also scopes `--ignore-user-config` to the user config file, not every inherited
configuration/instruction plane. This inspection does not qualify the binary.

## Implemented validation

`prepareCodexInput` snapshots images, schema, environment and request fields before
its first asynchronous operation. Both direct proposals and gateway admission await
pixel validation. Invalid input reaches neither reservation nor executable launch.

For PNG, `codex-png.ts` checks all chunk lengths/checksums and ordering, rejects
duplicate headers, missing data, trailing bytes, unknown critical chunks and
animation, validates color/depth combinations, and calculates the exact filtered
scanline size including all seven Adam7 passes. Inflation has that output bound;
short/excess output, invalid filters and trailing compressed data fail explicitly.
Ancillary metadata has a combined one-million-byte bound after decompression.

The already-locked `@jsquash/png` decoder then decodes the complete pixel stream.
Dimensions and RGBA length must match the bounded header. Its WASM is bundled in
compiled GBrain and loaded locally; no decoder network download is used. Validated
input bytes are preserved for the native `--image` file. Existing per-image, total
byte, pixel and count limits still apply. Cancellation is checked around decoding.

JPEG validation walks every marker and entropy scan, rejects duplicate or
unsupported frames, enforces the pixel bound before decoding, and requires an
exact terminal EOI. Progressive JPEG is supported. WebP validates the full RIFF
chunk layout, padding, canvas/frame agreement and bounded VP8/VP8L dimensions;
animation and unsupported extended flags fail explicitly.

With authorization, the isolated checkout added pinned `@jsquash/jpeg` 1.6.0 and
`@jsquash/webp` 1.5.0. Their bundled WASM decodes pixels locally. Decoder warnings,
including JPEG recovery, fail validation without printing raw codec diagnostics.
Decoded dimensions and RGBA length must match the validated container. The
compiled smoke guard now exercises all three image formats with network denied.
Native isolation and real CLI image handling remain unverified.

## Deterministic evidence

The adapter/gateway/triage/job/image regression run passed 81 tests. The earlier
PNG-only run passed 28 tests after adding metadata and all-pass Adam7 fixtures.
Counts overlap. The production gateway test proves malformed pixel data leaves
attempt counts and executable captures unchanged, then permits a valid image under
the same one-attempt envelope. The compiled decoder smoke guard exercises production
preparation with a network tripwire and rejects malformed pixels.

```sh
bun test --timeout=60000 test/ai/codex-images.test.ts test/ai/codex-proposal.serial.test.ts test/ai/codex-gateway.serial.test.ts test/ai/codex-triage.serial.test.ts test/ai/codex-jobs.serial.test.ts
bun test test/ai/codex-images.test.ts
bun run check:image-decoders
```

An existing synthetic PNG used by two tests had a bad IDAT checksum; it was replaced
with a generated valid pixel fixture. Tests use fresh temporary homes, discovery
disabled, fake Codex executables and isolated PGLite state. That PNG-only checkpoint changed no database schema or SQL. The current bounded-role
follow-up includes separate accounting migration and native parity checks.

`bun run verify` passed 75 checks with zero failures and one explicit admin-build
skip (its script installs dependencies outside the locked setup). Typecheck,
architecture/size guards, generated-file and documentation checks passed.
`bun run build` compiled the CLI successfully. Git whitespace checks passed.
No size ceilings were raised and no installed artifacts/configuration were changed.

The JPEG/WebP follow-up passes 43 image tests, including valid progressive JPEG,
lossy/lossless WebP, truncated streams, oversized/duplicate frames, mismatched
canvas/frame dimensions and trailing data. Gateway tests capture native image
files and arguments for all supported formats. The expanded feature/gateway/image
and synopsis regression command passed 98 tests. See the bounded-role follow-up
for current database verification; these counts overlap.
