import { crc32, inflateSync } from 'node:zlib';
import { CodexProposalError } from './codex-contract.ts';

const fail = (): never => { throw new CodexProposalError('invalid_input'); };
const METADATA_LIMIT = 1_000_000;

function inflateBounded(bytes: Buffer, limit: number): Buffer {
  // node's declaration omits the info:true result shape; Bun returns buffer + engine.
  const decoded = inflateSync(bytes, { maxOutputLength: limit, info: true }) as unknown as {
    buffer: Buffer; engine: { bytesWritten: number };
  };
  if (decoded.engine.bytesWritten !== bytes.length) return fail();
  return decoded.buffer;
}

/** PNG text/color-profile metadata may itself contain compressed streams. */
function metadataSize(kind: string, bytes: Buffer): number {
  if (!['iCCP', 'zTXt', 'iTXt'].includes(kind)) return bytes.length;
  const nameEnd = bytes.indexOf(0);
  if (nameEnd < 1 || nameEnd > 79 || nameEnd + 2 > bytes.length) return fail();
  let start = nameEnd + 2, compressed = true;
  if (kind === 'iTXt') {
    const flag = bytes[nameEnd + 1];
    if (flag !== 0 && flag !== 1 || bytes[start++] !== 0) return fail();
    compressed = flag === 1;
    for (let i = 0; i < 2; i++) {
      const end = bytes.indexOf(0, start);
      if (end < start) return fail();
      start = end + 1;
    }
  } else if (bytes[nameEnd + 1] !== 0) return fail();
  try { return compressed ? inflateBounded(bytes.subarray(start), METADATA_LIMIT).length : bytes.length; }
  catch { return fail(); }
}

/** Check the complete container and bound inflation before handing it to a codec. */
export function validatePngContainer(bytes: Uint8Array): void {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20);
  const depth = b[24]!, color = b[25]!, interlace = b[28]!;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  const depths = ({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] } as Record<number, number[]>)[color];
  if (!channels || !depths?.includes(depth) || b[26] !== 0 || b[27] !== 0 || interlace > 1) return fail();
  let offset = 8, headers = 0, palette = false, ended = false, dataEnded = false, metadataBytes = 0;
  const data: Buffer[] = [];
  while (offset + 12 <= b.length) {
    const size = b.readUInt32BE(offset), end = offset + 12 + size;
    if (end > b.length) return fail();
    const kind = b.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(kind) || crc32(b.subarray(offset + 4, end - 4)) !== b.readUInt32BE(end - 4)) return fail();
    if (kind === 'IHDR') {
      if (offset !== 8 || size !== 13 || ++headers !== 1) return fail();
    } else if (kind === 'PLTE') {
      if (palette || data.length || !size || size % 3 || size > 768 || [0, 4].includes(color) || color === 3 && size / 3 > 2 ** depth) return fail();
      palette = true;
    } else if (kind === 'IDAT') {
      if (dataEnded || color === 3 && !palette) return fail();
      data.push(b.subarray(offset + 8, end - 4));
    } else if (kind === 'IEND') {
      if (size || !data.length || end !== b.length) return fail();
      ended = true;
    } else {
      // Multi-frame input needs its own frame/pixel envelope; v1 accepts still images.
      if (['acTL', 'fcTL', 'fdAT'].includes(kind) || kind[0] === kind[0]!.toUpperCase()) return fail();
      metadataBytes += metadataSize(kind, b.subarray(offset + 8, end - 4));
      if (metadataBytes > METADATA_LIMIT) return fail();
      if (data.length) dataEnded = true;
    }
    offset = end;
  }
  if (!ended || headers !== 1 || offset !== b.length) return fail();
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => {
    const w = Math.max(0, Math.ceil((width - x!) / dx!)), h = Math.max(0, Math.ceil((height - y!) / dy!));
    return { count: w ? h : 0, stride: 1 + Math.ceil(w * channels * depth / 8) };
  });
  const expected = rows.reduce((n, row) => n + row.count * row.stride, 0);
  try {
    const inflated = inflateBounded(Buffer.concat(data), expected);
    if (inflated.length !== expected) return fail();
    let pos = 0;
    for (const row of rows) for (let i = 0; i < row.count; i++, pos += row.stride) if (inflated[pos]! > 4) return fail();
  } catch { return fail(); }
}

/** WASM bytes are bundled for compiled GBrain; never resolve a decoder via network. */
export async function decodePngPixels(bytes: Uint8Array): Promise<void> {
  try {
    const [{ default: path }, codec] = await Promise.all([
      import('@jsquash/png/codec/pkg/squoosh_png_bg.wasm', { with: { type: 'file' } }),
      import('@jsquash/png/decode.js'),
    ]);
    await codec.init(await Bun.file(path).arrayBuffer());
    const decoded = await codec.default(Uint8Array.from(bytes).buffer);
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (decoded.width !== b.readUInt32BE(16) || decoded.height !== b.readUInt32BE(20) || decoded.data.length !== decoded.width * decoded.height * 4) return fail();
  } catch { return fail(); }
}
