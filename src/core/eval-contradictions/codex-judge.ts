import type { ChatOpts } from '../ai/gateway.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';

export const CODEX_CONTRADICTION_JUDGE_VERSION = 'codex-contradiction-judge-v1';

const VERDICTS = [
  'no_contradiction', 'contradiction', 'temporal_supersession',
  'temporal_regression', 'temporal_evolution', 'negation_artifact',
] as const;
const SEVERITIES = ['info', 'low', 'medium', 'high'] as const;
const RESOLUTIONS = [
  'takes_supersede', 'dream_synthesize', 'takes_mark_debate', 'manual_review',
  'temporal_supersede', 'flag_for_review', 'log_timeline_change',
] as const;

/** Both quotes must be exact spans of the bounded statements sent to Codex. */
export function privateContradictionJudgeSchema(a: string, b: string): NonNullable<ChatOpts['responseSchema']> {
  if (a.trim().length < 4 || b.trim().length < 4 || a.length > 8192 || b.length > 8192) {
    throw new CodexProposalError('invalid_input');
  }
  return {
    name: CODEX_CONTRADICTION_JUDGE_VERSION,
    schema: {
      type: 'object', additionalProperties: false,
      required: ['verdict', 'severity', 'axis', 'confidence', 'resolution_kind', 'source_quote_a', 'source_quote_b'],
      properties: {
        verdict: { type: 'string', enum: [...VERDICTS] },
        severity: { type: 'string', enum: [...SEVERITIES] },
        axis: { type: 'string', maxLength: 160 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        resolution_kind: { anyOf: [{ type: 'null' }, { type: 'string', enum: [...RESOLUTIONS] }] },
        source_quote_a: { type: 'string', minLength: 4, maxLength: 300 },
        source_quote_b: { type: 'string', minLength: 4, maxLength: 300 },
      },
    },
    validateCodexProposal: text => {
      const value = JSON.parse(text) as Record<string, unknown>;
      const qa = value.source_quote_a, qb = value.source_quote_b;
      if (typeof qa !== 'string' || typeof qb !== 'string' || !qa.trim() || !qb.trim() ||
          !a.includes(qa) || !b.includes(qb) ||
          (value.verdict === 'contradiction' && Number(value.confidence) < 0.7) ||
          (value.verdict === 'no_contradiction' && (value.axis !== '' || value.resolution_kind !== null))) {
        throw new CodexProposalError('invalid_output');
      }
    },
  };
}
