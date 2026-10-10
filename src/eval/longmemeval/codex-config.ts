import { readPrivateCodexConfig } from '../../core/ai/private-policy.ts';
import { codexSubscriptionContext } from '../../core/ai/subscription-context.ts';
import { resolveModel } from '../../core/model-config.ts';
import { DEFAULT_JUDGE_MODEL } from './judge.ts';

export async function resolveEvalModels(opts: { model?: string; judgeModel: string; judgeConcurrency: number },
  injected: { client?: unknown; extractorClient?: unknown; judgeClient?: unknown }) {
  const privateMode = !!readPrivateCodexConfig(), subscription = codexSubscriptionContext();
  if (privateMode && (injected.client || injected.extractorClient || injected.judgeClient || opts.judgeConcurrency !== 1))
    throw new Error('private evaluation requires the native role clients and sequential judging');
  const engine = privateMode ? subscription?.engine ?? null : null;
  const judgeModel = privateMode ? await resolveModel(engine, {
    cliFlag: opts.judgeModel || undefined, configKey: 'models.eval.longmemeval_judge', tier: 'deep', fallback: DEFAULT_JUDGE_MODEL,
  }) : opts.judgeModel || DEFAULT_JUDGE_MODEL;
  const model = await resolveModel(engine, { cliFlag: opts.model, configKey: 'models.eval.longmemeval', envVar: 'GBRAIN_MODEL', fallback: 'sonnet' });
  return { model, judgeModel, subscriptionAuthorized: privateMode && !!subscription };
}

export function resolveEvalExtractorModel(cliFlag?: string): Promise<string> {
  return resolveModel(readPrivateCodexConfig() ? codexSubscriptionContext()?.engine ?? null : null,
    { cliFlag, tier: 'utility', fallback: 'haiku' });
}
