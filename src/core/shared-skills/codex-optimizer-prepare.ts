import { join, resolve } from 'node:path';
import type { SkillOptOpts } from '../skillopt/types.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { privatePolicyBinding, privatePolicyMatchesBinding, readPrivateCodexConfig } from '../ai/private-policy.ts';
import { configDir } from '../config.ts';
import { digest, requireUuid } from '../persistence/digest.ts';
import { getSharedSkill } from './catalog.ts';
import { prepareSharedOptimizer, authorizeSharedOptimizer, sharedOptimizerSkillsDir } from './optimizer.ts';
import { localOptimizerAllowance } from '../skillopt/codex-local-grant.ts';
import { preflightNativeOptimizer } from '../skillopt/codex-preflight.ts';
import { readNativeOptimizerFile } from './codex-optimizer-files.ts';
import { readSharedOptimizer, sharedOptimizerConflict, type SharedOptimizerInput } from './codex-optimizer-store.ts';

/** Queue identity excludes host-selected staging location, never the approved content or controls. */

export async function prepareCodexSharedSkill(original: SkillOptOpts) {
  const host = codexSubscriptionContext(), policy = readPrivateCodexConfig();
  const benchmarkPath = original.benchmarkPath;
  if (!host || host.engine !== original.engine || !policy || original.operationContext?.remote !== false || original.operationContext.engine !== original.engine ||
      !original.sharedSkill || !original.codex || !benchmarkPath)
    throw new SubscriptionAdmissionError('subscription_required');
  const { engine, operationContext, codexExpectedInputHash, ...values } = original;
  const target = { ...values.sharedSkill!, request_id: requireUuid(values.sharedSkill!.request_id),
    source_incarnation: requireUuid(values.sharedSkill!.source_incarnation), expected_revision: requireUuid(values.sharedSkill!.expected_revision) };
  const opts: SkillOptOpts = { ...structuredClone(values), benchmarkPath, sharedSkill: target, engine, operationContext: { ...operationContext! } };
  const ctx = { ...opts.operationContext!, sourceId: target.source_id };
  const controls = { ...structuredClone(values), sharedSkill: target, skillsDir: resolve(opts.skillsDir), benchmarkPath: resolve(benchmarkPath),
    heldOutPath: opts.heldOutPath ? resolve(opts.heldOutPath) : null, localAllowance: localOptimizerAllowance() };
  const prior = await readSharedOptimizer(engine, host.runId);
  let input: SharedOptimizerInput;
  if (prior) {
    input = prior.input;
    if (digest(input.controls) !== digest(controls) || !privatePolicyMatchesBinding(policy, input) ||
        input.stageRoot !== join(configDir(), 'skillopt-proposals', `codex-${digest(host.runId)}`)) sharedOptimizerConflict();
    await authorizeSharedOptimizer(ctx, opts);
    if (await sharedOptimizerSkillsDir(ctx, target.source_id, target.source_incarnation) !== input.skillsDir) sharedOptimizerConflict();
    const detail = await getSharedSkill(ctx, { ...target, name: opts.skillName, revision: target.expected_revision });
    if (detail.delivery !== 'complete' || detail.body !== input.skillText) sharedOptimizerConflict();
    for (const [i, path] of [benchmarkPath, ...(opts.heldOutPath ? [opts.heldOutPath] : [])].entries())
      if (readNativeOptimizerFile(path).toString('base64') !== input.evaluationInputs[i]) sharedOptimizerConflict();
  } else {
    const prepared = await prepareSharedOptimizer(opts);
    input = { controls, target, stageRoot: join(configDir(), 'skillopt-proposals', `codex-${digest(host.runId)}`),
      files: prepared.files, metadata: prepared.stored!.metadata, skillText: prepared.skill.body,
      evaluationInputs: prepared.evaluationInputs.map(b => b.toString('base64')), mutate: prepared.mutate, bundled: prepared.bundled.isBundled,
      skillsDir: prepared.skillsDir, ...privatePolicyBinding(policy) };
  }
  const { cap, modelsPlan, strict } = await preflightNativeOptimizer({ ...opts, operationContext: ctx, sharedSkill: undefined }, {
    skillText: input.skillText, benchmarkText: Buffer.from(input.evaluationInputs[0]!, 'base64').toString('utf8'), benchmarkPath,
    heldOutText: input.evaluationInputs[1] ? Buffer.from(input.evaluationInputs[1], 'base64').toString('utf8') : null,
    heldOutPath: opts.heldOutPath ?? null, bundled: input.bundled, mutate: input.mutate,
  }, policy);
  const { stageRoot, ...snapshot } = input, inputHash = digest({ snapshot, cap, modelsPlan, strict });
  if (codexExpectedInputHash !== undefined && inputHash !== codexExpectedInputHash) sharedOptimizerConflict();
  return { host, policy, opts, ctx, input, inputHash, prior, target, engine, source: { incarnation: target.source_incarnation } };
}
