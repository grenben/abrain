import { CODEX_PROPOSAL_LIMITS as limits, CodexProposalError } from './codex-contract.ts';
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
      if (b.length < 12 || b.readUInt16BE(0) !== 0xffd8 || b.readUInt16BE(b.length - 2) !== 0xffd9) return fail();
      let offset = 2;
      while (offset + 4 <= b.length) {
        if (b[offset++] !== 0xff) return fail();
        while (b[offset] === 0xff) offset++;
        const marker = b[offset++];
        if (marker === 0xda || marker === 0xd9) break;
        if (offset + 2 > b.length) return fail();
        const length = b.readUInt16BE(offset);
        if (length < 2 || offset + length > b.length) return fail();
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
          if (length < 8) return fail();
          height = b.readUInt16BE(offset + 3); width = b.readUInt16BE(offset + 5); break;
        }
        offset += length;
      }
    } else if (image.mime === 'image/webp') {
      if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.readUInt32LE(4) !== b.length - 8 || b.toString('ascii', 8, 12) !== 'WEBP') return fail();
      const kind = b.toString('ascii', 12, 16);
      if (kind === 'VP8X') { width = 1 + b.readUIntLE(24, 3); height = 1 + b.readUIntLE(27, 3); }
      else if (kind === 'VP8L' && b[20] === 0x2f) {
        const bits = b.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
      } else if (kind === 'VP8 ' && b.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))) {
        width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff;
      } else return fail();
    } else return fail();
    if (!width || !height || width * height > limits.imagePixels) return fail();
    if (image.mime === 'image/png') validatePngContainer(b);
    return { mime: image.mime, bytes: b };
  });
}
