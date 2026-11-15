import { CodexProposalError, CODEX_PROPOSAL_LIMITS as limits } from './codex-contract.ts';

const fail = (): never => { throw new CodexProposalError('invalid_input'); };
export interface ImageDimensions { width: number; height: number }
function bounded(width: number, height: number): ImageDimensions {
  if (!width || !height || width * height > limits.imagePixels) return fail();
  return { width, height };
}

/** Walk all segments/scans: a later frame cannot replace the size we bounded. */
export function jpegDimensions(b: Buffer): ImageDimensions {
  if (b.length < 12 || b.readUInt16BE(0) !== 0xffd8) return fail();
  let offset = 2, scans = 0, entropy = 0;
  let frame: ImageDimensions | undefined;
  while (offset < b.length) {
    if (b[offset++] !== 0xff) return fail();
    while (b[offset] === 0xff) offset++;
    const marker = b[offset++];
    if (marker === 0xd9) {
      if (!frame || !scans || !entropy || offset !== b.length) return fail();
      return frame;
    }
    if (marker === undefined || !([0xc0, 0xc1, 0xc2, 0xc4, 0xdb, 0xdd, 0xda, 0xfe].includes(marker) || marker >= 0xe0 && marker <= 0xef)) return fail();
    if (offset + 2 > b.length) return fail();
    const size = b.readUInt16BE(offset), end = offset + size;
    if (size < 2 || end > b.length) return fail();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || size < 8 || size !== 8 + 3 * b[offset + 7]!) return fail();
      frame = bounded(b.readUInt16BE(offset + 5), b.readUInt16BE(offset + 3));
    }
    offset = end;
    if (marker !== 0xda) continue;
    if (!frame || size < 6) return fail();
    scans++;
    while (offset < b.length) {
      if (b[offset] !== 0xff) { entropy++; offset++; continue; }
      let next = offset + 1;
      while (b[next] === 0xff) next++;
      if (b[next] === 0 || b[next]! >= 0xd0 && b[next]! <= 0xd7) { entropy++; offset = next + 1; continue; }
      break;
    }
  }
  return fail();
}

/** Bound both the extended canvas and the actual encoded frame before decoding. */
export function webpDimensions(b: Buffer): ImageDimensions {
  if (b.length < 26 || b.toString('latin1', 0, 4) !== 'RIFF' || b.readUInt32LE(4) !== b.length - 8 || b.toString('latin1', 8, 12) !== 'WEBP') return fail();
  let offset = 12, canvas: ImageDimensions | undefined, frame: ImageDimensions | undefined;
  while (offset + 8 <= b.length) {
    const kind = b.toString('latin1', offset, offset + 4), size = b.readUInt32LE(offset + 4), start = offset + 8;
    const end = start + size, padded = end + (size & 1);
    if (padded > b.length || size & 1 && b[end] !== 0) return fail();
    if (kind === 'ANIM' || kind === 'ANMF') return fail();
    if (kind === 'VP8X') {
      if (offset !== 12 || canvas || size !== 10 || b[start]! & 0xc3 || b[start + 1] || b[start + 2] || b[start + 3]) return fail();
      canvas = bounded(1 + b.readUIntLE(start + 4, 3), 1 + b.readUIntLE(start + 7, 3));
    } else if (kind === 'VP8 ' || kind === 'VP8L') {
      if (frame) return fail();
      if (kind === 'VP8 ') {
        if (size < 10 || b[start]! & 1 || !b.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) return fail();
        frame = bounded(b.readUInt16LE(start + 6) & 0x3fff, b.readUInt16LE(start + 8) & 0x3fff);
      } else {
        if (size < 5 || b[start] !== 0x2f) return fail();
        const bits = b.readUInt32LE(start + 1);
        if (bits >>> 29) return fail();
        frame = bounded((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
    }
    offset = padded;
  }
  if (!frame || offset !== b.length || canvas && (frame.width !== canvas.width || frame.height !== canvas.height)) return fail();
  return frame;
}
