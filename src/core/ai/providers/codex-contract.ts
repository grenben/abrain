/** Stable, content-free failure codes; provider output is never an error message. */
export type CodexProposalFailure =
  | 'unsupported_schema' | 'invalid_input' | 'spawn' | 'stdin' | 'exit'
  | 'missing_completion' | 'malformed_lifecycle' | 'refusal' | 'provider_failure'
  | 'native_action' | 'invalid_output' | 'output_limit' | 'timeout' | 'aborted'
  | 'termination_unconfirmed' | 'unsupported_platform' | 'runtime_unqualified';

export class CodexProposalError extends Error {
  /** Local process-group settlement only; it does not prove remote completion. */
  readonly settled: boolean;
  terminalCompletion?: {usage:CodexUsage|null};
  constructor(readonly reason: CodexProposalFailure) {
    super(`codex-cli proposal failed: ${reason}`);
    this.name = 'CodexProposalError';
    this.settled = reason !== 'termination_unconfirmed';
  }
}

/** Closed host-owned diagnostics: never accept a field value or provider text. */
const validationCodes = [
  'extractor_empty_entity', 'extractor_empty_text', 'extractor_source_quote', 'extractor_entity_quote',
  'extractor_invalid_date', 'extractor_unanchored_date', 'extractor_claim_kind', 'extractor_metric_name',
  'extractor_metric_value', 'extractor_numeric_quote', 'extractor_event_name', 'extractor_event_value',
  'extractor_empty_unit', 'extractor_empty_period', 'extractor_duplicate_claim',
] as const;
export type CodexValidationCode = typeof validationCodes[number];
export class CodexValidationError extends CodexProposalError {
  readonly validationCode?: CodexValidationCode;
  constructor(code: CodexValidationCode) {
    super('invalid_output');
    // Runtime validation also covers JS callers and tampered exceptions.
    if ((validationCodes as readonly unknown[]).includes(code)) this.validationCode = code;
  }
}

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export const CODEX_PROPOSAL_LIMITS = Object.freeze({
  promptBytes: 200_000, schemaBytes: 65_536, outputBytes: 2_000_000,
  imageBytes: 8_000_000, totalImageBytes: 16_000_000, images: 4,
  imagePixels: 16_000_000, timeoutMs: 120_000, maxTimeoutMs: 600_000,
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
