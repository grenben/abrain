import type { SkillOptOpts } from '../skillopt/types.ts';
import type { RunSkillOptResult } from '../skillopt/orchestrator.ts';
import { withCodexSubscription } from '../ai/subscription-context.ts';
import { privatePolicyFingerprint, readPrivateCodexConfig } from '../ai/private-policy.ts';
import { getWriteRequest, assertReplayIntent, intentDigest } from '../persistence/journal.ts';
import { authorizeStoredRequest } from '../persistence/authority.ts';
import { waitForWrite, writeResponse } from '../persistence/service.ts';
import { OperationError } from '../ops/contract.ts';
import { authorizeSharedOptimizer } from './optimizer.ts';
import { submitSharedSkillMutation } from './publication.ts';
import { lintCandidate } from '../skillopt/candidate.ts';
import { stageSharedOptimizer } from './codex-optimizer-files.ts';
import { claimSharedOptimizer, readSharedOptimizer, fenceSharedOptimizer, releaseSharedOptimizer, saveSharedOptimizerResult, sharedOptimizerConflict } from './codex-optimizer-store.ts';
import { withSharedOptimizerPublication } from './codex-optimizer-publication.ts';
import { prepareCodexSharedSkill } from './codex-optimizer-prepare.ts';

/** Native shared optimization retains one staging plan, result and prepared canonical receipt. */
export async function optimizeCodexSharedSkill(original: SkillOptOpts, run: (opts: SkillOptOpts) => Promise<RunSkillOptResult>): Promise<RunSkillOptResult> {
  const { host, policy, opts, ctx, input, prior, target, engine } = await prepareCodexSharedSkill(original);
  if (opts.dryRun) return run({ ...opts, ...stageSharedOptimizer(input), operationContext: ctx, sharedSkill: undefined, noMutate: true });
  const claim = await claimSharedOptimizer(host, input);
  const fence = async (tx: typeof engine) => {
    await fenceSharedOptimizer(tx, host, claim);
    await authorizeSharedOptimizer({ ...ctx, engine: tx }, { ...opts, engine: tx });
    const current = readPrivateCodexConfig(); if (!current || privatePolicyFingerprint(current) !== privatePolicyFingerprint(policy)) sharedOptimizerConflict();
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
