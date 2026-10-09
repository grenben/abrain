import { crc32, deflateSync } from 'node:zlib';

export const PNG_PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgUbL4DwACCgFmeGgpMwAAAABJRU5ErkJggg==', 'base64');
export function pngChunk(kind: string, data: Uint8Array = new Uint8Array()): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); out.write(kind, 4, 'ascii'); out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, out.length - 4)), out.length - 4);
  return out;
}
export function syntheticPng(opts: { width?: number; height?: number; depth?: number; color?: number;
  interlace?: number; pixels?: Uint8Array; compressed?: Uint8Array; before?: Buffer[]; after?: Buffer[] } = {}): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(opts.width ?? 1); header.writeUInt32BE(opts.height ?? 1, 4);
  header[8] = opts.depth ?? 8; header[9] = opts.color ?? 6; header[12] = opts.interlace ?? 0;
  return Buffer.concat([PNG_PIXEL.subarray(0, 8), pngChunk('IHDR', header), ...(opts.before ?? []),
    pngChunk('IDAT', opts.compressed ?? deflateSync(opts.pixels ?? Uint8Array.from([0, 12, 34, 56, 255]))),
    ...(opts.after ?? []), pngChunk('IEND')]);
}
