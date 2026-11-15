/** One explicit, signed-in synthetic model call; never reads or writes brain content. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { assertProductionCodexHostBoundary, assertTrustedCodexExecutable } from '../src/core/ai/providers/codex-qualification.ts';
import { CodexProposalError } from '../src/core/ai/providers/codex-contract.ts';
import { parseCodexLifecycle } from '../src/core/ai/providers/codex-lifecycle.ts';
import { codexProposalModelCatalog } from '../src/core/ai/providers/codex-model-catalog.ts';
import { codexEnvironment, runCodexProcess } from '../src/core/ai/providers/codex-process.ts';
import { CODEX_DENY_NATIVE_HOOK, CODEX_PROPOSAL_INSTRUCTIONS, codexProposalArgv } from '../src/core/ai/providers/codex-runtime.ts';
import { prepareCodexSchema } from '../src/core/ai/providers/codex-schema.ts';

const [acknowledgement, bin, model] = process.argv.slice(2);
if (acknowledgement !== '--live' || !bin || !isAbsolute(bin) || !model) {
  console.error('Usage: bun scripts/codex-runtime-live-synthetic-probe.ts --live /absolute/path/to/codex model-slug');
  process.exit(2);
}

const prepared = prepareCodexSchema({ type: 'object', properties: {
  evidence_hash: { type: 'string', enum: ['synthetic-hash'] },
  synopsis: { type: 'string', minLength: 1, maxLength: 300 },
  source_quote: { type: 'string', minLength: 1, maxLength: 2000 },
  image_note: { type: 'string', minLength: 1, maxLength: 300 },
}, required: ['evidence_hash', 'synopsis', 'source_quote', 'image_note'], additionalProperties: false });
// This is a candidate-qualification probe, not production allowlist admission.
// Match the exact build inspected by the credential-free boundary probe and staging helper.
const expectedSha256 = '50ed828f357c655a3c82054d346cab8434f24901f14ec19b8267571bdd008b38';
const runtime = await open(bin, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
let scratch: string | undefined;
let settled = true;
try {
  const before = await runtime.stat();
  assertTrustedCodexExecutable(before);
  if (before.size > 512 * 1024 * 1024) throw new Error('Codex live probe runtime exceeds size bound');
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  for (let offset = 0; offset < before.size;) {
    const { bytesRead } = await runtime.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset);
    if (!bytesRead) throw new Error('short Codex live probe runtime read');
    hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
  }
  const after = await runtime.stat();
  assertTrustedCodexExecutable(after);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error('Codex live probe runtime changed during hashing');
  }
  const sha256 = hash.digest('hex');
  if (sha256 !== expectedSha256) throw new Error('Codex live probe runtime digest differs from inspected build');
  await assertProductionCodexHostBoundary();
  scratch = await mkdtemp(join(tmpdir(), 'gbrain-codex-live-synthetic-'));
  await chmod(scratch, 0o700);
  const schemaFile = join(scratch, 'schema.json');
  const answerFile = join(scratch, 'answer.json');
  const denyHook = join(scratch, 'deny-native');
  const instructionsFile = join(scratch, 'instructions.txt');
  const modelCatalogFile = join(scratch, 'model-catalog.json');
  const imageFile = join(scratch, 'pixel.png');
  await writeFile(schemaFile, prepared.serialized, { mode: 0o600, flag: 'wx' });
  await writeFile(answerFile, '', { mode: 0o600, flag: 'wx' });
  await writeFile(denyHook, CODEX_DENY_NATIVE_HOOK, { mode: 0o700, flag: 'wx' });
  await writeFile(instructionsFile, CODEX_PROPOSAL_INSTRUCTIONS, { mode: 0o600, flag: 'wx' });
  await writeFile(modelCatalogFile, codexProposalModelCatalog(model), { mode: 0o600, flag: 'wx' });
  await writeFile(imageFile,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgUbL4DwACCgFmeGgpMwAAAABJRU5ErkJggg==', 'base64'),
    { mode: 0o600, flag: 'wx' });
  await writeFile(join(scratch, '.gbrain-codex-root'), '', { mode: 0o600, flag: 'wx' });
  const stdout = await runCodexProcess({ runtimeFd: runtime.fd, isolation: 'pid-namespace',
    args: codexProposalArgv({ cwd: scratch, model, schemaFile, answerFile, denyHook,
      instructionsFile, modelCatalogFile, imageFiles: [imageFile] }),
    cwd: scratch, env: codexEnvironment(process.env),
    prompt: 'Synthetic source chunk: The cube is red. An unrelated one-pixel test image is attached. Return evidence_hash synthetic-hash, a brief synopsis, the exact source_quote from the chunk, and a brief image_note. Do not use tools.',
    timeoutMs: 90_000, maxOutputBytes: 65_536 });
  const lifecycle = parseCodexLifecycle(stdout);
  const answerText = await readFile(answerFile, 'utf8');
  const answer = JSON.parse(answerText) as Record<string, unknown>;
  const schemaValid = prepared.validate(answer);
  const quoteExact = answer.source_quote === 'The cube is red.';
  const lifecycleTextMatches = lifecycle.text.trim() === answerText.trim();
  const eventTypes = stdout.trim().split('\n').map(line => (JSON.parse(line) as { type: string }).type);
  const result = { model, sha256, hostBoundary: 'pass', runtimeFileProtected: true, schemaValid, quoteExact, lifecycleTextMatches,
    eventTypes, usage: lifecycle.usage };
  console.log(JSON.stringify(result));
  if (!schemaValid || !quoteExact || !lifecycleTextMatches) process.exitCode = 1;
} catch (error) {
  if (error instanceof CodexProposalError) settled = error.settled;
  throw error;
} finally {
  await runtime.close();
  if (settled && scratch) await rm(scratch, { recursive: true, force: true });
}
