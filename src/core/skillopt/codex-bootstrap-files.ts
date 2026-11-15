import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { assertLegacySkillFilesystemWrite } from '../skillpack/writer-guard.ts';
import { flushDirectory } from '../fs-durable.ts';

const limit = 1048576;
function invalid(): never { throw new CodexProposalError('invalid_input'); }
/** Bounded regular-file UTF-8 reads; no symlink, FIFO, device or multiply linked input. */
export function readBootstrapFile(path: string, optional = false): string | undefined {
  let expected: fs.Stats;
  try { expected = fs.lstatSync(path); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; return invalid(); }
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1 || expected.size > limit) invalid();
  let fd: number;
  try { fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch { return invalid(); }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || stat.dev !== expected.dev || stat.ino !== expected.ino) invalid();
    const bytes = Buffer.alloc(limit + 1); let total = 0;
    for (;;) { const count = fs.readSync(fd, bytes, total, bytes.length - total, total); if (!count) break; total += count; if (total > limit) invalid(); }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total));
  } catch { return invalid(); } finally { fs.closeSync(fd); }
}

export interface BootstrapFiles {
  directory: string; dev: number; ino: number; skillPath: string; routingPath: string; outputPath: string;
  skillText: string; routingText?: string; priorOutput?: string;
}
export function snapshotBootstrapFiles(skillsDir: string, skillName: string, routing: boolean): BootstrapFiles {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName) || skillName.length > 100) invalid();
  let root: string;
  try { root = fs.realpathSync(resolve(skillsDir)); } catch { return invalid(); }
  const directory = join(root, skillName), stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  const skillPath = join(directory, 'SKILL.md'), routingPath = join(directory, 'routing-eval.jsonl'), outputPath = join(directory, 'skillopt-benchmark.jsonl');
  assertLegacySkillFilesystemWrite(outputPath);
  return { directory, dev: stat.dev, ino: stat.ino, skillPath, routingPath, outputPath,
    skillText: readBootstrapFile(skillPath)!, routingText: routing ? readBootstrapFile(routingPath) : undefined, priorOutput: readBootstrapFile(outputPath, true) };
}

export function assertBootstrapFilesCurrent(files: BootstrapFiles): void {
  const stat = fs.lstatSync(files.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== files.dev || stat.ino !== files.ino ||
      readBootstrapFile(files.skillPath) !== files.skillText ||
      files.routingText !== undefined && readBootstrapFile(files.routingPath) !== files.routingText ||
      readBootstrapFile(files.outputPath, true) !== files.priorOutput) invalid();
  assertLegacySkillFilesystemWrite(files.outputPath);
}

/** Only an unmanaged review draft; canonical skill publication must use the prepared writer. */
export function writeBootstrapDraft(files: BootstrapFiles, text: string): void {
  if (Buffer.byteLength(text) > limit) invalid();
  assertBootstrapFilesCurrent(files);
  if (files.priorOutput === text) return; // lost acknowledgement, exact accepted draft already present
  const temp = join(files.directory, `.codex-bootstrap-${randomUUID()}.tmp`);
  assertLegacySkillFilesystemWrite(temp);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    assertBootstrapFilesCurrent(files);
    if (files.priorOutput === undefined) { fs.linkSync(temp, files.outputPath); fs.unlinkSync(temp); }
    else fs.renameSync(temp, files.outputPath);
    flushDirectory(files.directory);
  } finally { fs.rmSync(temp, { force: true }); }
}
