import type { BrainEngine } from './engine.ts';
import type { ProposalActionTarget, TakeProposalRow } from './take-proposals.ts';
import { OperationError, type OperationContext } from './ops/contract.ts';
import type { WriteRequest } from './persistence/model.ts';
import { digest } from './persistence/digest.ts';
import { admitWriteInTransaction } from './persistence/journal.ts';
import { preparePageAdmission } from './persistence/page-mutations.ts';
import { assertPersistenceAccepting, waitForWrite, writeResponse } from './persistence/service.ts';
import { declareDurablePersistence } from './persistence/protocol.ts';
import { codexTakeAcceptance, validateCodexTakeInput, validateCodexTakeReceipts, type CodexTakeAcceptance } from './take-proposal-codex-plan.ts';

const receipts = (engine: BrainEngine, plan: CodexTakeAcceptance) => engine.executeRaw<WriteRequest>(
  'SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [plan.requestId]);
const uncertain = (): never => { throw new OperationError('write_pending', 'The retained proposal acceptance has no unique write receipt.',
  'Inspect the proposal and its persistence requests before reconciliation; an uncertain acceptance is never submitted again.'); };
function samePlan(expected: CodexTakeAcceptance, actual: CodexTakeAcceptance | undefined): asserts actual is CodexTakeAcceptance {
  if (!actual || actual.proposalHash !== expected.proposalHash || digest(actual.params) !== digest(expected.params)) {
    throw new OperationError('idempotency_conflict', 'The proposal changed while it was being accepted.', 'Inspect the retained proposal and resume its original acceptance inputs.');
  }
}

/** Claim, frozen reviewer inputs and journal admission commit together, before any effect.
 * The proposal row lock serializes distinct local writer identities too. Once admitted,
 * every retry reconciles that receipt; it never re-admits a failed or ambiguous write.
 */
export async function acceptCodexTakeProposal(target: ProposalActionTarget, proposal: TakeProposalRow,
  plan: CodexTakeAcceptance): Promise<{ proposal: TakeProposalRow; rowNum: number }> {
  const ctx: OperationContext = { engine: target.engine, config: target.config, remote: false, sourceId: proposal.source_id,
    dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  assertPersistenceAccepting(ctx.engine);
  let canonical = plan;
  let row: WriteRequest;
  if (proposal.status === 'accepted') {
    const prior = await receipts(ctx.engine, plan);
    if (prior.length !== 1) uncertain();
    await validateCodexTakeReceipts(ctx, proposal, plan, prior);
    row = prior[0]!;
  } else {
    await validateCodexTakeInput(ctx.engine, proposal, plan);
    const prepared = await preparePageAdmission(ctx, { operation: 'takes_add', params: { ...plan.params, request_id: plan.requestId } });
    if (prepared.prior) uncertain(); // A fresh host-generated identity cannot already belong to another request.
    row = await ctx.engine.transaction(async tx => {
      await declareDurablePersistence(tx);
      const [raw] = await tx.executeRaw<TakeProposalRow>('SELECT * FROM take_proposals WHERE id=$1 FOR UPDATE', [proposal.id]);
      if (!raw || !['pending', 'accepted'].includes(raw.status)) {
        throw new OperationError('invalid_params', 'The proposal is no longer available for acceptance.', 'Read the proposal queue before accepting another proposal.');
      }
      const current = { ...raw, id: Number(raw.id), weight: Number(raw.weight) };
      // Compare against the original snapshot, including evidence, and the frozen reviewer inputs.
      const retained = codexTakeAcceptance(target, current, { claim: String(plan.params.claim), kind: String(plan.params.kind),
        holder: String(plan.params.holder), weight: Number(plan.params.weight) });
      // On a pending row, preserve the original edited/source marker when comparing snapshots.
      if (current.status === 'pending' && retained) retained.params.source = plan.params.source;
      samePlan(plan, retained);
      canonical = retained;
      if (current.status === 'accepted') {
        const prior = await receipts(tx, retained);
        if (prior.length !== 1) uncertain();
        await validateCodexTakeReceipts({ ...ctx, engine: tx }, current, retained, prior);
        return prior[0]!;
      }
      canonical = plan;
      await tx.executeRaw(`UPDATE take_proposals SET status='accepted',acted_at=now(),acted_by=$2,
        codex_evidence=jsonb_set(codex_evidence,'{acceptance}',$3::text::jsonb) WHERE id=$1`,
      [proposal.id, target.actedBy ?? 'cli', JSON.stringify(plan)]);
      return admitWriteInTransaction(tx, prepared.admission!);
    });
  }
  const settled = await waitForWrite(ctx.engine, row, ctx.config);
  await validateCodexTakeReceipts(ctx, proposal, canonical, [settled]);
  const response = writeResponse(settled); // Pending, refused or failed publication never becomes accepted completion.
  const rowNum = Number(response.row_num);
  if (!Number.isSafeInteger(rowNum) || rowNum < 1) uncertain();
  await stampCompletion(ctx, target, proposal, canonical, settled, rowNum);
  return { proposal, rowNum };
}

/** Completion metadata must still name the proposal reviewed before the committed effect. */
async function stampCompletion(ctx: OperationContext, target: ProposalActionTarget, proposal: TakeProposalRow,
  plan: CodexTakeAcceptance, settled: WriteRequest, rowNum: number): Promise<void> {
  await ctx.engine.transaction(async tx => {
    await declareDurablePersistence(tx);
    const [raw] = await tx.executeRaw<TakeProposalRow>('SELECT * FROM take_proposals WHERE id=$1 FOR UPDATE', [proposal.id]);
    if (!raw || raw.status !== 'accepted') uncertain();
    const current = { ...raw, id: Number(raw.id), weight: Number(raw.weight) };
    const retained = codexTakeAcceptance(target, current, {});
    samePlan(plan, retained);
    await validateCodexTakeReceipts({ ...ctx, engine: tx }, current, retained, [settled]);
    await tx.executeRaw('UPDATE take_proposals SET promoted_row_num=$2 WHERE id=$1', [proposal.id, rowNum]);
  });
}
