import * as fs from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { flushDirectory } from '../fs-durable.ts';
import { assertLegacySkillFilesystemWrite } from '../skillpack/writer-guard.ts';
import { sharedOptimizerConflict, type SharedOptimizerInput } from './codex-optimizer-store.ts';
const directory = (path: string) => {
  fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(path) !== resolve(path) || (stat.mode & 0o077) ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid()) sharedOptimizerConflict();
};
/** Bounded regular-file input for native canonical snapshots, including binary assets. */
export function readNativeOptimizerFile(path: string): Buffer {
  const limit = 2097152, expected = fs.lstatSync(path);
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1 || expected.size > limit) sharedOptimizerConflict();
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || stat.dev !== expected.dev || stat.ino !== expected.ino) sharedOptimizerConflict();
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size < bytes.length) { const count = fs.readSync(fd, bytes, size, bytes.length - size, size); if (!count) break; size += count; }
    if (size > limit || size !== stat.size) sharedOptimizerConflict();
    return bytes.subarray(0, size);
  } finally { fs.closeSync(fd); }
}
function equalFile(path: string, bytes: Buffer): boolean {
  try {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes.length || (stat.mode & 0o077)) sharedOptimizerConflict();
      const current = Buffer.alloc(bytes.length + 1); let size = 0;
      while (size < current.length) { const count = fs.readSync(fd, current, size, current.length - size, size); if (!count) break; size += count; }
      if (size !== bytes.length || !current.subarray(0, size).equals(bytes)) sharedOptimizerConflict();
      return true;
    } finally { fs.closeSync(fd); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** Owner-only immutable staging; partial staging resumes only from absent or exact expected files. */
export function stageSharedOptimizer(input: SharedOptimizerInput): { skillsDir: string; benchmarkPath: string; heldOutPath?: string } {
  const root = input.stageRoot; assertLegacySkillFilesystemWrite(root); directory(dirname(root)); directory(root);
  const entries = [...input.files.map(file => [file.path, Buffer.from(file.content, 'base64')] as const),
    ['benchmark.jsonl', Buffer.from(input.evaluationInputs[0]!, 'base64')] as const,
    ...input.evaluationInputs.length > 1 ? [['held-out.jsonl', Buffer.from(input.evaluationInputs[1]!, 'base64')] as const] : []];
  for (const [name, bytes] of entries) {
    const path = resolve(root, name), rel = relative(root, path);
    if (!rel || rel.startsWith('..') || rel.startsWith(sep)) sharedOptimizerConflict();
    let cursor = root;
    for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) { cursor = join(cursor, part); directory(cursor); }
    assertLegacySkillFilesystemWrite(path); if (equalFile(path, bytes)) continue;
    const temp = join(dirname(path), `.codex-stage-${randomUUID()}.tmp`), fd = fs.openSync(temp, 'wx', 0o600);
    try {
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.linkSync(temp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !equalFile(path, bytes)) throw error; }
      flushDirectory(dirname(path));
    } finally { fs.rmSync(temp, { force: true }); }
  }
  return { skillsDir: join(root, 'skills'), benchmarkPath: join(root, 'benchmark.jsonl'),
    ...input.evaluationInputs.length > 1 ? { heldOutPath: join(root, 'held-out.jsonl') } : {} };
}
