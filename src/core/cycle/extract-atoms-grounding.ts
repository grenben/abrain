import { normalizeForGrounding } from './synthesize-verify.ts';

/**
 * #4706 — locate a model-returned quote inside the text it was extracted from.
 *
 * This is the provenance step, and it runs at EXTRACTION because the
 * alternative — matching a stored quote back to its source LATER — is not
 * solvable: a passage and its negation ("would not improve" vs "would
 * improve") are ~99% similar, so no after-the-fact matcher can tell which one
 * an atom came from, and picking wrong writes a reversed claim into the
 * brain. At extraction there is no such ambiguity: we know exactly which text
 * was sent to the model, so the question collapses to "is this string in the
 * text we just handed it?" — a fact rather than a guess.
 *
 * Folding rides `normalizeForGrounding` — the v0.47.8.0 quote-repair core in
 * synthesize-verify.ts (the "ONE folding core" invariant: this module must
 * mean the same thing by "normalized substring" as the repair ladder does).
 * Everything is decided in FOLDED space, including uniqueness: a typographic
 * twin ('“go now”' vs '"go now"') is only visible there, and returning an
 * offset that might name the wrong passage is worse than returning none.
 *
 * Fail-closed on ambiguity: candidates are validated by a round-trip re-fold
 * (folding is lossy and one-to-many — '…' → '...' — so a folded hit can land
 * part-way through one original character), THEN counted. Zero or 2+ valid
 * passages → null; a truncated scan (MAX_CANDIDATES exhausted with hits
 * pending) is UNPROVEN uniqueness → null.
 *
 * Returns ORIGINAL-text offsets, or null when the model paraphrased.
 */
export function locateQuote(
  content: string,
  quote: string,
): { start: number; end: number } | null {
  if (!quote || !content) return null;
  const c = normalizeForGrounding(content);
  const q = normalizeForGrounding(quote);
  if (!q.norm) return null;

  // Enumerate every folded hit, keep those that survive the round-trip
  // boundary check, THEN judge ambiguity. Order matters: rejecting on raw
  // hit-count first would let an INVALID partial-character match veto a
  // genuinely unique valid one ("No. First. No… not ever" has two folded
  // hits for "no." but only the first is character-aligned).
  const valid: Array<{ start: number; end: number }> = [];
  const MAX_CANDIDATES = 8; // pathological input shouldn't scan a whole book
  let at = c.norm.indexOf(q.norm);
  let seen = 0;
  while (at !== -1 && seen < MAX_CANDIDATES) {
    seen++;
    const start = c.map[at]!;
    // map[] names the FIRST code unit of the original character; advance the
    // end by the whole code point, not +1 — a bare +1 splits the surrogate
    // pair when the quote ends with a non-BMP char ('ship it 🚀'), and the
    // half-pair slice then fails the round-trip re-fold below.
    const lastOrig = c.map[at + q.norm.length - 1]!;
    const lastCp = content.codePointAt(lastOrig);
    const end = lastOrig + (lastCp !== undefined && lastCp > 0xffff ? 2 : 1);
    if (
      normalizeForGrounding(content.slice(start, end)).norm === q.norm &&
      !valid.some(v => v.start === start && v.end === end)
    ) {
      valid.push({ start, end });
    }
    // Step by one, not by length: overlapping hits are distinct passages
    // for ambiguity purposes.
    at = c.norm.indexOf(q.norm, at + 1);
  }
  // Cap exhausted with hits still pending: uniqueness UNPROVEN → fail closed.
  if (at !== -1) return null;
  // Exactly one surviving passage, or we cannot say which the atom used.
  if (valid.length !== 1) return null;
  return valid[0]!;
}
