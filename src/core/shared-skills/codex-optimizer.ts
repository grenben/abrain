import { join, resolve } from 'node:path';
import type { SkillOptOpts } from '../skillopt/types.ts';
import type { RunSkillOptResult } from '../skillopt/orchestrator.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { readPrivateCodexConfig } from '../ai/private-policy.ts';
import { configDir } from '../config.ts';
import { digest, requireUuid } from '../persistence/digest.ts';
import { getWriteRequest, assertReplayIntent, intentDigest } from '../persistence/journal.ts';
import { authorizeStoredRequest } from '../persistence/authority.ts';
import { waitForWrite, writeResponse } from '../persistence/service.ts';
import { OperationError } from '../ops/contract.ts';
import { getSharedSkill } from './catalog.ts';
import { prepareSharedOptimizer, authorizeSharedOptimizer, sharedOptimizerSkillsDir } from './optimizer.ts';
import { submitSharedSkillMutation } from './publication.ts';
import { lintCandidate } from '../skillopt/candidate.ts';
import { localOptimizerAllowance } from '../skillopt/codex-local-grant.ts';
import { assertBundledMutationHeldOut } from '../skillopt/bundled-skill-gate.ts';
import { parseBenchmark } from '../skillopt/benchmark.ts';
import { stageSharedOptimizer, readNativeOptimizerFile } from './codex-optimizer-files.ts';
import { claimSharedOptimizer, readSharedOptimizer, fenceSharedOptimizer, releaseSharedOptimizer, saveSharedOptimizerResult, sharedOptimizerConflict, type SharedOptimizerInput } from './codex-optimizer-store.ts';
import { withSharedOptimizerPublication } from './codex-optimizer-publication.ts';

/** Native shared optimization retains one staging plan, result and prepared canonical receipt. */
export async function optimizeCodexSharedSkill(original: SkillOptOpts, run: (opts: SkillOptOpts) => Promise<RunSkillOptResult>): Promise<RunSkillOptResult> {
  const host = codexSubscriptionContext(), policy = readPrivateCodexConfig();
  if (!host || host.engine !== original.engine || !policy || original.operationContext?.remote !== false || original.operationContext.engine !== original.engine || !original.sharedSkill || !original.codex)
    throw new SubscriptionAdmissionError('subscription_required');
  const { engine, operationContext, ...values } = original;
  const target = { ...values.sharedSkill!, request_id: requireUuid(values.sharedSkill!.request_id),
    source_incarnation: requireUuid(values.sharedSkill!.source_incarnation), expected_revision: requireUuid(values.sharedSkill!.expected_revision) };
  const opts: SkillOptOpts = { ...structuredClone(values), sharedSkill: target, engine, operationContext: { ...operationContext! } };
  const ctx = { ...opts.operationContext!, sourceId: target.source_id };
  const controls = { ...structuredClone(values), sharedSkill: target, skillsDir: resolve(opts.skillsDir), benchmarkPath: resolve(opts.benchmarkPath),
    heldOutPath: opts.heldOutPath ? resolve(opts.heldOutPath) : null, localAllowance: localOptimizerAllowance() };
  const prior = await readSharedOptimizer(engine, host.runId);
  let input: SharedOptimizerInput;
  if (prior) {
    input = prior.input;
    if (digest(input.controls) !== digest(controls) || input.model !== policy.model || input.bin !== policy.bin ||
        input.stageRoot !== join(configDir(), 'skillopt-proposals', `codex-${digest(host.runId)}`)) sharedOptimizerConflict();
    await authorizeSharedOptimizer(ctx, opts);
    if (await sharedOptimizerSkillsDir(ctx, target.source_id, target.source_incarnation) !== input.skillsDir) sharedOptimizerConflict();
    const detail = await getSharedSkill(ctx, { ...target, name: opts.skillName, revision: target.expected_revision });
    if (detail.delivery !== 'complete' || detail.body !== input.skillText) sharedOptimizerConflict();
    for (const [i, path] of [opts.benchmarkPath, ...(opts.heldOutPath ? [opts.heldOutPath] : [])].entries())
      if (readNativeOptimizerFile(path).toString('base64') !== input.evaluationInputs[i]) sharedOptimizerConflict();
  } else {
    const prepared = await prepareSharedOptimizer(opts);
    input = { controls, target, stageRoot: join(configDir(), 'skillopt-proposals', `codex-${digest(host.runId)}`),
      files: prepared.files, metadata: prepared.stored!.metadata, skillText: prepared.skill.body,
      evaluationInputs: prepared.evaluationInputs.map(b => b.toString('base64')), mutate: prepared.mutate, bundled: prepared.bundled.isBundled,
      skillsDir: prepared.skillsDir, model: policy.model, bin: policy.bin };
  }
  const heldOut = input.evaluationInputs[1] ? parseBenchmark(Buffer.from(input.evaluationInputs[1], 'base64').toString('utf8'), opts.heldOutPath!, { bootstrapReviewed: true }).tasks : [];
  assertBundledMutationHeldOut({ isBundled: input.bundled, willMutate: input.mutate, heldOutCount: heldOut.length, skillName: opts.skillName });
  if (opts.dryRun) return run({ ...opts, ...stageSharedOptimizer(input), operationContext: ctx, sharedSkill: undefined, noMutate: true });
  const claim = await claimSharedOptimizer(host, input);
  const fence = async (tx: typeof engine) => {
    await fenceSharedOptimizer(tx, host, claim);
    await authorizeSharedOptimizer({ ...ctx, engine: tx }, { ...opts, engine: tx });
    const current = readPrivateCodexConfig(); if (!current || current.model !== policy.model || current.bin !== policy.bin) sharedOptimizerConflict();
  };
  try {
    if (prior?.response) return prior.response;
    const scope = { ...host, checkAuthority: async () => { await host.checkAuthority?.(); await engine.transaction(fence); }, checkAuthorityInTransaction: fence };
    return await withCodexSubscription(scope, async () => {
      const result = prior?.result ?? await run({ ...opts, ...stageSharedOptimizer(input), operationContext: ctx, sharedSkill: undefined, noMutate: true });
      await engine.transaction(async tx => { await fence(tx); await saveSharedOptimizerResult(tx, claim, result); });
      const response: RunSkillOptResult = { ...result, mutatedSkillFile: false, sharedOptimization: { proposal_id: target.request_id } };
      if (input.mutate && result.outcome === 'accepted' && result.finalText !== input.skillText) {
        lintCandidate(input.skillText, result.finalText);
        const saved = await readSharedOptimizer(engine, host.runId);
        if (saved?.admission) {
          const a = saved.admission, request = await getWriteRequest(engine, a.principal, a.requestId!);
          if (!request) sharedOptimizerConflict();
          assertReplayIntent(request!, intentDigest(a)); await authorizeStoredRequest(engine, request!);
          response.sharedOptimization!.publication = writeResponse(await waitForWrite(engine, request!, ctx.config, ctx.writeWaitMs));
        } else {
          const files = input.files.map(file => ({ ...file, encoding: 'base64' as const,
            content: file.path === `skills/${opts.skillName}/SKILL.md` ? Buffer.from(result.finalText).toString('base64') : file.content }));
          response.sharedOptimization!.publication = await withSharedOptimizerPublication({ engine, claim, fence }, () =>
            submitSharedSkillMutation(ctx, 'put_skill', { ...target, name: opts.skillName, files, description: input.metadata.description,
              triggers: input.metadata.triggers, requirements: input.metadata.requirements, private: input.metadata.private }));
        }
        if (response.sharedOptimization!.publication!.state !== 'committed')
          throw new OperationError('write_pending', 'The optimized skill requires publication reconciliation.', 'Inspect the retained write receipt and retry this same optimizer request; do not regenerate content.');
        response.mutatedSkillFile = true;
      }
      await engine.transaction(async tx => { await fence(tx); await saveSharedOptimizerResult(tx, claim, response, true); });
      return response;
    });
  } finally { await releaseSharedOptimizer(host, claim); }
}
