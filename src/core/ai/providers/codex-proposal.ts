import { assertCodexRuntimeQualified } from './codex-qualification.ts';
/** One ephemeral proposal. Authorization and effects belong to the GBrain caller. */
import { mkdtemp, writeFile, rm, chmod, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProposalError, type CodexUsage } from './codex-contract.ts';
import { prepareCodexInput } from './codex-input.ts';
import { parseCodexLifecycle } from './codex-lifecycle.ts';
import type { CodexImage } from './codex-images.ts';
import { codexEnvironment, runCodexProcess } from './codex-process.ts';
import { CODEX_DENY_NATIVE_HOOK, CODEX_PROPOSAL_INSTRUCTIONS, codexProposalArgv } from './codex-runtime.ts';
import { codexProposalModelCatalog } from './codex-model-catalog.ts';
export { CodexProposalError } from './codex-contract.ts';
export type { CodexProposalFailure } from './codex-contract.ts';
export type { CodexImage } from './codex-images.ts';

export interface CodexProposalInput {
  bin: string; model: string; prompt: string; schema: Record<string, unknown>;
  images?: readonly CodexImage[]; signal?: AbortSignal; timeoutMs?: number;
  maxOutputBytes?: number; env?: NodeJS.ProcessEnv;
}
export interface CodexProposalResult {
  value: unknown; text: string; usage: CodexUsage | null;
  billing: { kind: 'subscription'; costUsd: null; remainingQuota: null };
}

/** Hold durable admission until settled; termination_unconfirmed retains its lane. */
export async function runCodexProposal(original: CodexProposalInput): Promise<CodexProposalResult> {
  const { input, prepared } = await prepareCodexInput(original);
  const { images, timeoutMs, maxOutputBytes } = input;
  await assertCodexRuntimeQualified(input.bin);
  const scratch = await mkdtemp(join(tmpdir(), 'gbrain-codex-proposal-'));
  let settled = true;
  let completion: {usage:CodexUsage|null} | undefined;
  try {
    await chmod(scratch, 0o700);
    const schemaFile = join(scratch, 'schema.json');
    const answerFile = join(scratch, 'answer.json');
    const denyHook = join(scratch, 'deny-native');
    const instructionsFile = join(scratch, 'instructions.txt');
    const modelCatalogFile = join(scratch, 'model-catalog.json');
    await writeFile(schemaFile, prepared.serialized, { mode: 0o600, flag: 'wx' });
    await writeFile(answerFile, '', { mode: 0o600, flag: 'wx' });
    await writeFile(denyHook, CODEX_DENY_NATIVE_HOOK, { mode: 0o700, flag: 'wx' });
    await writeFile(instructionsFile, CODEX_PROPOSAL_INSTRUCTIONS, { mode: 0o600, flag: 'wx' });
    await writeFile(modelCatalogFile, codexProposalModelCatalog(input.model), { mode: 0o600, flag: 'wx' });
    const imageFiles: string[] = [];
    for (const [i, image] of images.entries()) {
      const path = join(scratch, `image-${i}.${image.mime.split('/')[1]}`);
      await writeFile(path, image.bytes, { mode: 0o600, flag: 'wx' }); imageFiles.push(path);
    }
    const stdout = await runCodexProcess({ bin: input.bin,
      args: codexProposalArgv({ cwd: scratch, model: input.model, schemaFile, answerFile, denyHook, instructionsFile, modelCatalogFile, imageFiles }),
      cwd: scratch, env: codexEnvironment(input.env ?? process.env), prompt: input.prompt,
      timeoutMs, maxOutputBytes, signal: input.signal });
    const lifecycle = parseCodexLifecycle(stdout);
    completion = {usage:lifecycle.usage};
    let text: string;
    try {
      const file = await open(answerFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > maxOutputBytes) throw new CodexProposalError('output_limit');
        const bytes = Buffer.alloc(maxOutputBytes + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > maxOutputBytes) throw new CodexProposalError('output_limit');
        text = bytes.subarray(0, bytesRead).toString('utf8');
      } finally { await file.close(); }
    } catch (error) {
      if (error instanceof CodexProposalError) throw error;
      throw new CodexProposalError('invalid_output');
    }
    if (text.trim() !== lifecycle.text.trim()) throw new CodexProposalError('invalid_output');
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new CodexProposalError('invalid_output'); }
    if (!prepared.validate(value)) throw new CodexProposalError('invalid_output');
    return { value, text, usage: lifecycle.usage, billing: { kind: 'subscription', costUsd: null, remainingQuota: null } };
  } catch (error) {
    if (error instanceof CodexProposalError) { settled = error.settled; error.terminalCompletion = completion; }
    throw error;
  } finally {
    if (settled) await rm(scratch, { recursive: true, force: true });
  }
}
