import { randomUUID } from 'node:crypto';
import { isWriteRequestId } from './persistence/types.ts';
import type { BrainEngine } from './engine.ts';
import type { OperationContext } from './ops/contract.ts';
import { OperationError } from './ops/contract.ts';
import type { ProposalActionTarget, ProposalEdits, TakeProposalRow } from './take-proposals.ts';
import type { WriteRequest } from './persistence/model.ts';
import { digest, sha256 } from './persistence/digest.ts';
import { inlineTruthBody } from './page-body/page-shape.ts';
import { assertReplayIntent, intentDigest } from './persistence/journal.ts';
import { submissionAuthority } from './persistence/authority.ts';
import { initializeLocalPersistence } from './persistence/page-mutations.ts';

export interface CodexTakeAcceptance { version: 1; requestId: string; proposalHash: string; params: Record<string, unknown> }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const conflict = (): never => { throw new OperationError('idempotency_conflict', 'The proposal acceptance inputs differ from the retained plan.', 'Resume with the original inputs and inspect any existing write receipt before changing the proposal.'); };
const invalid = (): never => { throw new OperationError('invalid_params', 'The Codex proposal evidence or retained acceptance plan is incomplete.', 'Review the proposal and its existing write receipts; do not replay uncertain effects.'); };

/** A private proposal remains private-protocol data even after private inference is disabled. */
export function codexTakeAcceptance(target: ProposalActionTarget, proposal: TakeProposalRow, edits: ProposalEdits): CodexTakeAcceptance | undefined {
  if (!proposal.model_id.startsWith('codex-cli:') && !proposal.prompt_version?.startsWith('codex-take-proposals-v1:') && proposal.codex_evidence == null) return undefined;
  const e = proposal.codex_evidence;
  if (!record(e) || e.version !== 1 || !isWriteRequestId(e.source_incarnation) ||
    !isWriteRequestId(e.page_revision) ||
    !record(e.principal) || typeof e.principal.id !== 'string' || !e.principal.id ||
    typeof e.subscription_run_id !== 'string' || !e.subscription_run_id ||
    typeof e.source_quote !== 'string' || e.source_quote.length < 8 || e.source_quote.length > 4000 ||
    typeof proposal.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(proposal.content_hash)) invalid();
  const { acceptance: retained, ...evidence } = e!;
  const proposalHash = digest({ id: proposal.id, sourceId: proposal.source_id, slug: proposal.page_slug,
    claim: proposal.claim_text, kind: proposal.kind, holder: proposal.holder, weight: proposal.weight, domain: proposal.domain,
    hash: proposal.content_hash, version: proposal.prompt_version, model: proposal.model_id, evidence });
  if (retained !== undefined) {
    if (!record(retained) || retained.version !== 1 || !isWriteRequestId(retained.requestId) || retained.proposalHash !== proposalHash || !record(retained.params)) conflict();
    const plan = retained as unknown as CodexTakeAcceptance;
    const p = plan.params;
    const keys = new Set(['slug', 'source_id', 'claim', 'kind', 'holder', 'weight', 'source', 'expected_revision', 'expected_source_incarnation', 'codex_proposal_hash', 'local_dir']);
    if (Object.keys(p).some(key => !keys.has(key)) || typeof p.claim !== 'string' || !p.claim.trim() ||
      !['fact', 'take', 'bet', 'hunch'].includes(String(p.kind)) || typeof p.holder !== 'string' || !p.holder.trim() ||
      typeof p.weight !== 'number' || !Number.isFinite(p.weight) || p.weight < 0 || p.weight > 1 ||
      (p.local_dir !== undefined && typeof p.local_dir !== 'string')) conflict();
    if (p.slug !== proposal.page_slug || p.source_id !== proposal.source_id || p.expected_revision !== e!.page_revision ||
      p.expected_source_incarnation !== e!.source_incarnation || p.codex_proposal_hash !== proposalHash ||
      ![`take_proposals#${proposal.id}`, `take_proposals#${proposal.id} (edited)`].includes(String(p.source))) conflict();
    for (const key of ['claim', 'kind', 'holder', 'weight'] as const) if (edits[key] !== undefined && edits[key] !== p[key]) conflict();
    if (target.localDir !== undefined && target.localDir !== p.local_dir) conflict();
    return plan;
  }
  if (proposal.status !== 'pending') invalid();
  const edited = Object.values(edits).some(value => value !== undefined);
  return { version: 1, requestId: randomUUID(), proposalHash, params: {
    slug: proposal.page_slug, source_id: proposal.source_id, claim: edits.claim ?? proposal.claim_text,
    kind: edits.kind ?? proposal.kind, holder: edits.holder ?? proposal.holder, weight: edits.weight ?? proposal.weight,
    source: `take_proposals#${proposal.id}${edited ? ' (edited)' : ''}`,
    expected_revision: e!.page_revision, expected_source_incarnation: e!.source_incarnation, codex_proposal_hash: proposalHash,
    ...(target.localDir === undefined ? {} : { local_dir: target.localDir }),
  } };
}

/** Only before new admission: a committed receipt may have changed this page itself. */
export async function validateCodexTakeInput(engine: BrainEngine, proposal: TakeProposalRow, plan: CodexTakeAcceptance): Promise<void> {
  const snapshot = await engine.readPageSnapshot(proposal.page_slug, { sourceId: proposal.source_id });
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1', [proposal.source_id]);
  if (!source || source.archived || source.incarnation !== plan.params.expected_source_incarnation ||
    !snapshot || snapshot.page.deleted_at || snapshot.sourceIncarnation !== source.incarnation) {
    throw new OperationError('source_changed', 'The proposal source is no longer the accepted source.', 'Review the current source before extracting a new proposal.');
  }
  // Acceptance must recheck the retained quote against the snapshot overlay.
  // Proposal discovery supplies only inline bodies; a segmented replacement
  // refuses explicitly before a whole-body read.
  const body = inlineTruthBody(snapshot.page, 'private take acceptance');
  const evidence = proposal.codex_evidence as Record<string, unknown>;
  if (snapshot.revision !== plan.params.expected_revision || sha256(body) !== proposal.content_hash ||
    !body.includes(evidence.source_quote as string)) {
    throw new OperationError('revision_conflict', 'The proposal input changed before acceptance.', 'Review the current page and generate a fresh proposal; the old evidence was not silently reinterpreted.');
  }
}

/** Digest survives intent compaction; retries never infer edits from the current proposal. */
export async function validateCodexTakeReceipts(ctx: OperationContext, proposal: TakeProposalRow,
  plan: CodexTakeAcceptance, receipts: WriteRequest[]): Promise<void> {
  if (!receipts.length) return;
  await initializeLocalPersistence(ctx);
  await submissionAuthority(ctx, 'takes_add', proposal.source_id, String(plan.params.expected_source_incarnation), proposal.page_slug);
  for (const row of receipts) {
    if (row.request_id !== plan.requestId || row.operation !== 'takes_add' || row.source_id !== proposal.source_id || row.slug !== proposal.page_slug ||
      row.source_incarnation !== plan.params.expected_source_incarnation) conflict();
    assertReplayIntent(row, intentDigest({ operation: 'takes_add', sourceId: proposal.source_id, slug: proposal.page_slug, callerIntent: plan.params }));
  }
}
