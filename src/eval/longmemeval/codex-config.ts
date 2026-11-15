import type { BrainEngine } from '../../core/engine.ts';
import { readPrivateCodexConfig } from '../../core/ai/private-policy.ts';
import { codexSubscriptionContext } from '../../core/ai/subscription-context.ts';
import { resolveModel } from '../../core/model-config.ts';
import { DEFAULT_JUDGE_MODEL } from './judge.ts';

export async function resolveEvalModels(opts: { model?: string; judgeModel: string; judgeConcurrency: number; judge?: boolean; retrievalOnly?: boolean },
  injected: { client?: unknown; extractorClient?: unknown; judgeClient?: unknown; expandFn?: unknown; embedTransport?: unknown; rerankerReadiness?: unknown; configEngine?: BrainEngine }) {
  const privateMode = !!readPrivateCodexConfig(), subscription = codexSubscriptionContext();
  if (privateMode && (injected.client || injected.extractorClient || injected.judgeClient || injected.expandFn || injected.embedTransport || injected.rerankerReadiness || opts.judgeConcurrency !== 1))
    throw new Error('private evaluation requires native role clients, authorized provider transports and sequential judging');
  const engine = privateMode ? subscription?.engine ?? injected.configEngine ?? null : null;
  // CLI parsing always supplies `judge: false` when disabled. An omitted value
  // at this API boundary retains the historical "judge model is in use" contract.
  const judgeActive = opts.judge !== false;
  const judgeModel = privateMode
    ? judgeActive
      ? await resolveModel(engine, {
          privateRole: 'longmemeval-judge', cliFlag: opts.judgeModel || undefined,
          configKey: 'models.eval.longmemeval_judge', tier: 'deep', fallback: DEFAULT_JUDGE_MODEL,
        })
      : opts.judgeModel || DEFAULT_JUDGE_MODEL
    : opts.judgeModel || DEFAULT_JUDGE_MODEL;
  const model = privateMode
    ? opts.retrievalOnly
      ? opts.model || 'sonnet'
      : await resolveModel(engine, {
          privateRole: 'longmemeval-reader', cliFlag: opts.model,
          configKey: 'models.eval.longmemeval', envVar: 'GBRAIN_MODEL', fallback: 'sonnet',
        })
    : await resolveModel(null, {
        cliFlag: opts.model, configKey: 'models.eval.longmemeval',
        envVar: 'GBRAIN_MODEL', fallback: 'sonnet',
      });
  return { model, judgeModel, subscriptionAuthorized: privateMode && !!subscription };
}

export function resolveEvalExtractorModel(cliFlag?: string, configEngine?: BrainEngine): Promise<string> {
  return resolveModel(readPrivateCodexConfig() ? codexSubscriptionContext()?.engine ?? configEngine ?? null : null,
    { privateRole: 'longmemeval-extractor', cliFlag, tier: 'utility', fallback: 'haiku' });
}
