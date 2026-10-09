import { test, expect } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { prepareCodexInput } from '../../src/core/ai/providers/codex-input.ts';
import { CODEX_PROPOSAL_LIMITS } from '../../src/core/ai/providers/codex-contract.ts';
import { PNG_PIXEL, pngChunk, syntheticPng } from '../helpers/codex-image-fixtures.ts';

const input = (bytes: Uint8Array = PNG_PIXEL) => ({ bin: '/synthetic/never-executed', model: 'fixture', prompt: 'synthetic',
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false }, images: [{ mime: 'image/png' as const, bytes }], env: {} });

test.each([
  ['RGBA', PNG_PIXEL], ['Adam7', syntheticPng({ interlace: 1 })],
  ['all seven Adam7 passes', syntheticPng({ width: 9, height: 9, interlace: 1, pixels: new Uint8Array(343) })],
  ['grayscale', syntheticPng({ color: 0, pixels: Uint8Array.of(0, 123) })],
  ['16-bit RGBA', syntheticPng({ depth: 16, pixels: Uint8Array.of(0, 0, 12, 0, 34, 0, 56, 255, 255) })],
  ['indexed', syntheticPng({ color: 3, before: [pngChunk('PLTE', Uint8Array.of(12, 34, 56))], pixels: Uint8Array.of(0, 0) })],
  ['bounded compressed metadata', syntheticPng({ before: [pngChunk('zTXt', Buffer.concat([Buffer.from('test\0\0'), deflateSync(Buffer.from('fixture'))]))] })],
])('fully decodes %s and preserves the owned bytes', async (_, bytes) => {
  const prepared = await prepareCodexInput(input(bytes));
  expect(prepared.input.images[0]!.bytes).toEqual(bytes);
  expect(prepared.input.images[0]!.bytes).not.toBe(bytes);
});

const wrongCrc = Buffer.from(PNG_PIXEL); wrongCrc[45] = wrongCrc[45]! ^ 1;
test.each([
  ['CRC corruption', wrongCrc], ['truncated', PNG_PIXEL.subarray(0, -1)],
  ['appended bytes', Buffer.concat([PNG_PIXEL, Buffer.from('trailing')])],
  ['missing pixels', Buffer.concat([PNG_PIXEL.subarray(0, 33), pngChunk('IEND')])],
  ['duplicate header', syntheticPng({ before: [PNG_PIXEL.subarray(8, 33)] })],
  ['broken compressed stream', syntheticPng({ compressed: Uint8Array.of(1, 2, 3) })],
  ['short pixels', syntheticPng({ pixels: Uint8Array.of(0) })],
  ['excess pixels', syntheticPng({ pixels: new Uint8Array(1024 * 1024) })],
  ['invalid filter', syntheticPng({ pixels: Uint8Array.of(5, 12, 34, 56, 255) })],
  ['unsupported color', syntheticPng({ color: 7 })],
  ['invalid bit depth', syntheticPng({ depth: 3 })],
  ['zero width', syntheticPng({ width: 0 })],
  ['over pixel limit', syntheticPng({ width: CODEX_PROPOSAL_LIMITS.imagePixels + 1 })],
  ['animation', syntheticPng({ before: [pngChunk('acTL', new Uint8Array(8))] })],
  ['unknown critical chunk', syntheticPng({ before: [pngChunk('ABCD')] })],
  ['indexed without palette', syntheticPng({ color: 3, pixels: Uint8Array.of(0, 0) })],
  ['non-contiguous data', syntheticPng({ after: [pngChunk('tEXt'), pngChunk('IDAT')] })],
  ['trailing deflate data', syntheticPng({ compressed: Buffer.concat([deflateSync(Uint8Array.of(0, 12, 34, 56, 255)), Buffer.from('tail')]) })],
  ['metadata decompression bomb', syntheticPng({ before: [pngChunk('zTXt', Buffer.concat([Buffer.from('test\0\0'), deflateSync(new Uint8Array(1_000_001))]))] })],
])('%s is an explicit input failure before dispatch', async (_, bytes) => {
  await expect(prepareCodexInput(input(bytes))).rejects.toMatchObject({ reason: 'invalid_input' });
});

test('takes an immutable snapshot before asynchronous decoding', async () => {
  const bytes = Buffer.from(PNG_PIXEL), original = input(bytes);
  const pending = prepareCodexInput(original);
  bytes.fill(0); original.model = 'changed'; original.prompt = 'changed';
  const prepared = await pending;
  expect(prepared.input.images[0]!.bytes).toEqual(PNG_PIXEL);
  expect(prepared.input.model).toBe('fixture'); expect(prepared.input.prompt).toBe('synthetic');
});

test('cancellation during preparation prevents admission', async () => {
  const controller = new AbortController();
  const pending = prepareCodexInput({ ...input(), signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ reason: 'aborted' });
});
