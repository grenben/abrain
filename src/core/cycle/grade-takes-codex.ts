import { getChatModel } from '../ai/gateway.ts';
import { splitProviderModelId } from '../model-id.ts';
import type { BrainEngine } from '../engine.ts';
import type { ChatOpts } from '../ai/gateway.ts';
import { readPrivateCodexConfig, assertPrivateRoute, resolvePrivateModel, privateModelForRole, privatePolicyFingerprint } from '../ai/private-policy.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';

export const CODEX_GRADE_VERSION = 'codex-grounded-grade-v1';

/** Check every explicit judge pin before reading a cached verdict or making a call. */
export async function privateGradeMode(engine: BrainEngine, model: string, ensemble?: Array<{modelId: string}>): Promise<boolean> {
  const policy = readPrivateCodexConfig();
  if (!policy) return false;
  assertPrivateRoute(model, 'grade_takes.model', policy);
  await resolvePrivateModel(engine, { privateRole: 'take-grading', cliFlag: model, tier: 'utility', fallback: 'unused' }, policy);
  for (const judge of ensemble ?? []) assertPrivateRoute(judge.modelId, 'grade_takes.ensemble.model', policy, 'take-grading');
  return true;
}

export function codexGradeSchema(evidence: string): ChatOpts['responseSchema'] {
  if (!readPrivateCodexConfig()) return undefined;
  return { name: CODEX_GRADE_VERSION, schema: {
    type: 'object', properties: {
      verdict: { type: 'string', enum: ['correct', 'incorrect', 'partial', 'unresolvable'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reasoning: { type: 'string', minLength: 1, maxLength: 400 },
      evidence_quotes: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 1000 },
        description: 'Distinct exact quotations from EVIDENCE supporting the verdict. A resolved verdict requires at least one quotation.' },
    }, required: ['verdict', 'confidence', 'reasoning', 'evidence_quotes'], additionalProperties: false,
  }, validateCodexProposal: text => {
    const value = JSON.parse(text) as { verdict: string; reasoning: string; evidence_quotes: string[] };
    if (!value.reasoning.trim() || (value.verdict !== 'unresolvable' && value.evidence_quotes.length === 0) ||
      new Set(value.evidence_quotes).size !== value.evidence_quotes.length ||
      value.evidence_quotes.some(quote => !quote.trim() || !evidence.includes(quote))) throw new CodexProposalError('invalid_output');
  } };
}

/** Subscription calls share one durable account lane. Never dispatch an ensemble in parallel. */
export async function sequentialJudges<T>(calls: Array<() => Promise<T>>): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  for (const call of calls) {
    try { results.push({ status: 'fulfilled', value: await call() }); }
    catch (reason) { results.push({ status: 'rejected', reason }); break; }
  }
  return results;
}

/** One resolved model drives inference, budget admission and versioned cache identity. */
export async function resolveGradeIdentity(engine: BrainEngine, model: string | undefined,
  ensemble: Array<{modelId: string}> | undefined, version: string) {
  const policy = readPrivateCodexConfig();
  const judgeModelFull = model ?? (policy ? privateModelForRole(policy, 'take-grading') : getChatModel());
  const privateMode = await privateGradeMode(engine, judgeModelFull, ensemble);
  // Preserve legacy cache keys; subscription budgeting requires the provider prefix.
  const judgeModelId = privateMode ? judgeModelFull : splitProviderModelId(judgeModelFull).model || judgeModelFull;
  return { judgeModelFull, judgeModelId, privateMode,
    promptVersion: privateMode ? `${CODEX_GRADE_VERSION}:${version}:${privatePolicyFingerprint(policy!)}` : version };
}
