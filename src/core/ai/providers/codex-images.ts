import { CODEX_PROPOSAL_LIMITS as limits, CodexProposalError } from './codex-contract.ts';
import { jpegDimensions, webpDimensions } from './codex-image-containers.ts';
import { validatePngContainer } from './codex-png.ts';

export interface CodexImage { mime: 'image/png' | 'image/jpeg' | 'image/webp'; bytes: Uint8Array }

/** Accept owned bytes only, never a URL or a caller/model-authored filesystem path. */
export function validateCodexImages(images: readonly CodexImage[]): CodexImage[] {
  const fail = (): never => { throw new CodexProposalError('invalid_input'); };
  if (!Array.isArray(images) || images.length > limits.images) return fail();
  let total = 0;
  return images.map(image => {
    if (!image || !(image.bytes instanceof Uint8Array) || image.bytes.byteLength > limits.imageBytes) return fail();
    const b = Buffer.from(image.bytes); // Snapshot before any asynchronous write.
    total += b.length;
    if (total > limits.totalImageBytes) return fail();
    let width = 0, height = 0;
    if (image.mime === 'image/png') {
      if (b.length < 45 || !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        b.readUInt32BE(8) !== 13 || b.toString('ascii', 12, 16) !== 'IHDR' || b.toString('ascii', b.length - 8, b.length - 4) !== 'IEND') return fail();
      width = b.readUInt32BE(16); height = b.readUInt32BE(20);
    } else if (image.mime === 'image/jpeg') {
      ({ width, height } = jpegDimensions(b));
    } else if (image.mime === 'image/webp') {
      ({ width, height } = webpDimensions(b));
    } else return fail();
    if (!width || !height || width * height > limits.imagePixels) return fail();
    if (image.mime === 'image/png') validatePngContainer(b);
    return { mime: image.mime, bytes: b };
  });
}
