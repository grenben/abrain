import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { assertLegacySkillWriter } from '../skillpack/writer-guard.ts';
import { readBootstrapFile, writeBootstrapDraft } from './codex-bootstrap-files.ts';
import type { SkillOptOpts } from './types.ts';
import { getWorkingTreeStatusForFile } from './apply-edits.ts';
import { getBundledSkillContext, shouldMutateSkillFile } from './bundled-skill-gate.ts';
export interface OptimizerFiles {
  directory: string; dev: number; ino: number; skillPath: string; skillText: string;
  benchmarkPath: string; benchmarkText: string; heldOutPath: string | null; heldOutText: string | null;
  outputPath: string; priorOutput: string | null; mutate: boolean; bundled: boolean;
}
const invalid = (): never => { throw new CodexProposalError('invalid_input'); };
export function snapshotOptimizerFiles(opts: SkillOptOpts, prior?: { files: OptimizerFiles; finalText?: string; complete: boolean }): OptimizerFiles {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(opts.skillName) || opts.skillName.length > 100) invalid();
  const root = realpathSync(resolve(opts.skillsDir)), directory = join(root, opts.skillName), stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  const skillPath = join(directory, 'SKILL.md'), bundled = getBundledSkillContext(root, opts.skillName);
  const mutate = shouldMutateSkillFile(bundled, opts).mutate;
  const outputPath = mutate ? skillPath : join(directory, 'skillopt-proposed.md');
  const currentText = readBootstrapFile(skillPath)!, output = readBootstrapFile(outputPath, true) ?? null;
  const current: OptimizerFiles = { directory, dev: stat.dev, ino: stat.ino, skillPath, skillText: currentText,
    benchmarkPath: resolve(opts.benchmarkPath), benchmarkText: readBootstrapFile(resolve(opts.benchmarkPath))!,
    heldOutPath: opts.heldOutPath ? resolve(opts.heldOutPath) : null, heldOutText: opts.heldOutPath ? readBootstrapFile(resolve(opts.heldOutPath))! : null,
    outputPath, priorOutput: output, mutate, bundled: bundled.isBundled };
  if (prior) {
    const old = prior.files, expectedOutput = prior.finalText;
    if (current.directory !== old.directory || current.dev !== old.dev || current.ino !== old.ino || current.outputPath !== old.outputPath ||
        current.benchmarkPath !== old.benchmarkPath || current.benchmarkText !== old.benchmarkText || current.heldOutPath !== old.heldOutPath || current.heldOutText !== old.heldOutText ||
        current.mutate !== old.mutate || current.bundled !== old.bundled ||
        currentText !== old.skillText && !(mutate && expectedOutput !== undefined && currentText === expectedOutput) ||
        output !== old.priorOutput && output !== expectedOutput || prior.complete && expectedOutput !== undefined && output !== expectedOutput) invalid();
    return structuredClone(old);
  }
  if (!opts.force && getWorkingTreeStatusForFile(skillPath) === 'dirty') invalid();
  return current;
}
/** Original snapshot and accepted bytes are the deterministic reconciliation contract. */
export async function publishOptimizerFile(engine: BrainEngine, files: OptimizerFiles, finalText: string): Promise<void> {
  await assertLegacySkillWriter(engine, files.outputPath);
  codexSubscriptionContext()?.signal?.throwIfAborted();
  const stat = lstatSync(files.directory), current = readBootstrapFile(files.skillPath), output = readBootstrapFile(files.outputPath, true);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== files.dev || stat.ino !== files.ino ||
      current !== files.skillText && !(files.mutate && current === finalText) ||
      readBootstrapFile(files.benchmarkPath) !== files.benchmarkText ||
      files.heldOutPath && readBootstrapFile(files.heldOutPath) !== files.heldOutText) invalid();
  if (output === finalText) return;
  writeBootstrapDraft({ directory: files.directory, dev: files.dev, ino: files.ino, skillPath: files.skillPath,
    skillText: files.skillText, routingPath: '', outputPath: files.outputPath, priorOutput: files.priorOutput ?? undefined }, finalText);
}
