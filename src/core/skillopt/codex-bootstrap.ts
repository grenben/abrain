import type { BootstrapOpts, BootstrapFromSkillOpts, BootstrapResult } from './bootstrap-benchmark.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { assertLegacySkillWriter } from '../skillpack/writer-guard.ts';
import { digest } from '../persistence/digest.ts';
import { BOOTSTRAP_PENDING_REVIEW } from './types.ts';
import { opError } from '../ops/contract.ts';
import { proposeCodexBenchmark } from './codex-bootstrap-proposal.ts';
import { snapshotBootstrapFiles, assertBootstrapFilesCurrent, writeBootstrapDraft } from './codex-bootstrap-files.ts';

/** Native proposal generation with a review-only draft. Does not mutate an installed skill. */
export async function runCodexBootstrap(opts: BootstrapOpts & Partial<BootstrapFromSkillOpts>, mode: 'routing' | 'skill'): Promise<BootstrapResult> {
  const host = codexSubscriptionContext();
  if (!host) throw new SubscriptionAdmissionError('subscription_required');
  const { skillsDir, skillName, optimizerModel, force, taskCount = 15, chatFn, abortSignal } = opts;
  if (chatFn || mode === 'skill' && (!Number.isSafeInteger(taskCount) || taskCount < 1 || taskCount > 50)) throw new CodexProposalError('invalid_input');
  const files = snapshotBootstrapFiles(skillsDir, skillName, mode === 'routing');
  if (files.priorOutput !== undefined && !force) throw opError('benchmark_exists', 'The draft benchmark already exists.',
    'Review the existing draft; use --force only when you intend to replace it.');
  let intents: string[] | undefined;
  if (mode === 'routing') {
    const lines = files.routingText!.split('\n').filter(l => l.trim());
    if (lines.length > 1000) throw new CodexProposalError('invalid_input');
    intents = [];
    for (const line of lines) {
      let row: { intent: string; expected_skill: string };
      try { row = JSON.parse(line); } catch { throw new CodexProposalError('invalid_input'); }
      if (!row || typeof row.intent !== 'string' || !row.intent.trim() || row.intent.length > 4000 || typeof row.expected_skill !== 'string') throw new CodexProposalError('invalid_input');
      if (row.expected_skill === skillName) intents.push(row.intent);
    }
    if (intents.length > 50 || new Set(intents.map(s => s.trim())).size !== intents.length) throw new CodexProposalError('invalid_input');
    if (!intents.length) throw opError('bootstrap_empty', 'No routing intents select this skill.', 'Add matching routing examples before generating a draft benchmark.');
  }
  await host.checkAuthority?.();
  await assertLegacySkillWriter(host.engine, files.outputPath);
  assertBootstrapFilesCurrent(files);
  const { tasks, proposal } = await proposeCodexBenchmark({ skillName, skillText: files.skillText, optimizerModel,
    taskCount: intents?.length ?? taskCount, intents, abortSignal,
    binding: digest({ outputPath: files.outputPath, mode, routingText: files.routingText ?? null, directory: [files.dev, files.ino] }) });
  const output = [...tasks.map(t => JSON.stringify(t)), BOOTSTRAP_PENDING_REVIEW, ''].join('\n');
  await host.checkAuthority?.();
  // Hold the host authority fence through the synchronous draft write. Recovery is
  // exact-content comparison, not a claim that filesystem effects roll back with SQL.
  await host.engine.transaction(async tx => {
    await host.checkAuthorityInTransaction?.(tx);
    const [grant] = await tx.executeRaw<{ current: boolean }>('SELECT deadline>now() AS current FROM codex_subscription_runs WHERE run_id=$1 FOR UPDATE', [host.runId]);
    if (!grant?.current) throw new SubscriptionAdmissionError('subscription_exhausted');
    if (host.signal?.aborted || abortSignal?.aborted) throw new CodexProposalError('aborted');
    await assertLegacySkillWriter(tx, files.outputPath);
    if (host.signal?.aborted || abortSignal?.aborted) throw new CodexProposalError('aborted');
    writeBootstrapDraft(files, output);
  });
  process.stderr.write(`[skillopt] Draft benchmark: ${tasks.length} tasks. REVIEW + STRENGTHEN the checks before --bootstrap-reviewed; generated checks are not quality certification.\n`);
  return { outputPath: files.outputPath, rowsGenerated: tasks.length, rowsSkipped: 0, cacheHit: proposal.cacheHit,
    usage: proposal.usage, billing: proposal.billing };
}
