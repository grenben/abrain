import { expect, test } from 'bun:test';
import { isNonFatalPrivateThinkWarning, type ThinkGatherWarning } from '../src/core/think/gather.ts';

test('private think permits only intentional embedding opt-out and an empty keyword result', () => {
  const warning = (stage: string, reason: string): ThinkGatherWarning => ({
    code: `GATHER_DEGRADED:${stage}`,
    stage,
    reason,
  });

  expect(isNonFatalPrivateThinkWarning(warning('embed_unavailable', 'embedding_disabled'))).toBe(true);
  expect(isNonFatalPrivateThinkWarning(warning('keyword_zero', 'no_matches'))).toBe(true);
  expect(isNonFatalPrivateThinkWarning(warning('embed_unavailable', 'no_provider'))).toBe(false);
  expect(isNonFatalPrivateThinkWarning(warning('embed_unavailable', 'no_provider'), {
    auxiliaryEmbeddingCompleted: true,
  })).toBe(true);
  expect(isNonFatalPrivateThinkWarning(warning('embed_timeout', 'timeout'))).toBe(false);
  expect(isNonFatalPrivateThinkWarning(warning('takes_keyword', 'retrieval_failed'))).toBe(false);
});
