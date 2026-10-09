// Compiled-binary smoke test for HEIC/AVIF decoders.
//
// Verifies that bun --compile produces a binary where heic-decode and
// @jsquash/avif both load their WASM and successfully decode a fixture
// to a non-empty pixel buffer.
//
// Output: a single JSON line on stdout.
//   {"heic":{"ok":true,"width":N,"height":N,"bytes":N},"avif":{"ok":true,...}}
//
// Exit code 0 on full success, 1 on any decode failure.
//
// Used by scripts/check-image-decoders-embedded.sh as a CI guard.
//
// The fixture paths are resolved at compile time via import attributes so
// bun --compile embeds the bytes into the binary itself. Otherwise a compiled
// binary running away from the repo would fail to find the fixtures.

import heicFixture from '../test/fixtures/images/tiny.heic' with { type: 'file' };
import avifFixture from '../test/fixtures/images/tiny.avif' with { type: 'file' };
// @jsquash/avif loads its WASM relative to its own JS file, which fails inside
// a bun --compile VFS. Pre-compile the module via `init()` with the embedded
// bytes — `with { type: 'file' }` works correctly inside compiled binaries.
import avifWasmPath from '@jsquash/avif/codec/dec/avif_dec.wasm' with { type: 'file' };
import { readFileSync } from 'node:fs';

import heicDecode from 'heic-decode';
import avifDecode, { init as initAvif } from '@jsquash/avif/decode.js';
import { prepareCodexInput } from '../src/core/ai/providers/codex-input.ts';
import { PNG_PIXEL, syntheticPng } from '../test/helpers/codex-image-fixtures.ts';

interface DecodeResult {
  ok: boolean;
  width?: number;
  height?: number;
  bytes?: number;
  error?: string;
}

async function decodeHeic(): Promise<DecodeResult> {
  try {
    const buf = readFileSync(heicFixture);
    const result = await heicDecode({ buffer: buf });
    if (!result || !result.data || result.data.byteLength === 0) {
      return { ok: false, error: 'heic-decode returned empty pixel buffer' };
    }
    return {
      ok: true,
      width: result.width,
      height: result.height,
      bytes: result.data.byteLength,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function decodeAvif(): Promise<DecodeResult> {
  try {
    const wasmBytes = readFileSync(avifWasmPath);
    const wasmModule = await WebAssembly.compile(wasmBytes);
    await initAvif(wasmModule);
    const buf = readFileSync(avifFixture);
    const result = await avifDecode(new Uint8Array(buf).buffer);
    if (!result || !result.data || result.data.byteLength === 0) {
      return { ok: false, error: 'avif decode returned empty pixel buffer' };
    }
    return {
      ok: true,
      width: result.width,
      height: result.height,
      bytes: result.data.byteLength,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const heic = await decodeHeic();
const avif = await decodeAvif();
// Exercise production PNG preparation, including the embedded WASM, without
// calling a model or allowing a decoder to fetch a remote asset.
globalThis.fetch = (() => { throw new Error('decoder network forbidden'); }) as unknown as typeof fetch;
const pngInput = (bytes: Uint8Array) => ({ bin: '/synthetic/never-executed', model: 'fixture', prompt: 'fixture',
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  images: [{ mime: 'image/png' as const, bytes }], env: {} });
let codexPng = false;
try {
  await prepareCodexInput(pngInput(PNG_PIXEL));
  try { await prepareCodexInput(pngInput(syntheticPng({ pixels: Uint8Array.of(0) }))); }
  catch (error) { codexPng = (error as {reason?: string}).reason === 'invalid_input'; }
} catch { /* Report a sanitized failure, never raw codec diagnostics. */ }
const allOk = heic.ok && avif.ok && codexPng;
console.log(JSON.stringify({ heic, avif, codex_png: { ok: codexPng }, ok: allOk }));
process.exit(allOk ? 0 : 1);
