import { withPrivateRoleScope } from '../ai/private-role-scope.ts';
import type { BrainEngine } from '../engine.ts';
import type { RunThinkOpts, ThinkResponse, ThinkResult } from './index.ts';
import type { ThinkGatherResult } from './gather.ts';
import { chat } from '../ai/gateway.ts';
import { readPrivateCodexConfig, PrivateRoutingError, privateModelForTier, privateModelForRole } from '../ai/private-policy.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { hasAIInvocationGuard, withAIInvocationPreflight, isAIInvocationPolicyError } from '../ai/invocation-guard.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { digest } from '../persistence/digest.ts';
import { PAGE_SLUG_SEG } from '../cjk.ts';
import { OperationError } from '../ops/contract.ts';
import { loadConfigSnapshot } from '../config-snapshot.ts';
import { pickDecideConfig, readDecideConfig } from '../ai/decide/config.ts';

/** Preserve the host's auxiliary USD guard; subscription consent alone cannot pay for retrieval. */
export async function withPrivateThink(engine: BrainEngine, opts: RunThinkOpts, run: () => Promise<ThinkResult>): Promise<ThinkResult> {
  const policy = readPrivateCodexConfig();
  if (!policy) return run();
  const role = opts.privateRole ?? 'think';
  if (!['think', 'auto-think', 'calibration-think-ab'].includes(role)) throw new CodexProposalError('invalid_input');
  privateModelForRole(policy, role);
  return withPrivateRoleScope([role], async () => {
  const context = codexSubscriptionContext();
  if (!context) throw new SubscriptionAdmissionError('subscription_required');
  if (!opts.question.trim() || opts.question.length > 16000 || opts.stubResponse || opts.client ||
    opts.allowedSources?.length === 0 || opts.allowedSources && opts.allowedSources.length > 20 ||
    opts.rounds !== undefined && (!Number.isSafeInteger(opts.rounds) || opts.rounds < 1 || opts.rounds > 8)) throw new CodexProposalError('invalid_input');
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const [admitted] = await context.engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  if (!brain || brain.brain_id !== admitted?.brain_id) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  await context.checkAuthority?.();
  if (context.signal?.aborted) throw new CodexProposalError('aborted');
  const decide = readDecideConfig(pickDecideConfig(await loadConfigSnapshot(engine)) ?? {});
  const classifierModel = privateModelForTier(policy, 'utility');
  if (Object.values(decide.slots).some(slot => slot.mode !== 'off' && slot.provider !== `llm:${classifierModel}`) ||
    decide.egressFallback !== 'none' && decide.egressFallback !== `llm:${classifierModel}`)
    throw new PrivateRoutingError('think:decide.slots');
  const auxiliaryAuthorized = hasAIInvocationGuard();
  let denied: SubscriptionAdmissionError | undefined;
  const result = await withAIInvocationPreflight(async call => {
    if (denied) throw denied;
    if ((call.kind === 'embedding' || call.kind === 'rerank') && !auxiliaryAuthorized) {
      denied = new SubscriptionAdmissionError('subscription_auxiliary_budget_required'); throw denied;
    }
  }, () => import('./publication.ts').then(module => module.retainPrivateThink(engine, opts, run)));
  if (denied) throw denied;
  return result;
  });
}

const citationKey = (c: { page_slug: string; row_num: number | null }) => `${c.page_slug}#${c.row_num ?? '_'}`;
/** Native response transport plus closure over the actual bounded retrieval evidence. */
export async function proposeCodexThink(input: { privateRole?: RunThinkOpts['privateRole']; model: string; system: string; prompt: string; gather: ThinkGatherResult }) {
  if (Buffer.byteLength(input.system + input.prompt, 'utf8') > 131072) throw new CodexProposalError('invalid_input');
  const evidenceHash = digest({ system: input.system, prompt: input.prompt });
  const pages = new Set([...input.gather.pages.map(p => p.slug), ...input.gather.graphSlugs]);
  const takes = new Set(input.gather.takes.map(t => citationKey({ page_slug: t.page_slug, row_num: t.row_num })));
  const sources = new Map<string, Set<number>>();
  for (const page of input.gather.pages) {
    const set = sources.get(page.slug) ?? new Set<number>(); set.add(page.page_id); sources.set(page.slug, set);
  }
  for (const take of input.gather.takes) {
    const set = sources.get(take.page_slug) ?? new Set<number>(); set.add(take.page_id); sources.set(take.page_slug, set);
  }
  const result = await chat({ privateRole: input.privateRole ?? 'think', model: input.model, allowFallback: false, timeoutMs: 120000, maxTokens: 4096,
    system: input.system, messages: [{ role: 'user', content: input.prompt }], responseSchema: {
      name: 'codex-think-v1', schema: { type: 'object', additionalProperties: false, required: ['evidence_hash','answer','citations','gaps'], properties: {
        evidence_hash: { type: 'string', enum: [evidenceHash] }, answer: { type: 'string', maxLength: 24000 },
        citations: { type: 'array', maxItems: 80, items: { type: 'object', additionalProperties: false,
          required: ['page_slug','row_num','citation_index'], properties: { page_slug: { type: 'string', minLength: 1, maxLength: 300 },
            row_num: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1 }] }, citation_index: { type: 'integer', minimum: 1, maximum: 80 } } } },
        gaps: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 1000 } },
      } }, validateCodexProposal: text => {
        const value = JSON.parse(text) as ThinkResponse;
        const inline = privateInlineCitations(value.answer), seen = new Set<string>();
        if (value.gaps.some(gap => !gap.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(gap)) ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.answer) || inline.length !== value.citations.length ||
          value.answer.trim() && pages.size + takes.size > 0 && !value.citations.length) throw new CodexProposalError('invalid_output');
        for (const [index, citation] of value.citations.entries()) {
          const key = citationKey(citation);
          if (seen.has(key) || citation.citation_index !== index+1 || citationKey(inline[index]!) !== key ||
            (sources.get(citation.page_slug)?.size ?? 0) > 1 ||
            (citation.row_num === null ? !pages.has(citation.page_slug) : !takes.has(key))) throw new CodexProposalError('invalid_output');
          seen.add(key);
        }
      },
    },
  });
  return { response: JSON.parse(result.text) as ThinkResponse, usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens } };
}

/** Required private retrieval failures cannot turn into an apparently complete answer. */
export function rethrowPrivateThinkFailure(error: unknown): void {
  if (!readPrivateCodexConfig()) return;
  if (error instanceof OperationError || error instanceof CodexProposalError || error instanceof SubscriptionAdmissionError || error instanceof PrivateRoutingError || isAIInvocationPolicyError(error)) throw error;
  throw new OperationError('retrieval_failed', 'Private think could not read required evidence.', 'Retry after the retrieval failure is resolved.');
}

/** Match the canonical Unicode slug grammar, keeping first-appearance citation order. */
function privateInlineCitations(answer: string): Array<{page_slug:string;row_num:number|null}> {
  const pattern = new RegExp(String.raw`\[(${PAGE_SLUG_SEG}(?:/${PAGE_SLUG_SEG})*)(?:#(\d+))?\]`, 'giu');
  const seen = new Set<string>(), citations: Array<{page_slug:string;row_num:number|null}> = [];
  for (const match of answer.matchAll(pattern)) {
    const citation = { page_slug: match[1]!.toLowerCase(), row_num: match[2] ? Number(match[2]) : null };
    const key = citationKey(citation); if (!seen.has(key)) { seen.add(key); citations.push(citation); }
  }
  return citations;
}
