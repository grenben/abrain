import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { CodexProposalError } from './codex-contract.ts';

/**
 * Intentionally empty until a pinned official build proves pre-execution denial,
 * including hook failure, inherited configuration, instructions and hosted tools.
 * Help flags and post-hoc JSONL rejection do not establish that property.
 */
const QUALIFIED_SHA256 = new Set<string>();
const fixtures = new Map<string, string>();
/** Test fixture registration, never called by production source. No real runtime is approved by tests. */
export function __registerCodexFixtureForTests(path: string, sha256: string): () => void {
  fixtures.set(path, sha256);
  return () => { fixtures.delete(path); };
}
/** Keep the verified inode open until the child has inherited it. A pathname can be replaced after hashing. */
export async function openQualifiedCodexRuntime(bin: string): Promise<FileHandle> {
  if (!QUALIFIED_SHA256.size && !fixtures.has(bin)) throw new CodexProposalError('runtime_unqualified');
  let file: FileHandle | undefined;
  try {
    file = await open(bin, constants.O_RDONLY);
    const info = await file.stat();
    if (!info.isFile() || !info.size || !(info.mode & 0o111)) throw new Error('not executable');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (let offset = 0; offset < info.size;) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, info.size - offset), offset);
      if (!bytesRead) throw new Error('short executable read');
      hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('executable changed during hash');
    const sha256 = hash.digest('hex');
    if (!QUALIFIED_SHA256.has(sha256) && fixtures.get(bin) !== sha256) throw new Error('unqualified executable');
    return file;
  } catch {
    await file?.close().catch(() => {});
    throw new CodexProposalError('runtime_unqualified');
  }
}

export async function assertCodexRuntimeQualified(bin: string): Promise<void> {
  const file = await openQualifiedCodexRuntime(bin);
  await file.close();
}
