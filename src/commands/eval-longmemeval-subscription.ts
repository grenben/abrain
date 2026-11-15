import type { BrainEngine } from '../core/engine.ts';
import { readPrivateCodexConfig } from '../core/ai/private-policy.ts';
import { codexSubscriptionContext } from '../core/ai/subscription-context.ts';
import { reconfigureGatewayWithEngine } from '../core/ai/gateway.ts';
import { usageError } from '../cli/cli-error.ts';
import { runEvalLongMemEval, parseLongMemEvalArgs } from './eval-longmemeval.ts';
import { splitEvalAllowance } from '../eval/longmemeval/codex-allowance-flags.ts';
import { withLocalEvalAllowance } from '../eval/longmemeval/codex-local-grant.ts';
import { configureEvalGateway } from '../eval/shared/gateway-bootstrap.ts';
import { finishCliTeardown } from '../core/cli-force-exit.ts';
import { resolveEvalExtractorModel, resolveEvalModels } from '../eval/longmemeval/codex-config.ts';
import { makeGatewayThinkClient } from '../eval/longmemeval/gateway-client.ts';
import * as retrievalArms from '../eval/longmemeval/retrieval-arms.ts';

const PRIVATE_EVAL_SCHEMA_VERSION = 329;

/** CLI-only gateway bootstrap and ownership teardown, kept outside the dispatcher. */
export async function runConfiguredLocalLongMemEval(args: string[], connect: () => Promise<BrainEngine>): Promise<void> {
  if (!args.includes('--help') && !args.includes('-h')) configureEvalGateway();
  return runLocalLongMemEval(args,async()=>{
    const engine=await connect();
    return {engine,close:()=>finishCliTeardown({engine})};
  });
}

/** The dispatcher supplies the selected local owner. No implicit schema migration or service startup. */
export async function runLocalLongMemEval(args: string[], connect: () => Promise<{ engine: BrainEngine; close(): Promise<void> }>): Promise<void> {
  const split=splitEvalAllowance(args), parsed=parseLongMemEvalArgs(split.args);
  if (parsed.help) return runEvalLongMemEval(split.args,{exitOnError:false});
  const privateMode=!!readPrivateCodexConfig(), parent=codexSubscriptionContext();
  if (split.allowance && (!privateMode || parent)) throw usageError('A new Codex allowance requires local strict private mode and no enclosing grant.', 'Use the enclosing host allowance without additional Codex flags.');
  if (!privateMode || parent) return runEvalLongMemEval(split.args,{exitOnError:false});
  const needsResources=!parsed.retrievalOnly || !parsed.keywordOnly || !parsed.noTrajectory || parsed.judge || !!parsed.arms.factKeys;
  if (!split.allowance) {
    if (needsResources) throw usageError('Private evaluation requires an explicit subscription allowance.', 'Supply --codex-max-attempts, --codex-max-turns and --codex-deadline. Paid retrieval additionally needs --aux-max-usd.');
    return runEvalLongMemEval(split.args,{exitOnError:false});
  }
  if (!parsed.datasetPath) throw usageError('An evaluation dataset is required.', 'Supply the local dataset path before authorizing a run.');
  const owner=await connect();
  try {
    const version=await owner.engine.getConfig('version');
    if (!version || !/^\d+$/.test(version) || Number(version)<PRIVATE_EVAL_SCHEMA_VERSION) throw usageError(`Private evaluation requires the registered v${PRIVATE_EVAL_SCHEMA_VERSION} schema.`, 'Upgrade the selected host schema explicitly before retrying. This command does not apply migrations.');
    await reconfigureGatewayWithEngine(owner.engine);
    await resolveEvalModels(parsed, { configEngine: owner.engine });
    if (!parsed.noTrajectory) await resolveEvalExtractorModel(undefined, owner.engine);
    if (parsed.arms.factKeys) await retrievalArms.resolveFactKeyArm(parsed.arms, makeGatewayThinkClient(), parsed.keywordOnly, owner.engine);
    await withLocalEvalAllowance(owner.engine,split.allowance,()=>runEvalLongMemEval(split.args,{exitOnError:false}));
  } finally { await owner.close(); }
}
