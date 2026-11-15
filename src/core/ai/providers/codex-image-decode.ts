import { CodexProposalError } from './codex-contract.ts';
import { jpegDimensions, webpDimensions } from './codex-image-containers.ts';
import type { CodexImage } from './codex-images.ts';
import { decodePngPixels } from './codex-png.ts';

type Decoder = { decode: (bytes: ArrayBuffer) => Promise<ImageData>; warnings: () => number };
let jpeg: Promise<Decoder> | undefined, webp: Promise<Decoder> | undefined;
async function loadDecoder(mime: 'image/jpeg' | 'image/webp'): Promise<Decoder> {
  const [codec, asset] = mime === 'image/jpeg'
    ? await Promise.all([import('@jsquash/jpeg/decode.js'), import('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm', { with: { type: 'file' } })])
    : await Promise.all([import('@jsquash/webp/decode.js'), import('@jsquash/webp/codec/dec/webp_dec.wasm', { with: { type: 'file' } })]);
  let warnings = 0;
  // JPEG 1.6.0 implements the second argument but omits it from its declaration.
  const initialize = codec.init as (module: WebAssembly.Module, options: { print: () => void; printErr: () => void }) => Promise<void>;
  await initialize(await WebAssembly.compile(await Bun.file(asset.default).arrayBuffer()), {
    // A decoder warning (including truncated JPEG recovery) is a failure, never raw output.
    print: () => { warnings++; }, printErr: () => { warnings++; },
  });
  return { decode: codec.default, warnings: () => warnings };
}

/** Decode complete bounded pixels using bundled WASM; no filesystem paths from the caller. */
export async function decodeCodexImage(image: CodexImage): Promise<void> {
  if (image.mime === 'image/png') return decodePngPixels(image.bytes);
  try {
    const bytes = Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
    const dimensions = image.mime === 'image/jpeg' ? jpegDimensions(bytes) : webpDimensions(bytes);
    const codec = await (image.mime === 'image/jpeg' ? jpeg ??= loadDecoder('image/jpeg') : webp ??= loadDecoder('image/webp'));
    const before = codec.warnings();
    const decoded = await codec.decode(Uint8Array.from(bytes).buffer);
    if (codec.warnings() !== before || !decoded || decoded.width !== dimensions.width || decoded.height !== dimensions.height ||
      decoded.data.length !== dimensions.width * dimensions.height * 4) throw new Error('invalid_pixels');
  } catch { throw new CodexProposalError('invalid_input'); }
}
