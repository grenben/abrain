import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { CodexProposalError } from './codex-contract.ts';

/**
 * Intentionally empty until a pinned official build proves pre-execution denial,
 * including hook failure, inherited configuration, instructions and hosted tools.
 * Help flags and post-hoc JSONL rejection do not establish that property.
 */
const QUALIFIED_SHA256 = new Set<string>();
const fixtures = new Map<string, string>();
/** Test fixture registration, never called by production source. No real runtime is approved by tests. */
export function __registerCodexFixtureForTests(path: string, sha256: string): () => void {
  fixtures.set(path, sha256);
  return () => { fixtures.delete(path); };
}
export async function assertCodexRuntimeQualified(bin: string): Promise<void> {
  if (!QUALIFIED_SHA256.size && !fixtures.has(bin)) throw new CodexProposalError('runtime_unqualified');
  const hash = createHash('sha256');
  try { for await (const chunk of createReadStream(bin)) hash.update(chunk); }
  catch { throw new CodexProposalError('runtime_unqualified'); }
  const sha256 = hash.digest('hex');
  if (!QUALIFIED_SHA256.has(sha256) && fixtures.get(bin) !== sha256) throw new CodexProposalError('runtime_unqualified');
}
