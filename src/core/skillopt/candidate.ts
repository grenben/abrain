import { opError } from '../ops/contract.ts';
import { splitFrontmatter } from './apply-edits.ts';

export function lintCandidate(before: string, after: string): void {
  const original = splitFrontmatter(before), candidate = splitFrontmatter(after);
  if (!candidate.body.trim() || after.includes('\0') || before.slice(0, original.bodyStart) !== after.slice(0, candidate.bodyStart)) {
    throw opError('skill_candidate_invalid', 'The optimized candidate changed protected frontmatter or has an empty/invalid body.',
      'The optimizer\'s candidate was not published; the retained proposal (named in detail) shows what it produced. Ask the user before running the paid optimization again.');
  }
  let fence: { character: string; length: number } | null = null;
  for (const line of candidate.body.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (!fence) fence = { character: match[1][0], length: match[1].length };
    else if (match[1][0] === fence.character && match[1].length >= fence.length && !match[2].trim()) fence = null;
  }
  if (fence) {
    throw opError('skill_candidate_invalid', 'The optimized candidate contains an unclosed Markdown code fence.',
      'The optimizer\'s candidate was not published; the retained proposal (named in detail) shows the unclosed fence. Ask the user before running the paid optimization again.');
  }
}
