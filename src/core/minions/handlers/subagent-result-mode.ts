import type { SubagentHandlerData, SubagentResult, OneshotFallbackReason } from '../types.ts';

export function stampSubagentResultMode(data: SubagentHandlerData, inner: SubagentResult, modeState: {
  fallbackReason?: OneshotFallbackReason; oneshotTokens?: {in:number;out:number;cache_read:number;cache_create:number};
}): SubagentResult {
    // #4216: stamp which execution path produced the result. Jobs with no
    // `mode` field keep the legacy result shape (REGRESSION pin).
    // Honesty rule: 'agentic_fallback' is stamped ONLY when the oneshot
    // attempt actually ran and returned a fallback reason this invocation. A
    // replayed already-successful oneshot job (messages persisted, outcome
    // write lost) re-enters via the loop replay path with no marker — leaving
    // synth_mode_used unset there is honest 'unknown/replay', never a fake
    // fallback in phase telemetry.
    return data.mode === 'oneshot' && inner.synth_mode_used !== 'oneshot' && modeState.fallbackReason
      ? {
          ...inner,
          synth_mode_used: 'agentic_fallback',
          fallback_reason: modeState.fallbackReason,
          // The PAID oneshot attempt is part of this job's real cost/turn
          // count — fold it into the rollup instead of silently dropping a
          // full model call from details.synthesis math.
          ...(modeState.oneshotTokens
            ? {
                turns_count: inner.turns_count + 1,
                tokens: {
                  in: inner.tokens.in + modeState.oneshotTokens.in,
                  out: inner.tokens.out + modeState.oneshotTokens.out,
                  cache_read: inner.tokens.cache_read + modeState.oneshotTokens.cache_read,
                  cache_create: inner.tokens.cache_create + modeState.oneshotTokens.cache_create,
                },
              }
            : {}),
        }
      : data.mode === 'agentic' && !inner.synth_mode_used
        ? { ...inner, synth_mode_used: 'agentic' }
        : inner;
}
