import type { SkillOptOpts } from './types.ts';
import type { OptimizerFiles } from './codex-run-files.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { readPrivateCodexConfig, resolvePrivateModel } from '../ai/private-policy.ts';
import { parseBenchmark, splitBench } from './benchmark.ts';
import { assertBundledMutationHeldOut } from './bundled-skill-gate.ts';
import { resolveReflectMaxTokens } from './output-cap.ts';
import { CODEX_READ_PROTOCOL, validateCodexReadJob } from '../minions/codex-action-contract.ts';
import { buildModelsPlan, unknownProvenanceModels, strictVerdict, resolveModelsStrict, modelsStrictError } from './models-plan.ts';
const invalid = (): never => { throw new CodexProposalError('invalid_input'); };
export function assertNativeOptimizerControls(original: SkillOptOpts): void {
  if (!original.operationContext || original.operationContext.engine !== original.engine || original.operationContext.remote !== false || !original.operationContext.sourceId ||
      !original.codex || original.sharedSkill || original.resumeRunId || original.writeCapture || original.disableValidationGate ||
      original.optimizerMode && original.optimizerMode !== 'reflect' || original.reflectMode && original.reflectMode !== 'both' ||
      ![original.epochs, original.batchSize, original.lr].every(n => Number.isSafeInteger(n) && n > 0) ||
      original.epochs > 20 || original.batchSize > 20 || original.lr > 20 ||
      !['constant', 'linear', 'cosine'].includes(original.lrSchedule) || !['patch', 'rewrite'].includes(original.mode) ||
      !Number.isFinite(original.maxRuntimeMin) || original.maxRuntimeMin <= 0 || original.maxRuntimeMin > 1440) invalid();
}
/** Validate immutable content and controls before any producer grants or queues work. */
export async function preflightNativeOptimizer(opts: SkillOptOpts,
  files: Pick<OptimizerFiles, 'skillText' | 'benchmarkText' | 'benchmarkPath' | 'heldOutText' | 'heldOutPath' | 'bundled' | 'mutate'>,
  policy: NonNullable<ReturnType<typeof readPrivateCodexConfig>>) {
  assertNativeOptimizerControls(opts);
  validateCodexReadJob({ action_protocol: CODEX_READ_PROTOCOL, prompt: 'scope preflight', source_id: opts.operationContext!.sourceId, no_self_fix: true,
    allowed_tools: opts.codex!.allowedTools, allowed_slug_prefixes: opts.codex!.allowedSlugPrefixes,
    ...(opts.codex!.readRegistry !== undefined ? { read_registry: opts.codex!.readRegistry } : {}), max_turns: 16 });
  const engine = opts.engine;
  if (Buffer.byteLength(files.skillText) > 12000) invalid();
  const benchmark = parseBenchmark(files.benchmarkText, files.benchmarkPath, { bootstrapReviewed: opts.bootstrapReviewed });
  const heldOut = files.heldOutText === null ? [] : parseBenchmark(files.heldOutText, files.heldOutPath!, { bootstrapReviewed: true }).tasks;
  if (benchmark.tasks.length > 100 || heldOut.length > 100 || heldOut.some(t => benchmark.tasks.some(b => b.task_id === t.task_id))) invalid();
  const split = splitBench(benchmark, opts.split ?? [4, 1, 5]);
  if (Math.ceil(split.train.length / opts.batchSize) * opts.epochs > 100) invalid();
  assertBundledMutationHeldOut({ isBundled: files.bundled, willMutate: files.mutate, heldOutCount: heldOut.length, skillName: opts.skillName });
  await resolvePrivateModel(engine, { privateRole: 'skillopt-optimizer', cliFlag: opts.optimizerModel, tier: 'deep', fallback: 'unused' }, policy!);
  await resolvePrivateModel(engine, { privateRole: 'iterative-minions', cliFlag: opts.targetModel, tier: 'subagent', configKey: 'models.subagent', fallback: 'unused' }, policy!);
  await resolvePrivateModel(engine, { privateRole: 'skillopt-judge', cliFlag: opts.judgeModel, tier: 'reasoning', fallback: 'unused' }, policy!);
  for (const task of [...benchmark.tasks, ...heldOut]) if (task.judge.kind === 'llm' && task.judge.model)
    await resolvePrivateModel(engine, { privateRole: 'skillopt-judge', cliFlag: task.judge.model, tier: 'reasoning', fallback: 'unused' }, policy!);
  const cap = await resolveReflectMaxTokens(engine, opts.optimizerModel, opts.reflectMaxTokens);
  if (cap.maxTokens < 16 || cap.maxTokens > 8192) invalid();
  const modelsPlan = (await buildModelsPlan(engine, opts.models ?? unknownProvenanceModels(opts, 'caller-supplied'), [...benchmark.tasks, ...heldOut]))
    .filter(p => ['optimizer', 'target', 'judge'].includes(p.touchpoint));
  const strict = strictVerdict(modelsPlan, await resolveModelsStrict(engine, opts.modelsStrict));
  if (strict.enabled && !strict.ok && !opts.dryRun) throw modelsStrictError(strict);
  return { benchmark, heldOut, split, cap, modelsPlan, strict };
}
