import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from '../../spawn.ts';
import { CodexProposalError } from './codex-contract.ts';
import { codexNamespaceLaunch } from './codex-namespace.ts';

/**
 * Intentionally empty until a pinned official build proves pre-execution denial,
 * including hook failure, inherited configuration, instructions and hosted tools.
 * Help flags and post-hoc JSONL rejection do not establish that property.
 */
const QUALIFIED_SHA256 = new Set<string>();
const fixtures = new Map<string, string>();

/** A real runtime must exclude managed overrides and use a trusted namespace launcher. */
async function assertLinuxHostBoundary(root: string, trustedUid: number, callerUid: number): Promise<void> {
  if (callerUid === trustedUid) throw new Error('runtime owns system configuration');
  for (const path of [root, join(root, 'etc'), join(root, 'usr'), join(root, 'usr', 'bin')]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== trustedUid || (info.mode & 0o022)) {
      throw new Error('mutable system path');
    }
  }
  for (const name of ['unshare', 'true', 'setpriv', 'dash']) {
    const executable = await lstat(join(root, 'usr', 'bin', name));
    if (!executable.isFile() || executable.uid !== trustedUid
      || (executable.mode & 0o022) || !(executable.mode & 0o111)) {
      throw new Error('untrusted namespace support executable');
    }
  }
  try {
    await lstat(join(root, 'etc', 'codex'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('managed Codex configuration present');
}

/** Refuse an unsupported namespace host before reserving a subscription call. */
export function assertCodexNamespaceAvailable(launcher = '/usr/bin/unshare', proof = '/usr/bin/true'): void {
  const launch = codexNamespaceLaunch(proof, [], launcher);
  const result = spawnSync(launch.command, launch.args,
  { timeout: 2_000, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
  if (result.error || result.status !== 0 || result.signal) throw new Error('Codex namespace unavailable');
}

/** Production boundary is fixed to the Linux system path; other platforms stay unqualified. */
export async function assertProductionCodexHostBoundary(): Promise<void> {
  if (process.platform !== 'linux' || !process.getuid) throw new Error('unsupported host boundary');
  await assertLinuxHostBoundary('/', 0, process.getuid());
  assertCodexNamespaceAvailable();
}

/** A same-user writable inode can change after hashing even while its fd stays open. */
export function assertTrustedCodexExecutable(info: Pick<Stats, 'uid' | 'mode' | 'size' | 'isFile'>, trustedUid = 0): void {
  if (!info.isFile() || !info.size || !(info.mode & 0o111) || info.uid !== trustedUid || (info.mode & 0o022)) {
    throw new Error('mutable Codex executable');
  }
}

/** Synthetic filesystem seam; it never registers a production runtime hash. */
export async function __assertCodexHostBoundaryForTests(root: string, trustedUid: number, callerUid: number): Promise<void> {
  await assertLinuxHostBoundary(root, trustedUid, callerUid);
}
export interface OpenCodexRuntime { file: FileHandle; production: boolean }
/** Test fixture registration, never called by production source. No real runtime is approved by tests. */
export function __registerCodexFixtureForTests(path: string, sha256: string): () => void {
  fixtures.set(path, sha256);
  return () => { fixtures.delete(path); };
}
/** Keep the verified inode open until the child has inherited it. A pathname can be replaced after hashing. */
export async function openQualifiedCodexRuntime(bin: string): Promise<OpenCodexRuntime> {
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
    const production = QUALIFIED_SHA256.has(sha256);
    if (!production && fixtures.get(bin) !== sha256) throw new Error('unqualified executable');
    if (production) {
      assertTrustedCodexExecutable(after);
      await assertProductionCodexHostBoundary();
    }
    return { file, production };
  } catch {
    await file?.close().catch(() => {});
    throw new CodexProposalError('runtime_unqualified');
  }
}

export async function assertCodexRuntimeQualified(bin: string): Promise<void> {
  const runtime = await openQualifiedCodexRuntime(bin);
  await runtime.file.close();
}
