import { isAbsolute } from 'node:path';
import { CODEX_PROPOSAL_LIMITS as limits, CodexProposalError } from './codex-contract.ts';
import { prepareCodexSchema } from './codex-schema.ts';
import { validateCodexImages } from './codex-images.ts';
import { codexEnvironment } from './codex-process.ts';
import type { CodexProposalInput } from './codex-proposal.ts';
import { decodePngPixels } from './codex-png.ts';

/** Validate and snapshot before admission/hashing or any await. */
export async function prepareCodexInput(input: CodexProposalInput) {
  if (input.signal?.aborted) throw new CodexProposalError('aborted');
  const prepared = prepareCodexSchema(input.schema);
  const timeoutMs = input.timeoutMs ?? limits.timeoutMs;
  const maxOutputBytes = input.maxOutputBytes ?? limits.outputBytes;
  if (typeof input.bin !== 'string' || !isAbsolute(input.bin) ||
    typeof input.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(input.model) ||
    typeof input.prompt !== 'string' || !input.prompt || Buffer.byteLength(input.prompt) > limits.promptBytes ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > limits.maxTimeoutMs ||
    !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > limits.outputBytes) {
    throw new CodexProposalError('invalid_input');
  }
  const images = validateCodexImages(input.images ?? []);
  const snapshot = { ...input, schema:prepared.schema, images, timeoutMs, maxOutputBytes,
    env:codexEnvironment(input.env ?? process.env) };
  for (const image of images) {
    if (snapshot.signal?.aborted) throw new CodexProposalError('aborted');
    if (image.mime === 'image/png') await decodePngPixels(image.bytes);
  }
  if (snapshot.signal?.aborted) throw new CodexProposalError('aborted');
  return { prepared, input: snapshot };
}
