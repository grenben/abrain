/**
 * SkillOpt background job (`gbrain skillopt --background`, Minion handler
 * `skillopt`): job-data shape and the handler body.
 *
 * The job records the CLI's model FLAGS (not just the models they resolved
 * to), the enqueue-time role sources and the strict flag. At execution time
 * the handler re-resolves the roles through `resolveSkillOptModels` against
 * the brain's current config, so provenance and the strict check reflect the
 * configuration the run actually uses, not the one at enqueue. Legacy jobs
 * (no `model_flags`) keep their stored models with source `unknown`, which
 * strict mode refuses (fail-closed).
 */

import type { BrainEngine } from '../engine.ts';
import { TIER_DEFAULTS } from '../model-config.ts';
import {
  resolveSkillOptModels,
  skillOptModelOpts,
  unknownProvenanceModels,
  type SkillOptModelFlags,
  type SkillOptModels,
} from './models-plan.ts';
import { runSkillOpt } from './orchestrator.ts';
import { clampRemoteReflectMaxTokens } from './output-cap.ts';
import type { SkillOptOpts } from './types.ts';
import type { MinionJobContext } from '../minions/types.ts';
import { readPrivateCodexConfig } from '../ai/private-policy.ts';

export type SkillOptJobInput = Pick<SkillOptOpts,
  | 'skillsDir' | 'skillName' | 'benchmarkPath' | 'epochs' | 'batchSize' | 'lr' | 'lrSchedule' | 'split'
  | 'sharedSkill' | 'reflectMaxTokens' | 'mode' | 'dryRun' | 'noMutate' | 'allowMutateBundled' | 'heldOutPath'
  | 'bootstrapReviewed' | 'maxCostUsd' | 'maxCostSource' | 'maxRuntimeMin' | 'force'
> & { models: SkillOptModels; modelFlags: SkillOptModelFlags; modelsStrict: boolean };

export function buildSkillOptJobData(input: SkillOptJobInput): Record<string, unknown> {
  const flags = input.modelFlags;
  return {
    ...(input.sharedSkill ? { shared_skill: structuredClone(input.sharedSkill) } : {}),
    skills_dir: input.skillsDir,
    skill_name: input.skillName,
    benchmark_path: input.benchmarkPath,
    epochs: input.epochs,
    batch_size: input.batchSize,
    lr: input.lr,
    lr_schedule: input.lrSchedule,
    split: input.split,
    optimizer_model: input.models.optimizer.model,
    target_model: input.models.target.model,
    judge_model: input.models.judge.model,
    model_flags: {
      ...(flags.optimizerModel !== undefined ? { optimizer: flags.optimizerModel } : {}),
      ...(flags.targetModel !== undefined ? { target: flags.targetModel } : {}),
      ...(flags.judgeModel !== undefined ? { judge: flags.judgeModel } : {}),
    },
    model_sources: {
      optimizer: input.models.optimizer.source,
      target: input.models.target.source,
      judge: input.models.judge.source,
    },
    ...(input.modelsStrict ? { models_strict: true } : {}),
    ...(input.reflectMaxTokens !== undefined ? { reflect_max_tokens: input.reflectMaxTokens } : {}),
    mode: input.mode,
    dry_run: input.dryRun,
    no_mutate: input.noMutate,
    allow_mutate_bundled: input.allowMutateBundled,
    ...(input.heldOutPath ? { held_out_path: input.heldOutPath } : {}),
    bootstrap_reviewed: input.bootstrapReviewed,
    max_cost_usd: input.maxCostUsd,
    ...(input.maxCostSource ? { max_cost_source: input.maxCostSource } : {}),
    max_runtime_min: input.maxRuntimeMin,
    force: input.force,
  };
}

const optionalString = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** Role models for a job: re-resolved from its flags, or legacy stored models with unknown provenance. */
export async function resolveJobModels(engine: BrainEngine, data: Record<string, unknown>): Promise<SkillOptModels> {
  const flags = data.model_flags;
  if (flags && typeof flags === 'object' && !Array.isArray(flags)) {
    const f = flags as Record<string, unknown>;
    return resolveSkillOptModels(engine, {
      optimizerModel: optionalString(f.optimizer),
      targetModel: optionalString(f.target),
      judgeModel: optionalString(f.judge),
    });
  }
  return unknownProvenanceModels({
    optimizerModel: String(data.optimizer_model ?? TIER_DEFAULTS.deep),
    targetModel: String(data.target_model ?? TIER_DEFAULTS.subagent),
    judgeModel: String(data.judge_model ?? TIER_DEFAULTS.reasoning),
  }, 'legacy job data');
}

export async function skillOptJobOptions(engine: BrainEngine, rawData: unknown): Promise<SkillOptOpts> {
  const data = (rawData ?? {}) as Record<string, unknown>;
  const skillsDir = String(data.skills_dir ?? '');
  const skillName = String(data.skill_name ?? '');
  const benchmarkPath = String(data.benchmark_path ?? '');
  if (!skillsDir || !skillName || !benchmarkPath) {
    throw new Error(`skillopt handler: missing required job.data fields (skills_dir, skill_name, benchmark_path)`);
  }
  const models = await resolveJobModels(engine, data);
  return {
    engine,
    skillName,
    skillsDir,
    benchmarkPath,
    epochs: Number(data.epochs ?? 4),
    batchSize: Number(data.batch_size ?? 8),
    lr: Number(data.lr ?? 4),
    lrSchedule: (data.lr_schedule as 'cosine' | 'linear' | 'constant') ?? 'cosine',
    split: (data.split as [number, number, number]) ?? [4, 1, 5],
    ...skillOptModelOpts(models),
    modelsStrict: data.models_strict === true,
    reflectMaxTokens: clampRemoteReflectMaxTokens(data.reflect_max_tokens),
    mode: (data.mode as 'patch' | 'rewrite') ?? 'patch',
    dryRun: Boolean(data.dry_run),
    noMutate: Boolean(data.no_mutate),
    allowMutateBundled: Boolean(data.allow_mutate_bundled),
    bootstrapReviewed: Boolean(data.bootstrap_reviewed),
    ...(data.held_out_path ? { heldOutPath: String(data.held_out_path) } : {}),
    json: true,
    maxCostUsd: Number(data.max_cost_usd ?? 5.0),
    maxCostSource: data.max_cost_source === 'default' ? 'default' : 'user',
    maxRuntimeMin: Number(data.max_runtime_min ?? 30),
    force: Boolean(data.force),
  };
}

export async function runSkillOptJob(engine: BrainEngine, rawData: unknown, context?: MinionJobContext): Promise<Record<string, unknown>> {
  const data = structuredClone((rawData ?? {}) as Record<string, unknown>);
  if (data.bootstrap_protocol !== undefined) {
    if (!context) throw new Error('skillopt bootstrap job requires its host job context');
    return (await import('./codex-bootstrap-job.ts')).runCodexBootstrapJob(engine, data, context);
  }
  if (data.optimizer_batch_protocol !== undefined) {
    if (!context) throw new Error('skillopt batch job requires its host job context');
    const result = await (await import('./codex-batch-job.ts')).runCodexSkillOptBatchJob(engine, data, context);
    return result;
  }
  const native = !!readPrivateCodexConfig() || data.optimizer_protocol !== undefined || data.shared_skill !== undefined;
  const scope = native ? await (await import('./codex-job.ts')).codexOptimizerJobScope(engine, data, context) : {};
  const result = await runSkillOpt({ ...await skillOptJobOptions(engine, data), ...scope });
  return {
    ...(native ? { cost_usd: null } : {}),
    outcome: result.outcome,
    receipt: result.receipt,
    mutated_skill_file: result.mutatedSkillFile,
    proposed_path: result.proposedPath,
    ...(result.sharedOptimization ? { shared_optimization: result.sharedOptimization } : {}),
  };
}
