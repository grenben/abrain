import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { sha256 } from '../persistence/digest.ts';
import { opError } from '../ops/contract.ts';

/** Host-discovered input identity. Never supplied by a model or opened as an action. */
export interface PublicationFileEvidence { path: string; hash: string; device: string; inode: string; bytes: number }
export const MAX_SYNTHESIS_FILE_BYTES = 2 * 1024 * 1024;
export function snapshotPublicationFile(path: string): { evidence: PublicationFileEvidence; content: string } {
  const canonical = realpathSync(path);
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_SYNTHESIS_FILE_BYTES)) throw new Error('codex_synthesis_input_bounds');
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    let length = 0, read = 0;
    do { read = readSync(fd, buffer, length, buffer.length - length, null); length += read; } while (read && length < buffer.length);
    const bytes = buffer.subarray(0, length);
    if (bytes.length > MAX_SYNTHESIS_FILE_BYTES || BigInt(bytes.length) !== stat.size) throw new Error('codex_synthesis_input_changed');
    return { content: bytes.toString('utf8'), evidence: { path: canonical, hash: sha256(bytes),
      device: String(stat.dev), inode: String(stat.ino), bytes: bytes.length } };
  } finally { closeSync(fd); }
}
export function validatePublicationFiles(files: PublicationFileEvidence[]): void {
  for (const expected of files) {
    try {
      if (!isAbsolute(expected.path) || realpathSync(expected.path) !== expected.path) throw new Error('changed');
      const actual = snapshotPublicationFile(expected.path).evidence;
      if (actual.hash !== expected.hash || actual.device !== expected.device || actual.inode !== expected.inode || actual.bytes !== expected.bytes) throw new Error('changed');
    } catch {
      throw opError('revision_conflict', 'The retained transcript file changed or is unavailable.', 'Inspect the retained plan and write receipts before resuming.');
    }
  }
}
