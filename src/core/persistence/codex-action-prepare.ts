import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { WriteRequest } from './model.ts';
import type { ClaimPhaseClock } from './claim-phase.ts';
import { preparePageMutation } from './page-prepare.ts';
import { authorizeStoredRequest } from './authority.ts';
import type { CodexWriteBinding } from './codex-action-guard.ts';
import { OperationError } from '../ops/contract.ts';

/** Preserve normal untrusted put_page semantics, with the host's observed revision. */
export async function prepareCodexActionPage(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, signal?: AbortSignal, clock?: ClaimPhaseClock) {
  await authorizeStoredRequest(engine, row);
  const expected = (row.intent?.codex_action as CodexWriteBinding).expectedRevision;
  const check = async (tx: BrainEngine) => {
    const snapshot = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
    if ((snapshot?.revision ?? null) !== expected) throw new OperationError('concurrent_write', 'The Codex action target changed after its retained read.', 'Read the current revision and submit a new action; this proposal was not applied.');
  };
  await check(engine);
  const prepared = await preparePageMutation(engine, row, config, undefined, signal, { coordinated: true, clock });
  const validate = prepared.validate;
  return { ...prepared, validate: async (tx: BrainEngine) => { await check(tx); await validate?.(tx); } };
}
