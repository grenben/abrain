/** Keep orchestrator summaries inside a configured non-default namespace. */
export function buildDreamSummarySlug(outputRoot: string, summaryDate: string): string {
  return outputRoot === 'wiki'
    ? `dream-cycle-summaries/${summaryDate}`
    : `${outputRoot}/dream-cycle-summaries/${summaryDate}`;
}
