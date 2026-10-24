import { readPrivateCodexConfig } from '../../core/ai/private-policy.ts';
import { codexSubscriptionContext } from '../../core/ai/subscription-context.ts';
import { resolveModel } from '../../core/model-config.ts';
import { DEFAULT_JUDGE_MODEL } from './judge.ts';

export async function resolveEvalModels(opts: { model?: string; judgeModel: string; judgeConcurrency: number; judge?: boolean; retrievalOnly?: boolean },
  injected: { client?: unknown; extractorClient?: unknown; judgeClient?: unknown; expandFn?: unknown; embedTransport?: unknown; rerankerReadiness?: unknown }) {
  const privateMode = !!readPrivateCodexConfig(), subscription = codexSubscriptionContext();
  if (privateMode && (injected.client || injected.extractorClient || injected.judgeClient || injected.expandFn || injected.embedTransport || injected.rerankerReadiness || opts.judgeConcurrency !== 1))
    throw new Error('private evaluation requires native role clients, authorized provider transports and sequential judging');
  const engine = privateMode ? subscription?.engine ?? null : null;
  const judgeModel = privateMode ? await resolveModel(engine, {
    // An unused judge pin is metadata, not permission to dispatch.
    privateRole: opts.judge === false ? undefined : 'longmemeval-judge', cliFlag: opts.judgeModel || undefined, configKey: 'models.eval.longmemeval_judge', tier: 'deep', fallback: DEFAULT_JUDGE_MODEL,
  }) : opts.judgeModel || DEFAULT_JUDGE_MODEL;
  const model = await resolveModel(engine, { privateRole: opts.retrievalOnly ? undefined : 'longmemeval-reader', cliFlag: opts.model, configKey: 'models.eval.longmemeval', envVar: 'GBRAIN_MODEL', fallback: 'sonnet' });
  return { model, judgeModel, subscriptionAuthorized: privateMode && !!subscription };
}

export function resolveEvalExtractorModel(cliFlag?: string): Promise<string> {
  return resolveModel(readPrivateCodexConfig() ? codexSubscriptionContext()?.engine ?? null : null,
    { privateRole: 'longmemeval-extractor', cliFlag, tier: 'utility', fallback: 'haiku' });
}
