import { isQuarantined } from '../quarantine.ts';
import { opError } from '../ops/contract.ts';
import type { BrainEngine } from '../engine.ts';
import { digest } from '../persistence/digest.ts';
import { validateMaintenance, submitMaintenanceIntent, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';

export interface PublicationEvidence { slug: string; id: number; revision: string; excerpt: string }
export interface PublicationPage { slug: string; content: string; expectedRevision: string | null; evidence: PublicationEvidence[] }
export interface PublicationPayload {
  version: 1; authority: MaintenanceAuthority['writer']; pages: PublicationPage[];
  evidence: PublicationEvidence[]; watermark: { key: string; value: string }; skipped: boolean;
}
export interface PublicationPlan { plan_id: string; payload: PublicationPayload; payload_hash: string; state: 'accepted' | 'complete' }
function assertActive(signal?: AbortSignal) {
  signal?.throwIfAborted();
  codexSubscriptionContext()?.signal?.throwIfAborted();
}
const fail = (): never => { throw new CodexProposalError('invalid_output'); };
export function publicationRequestId(planId: string, ordinal: number): string {
  const hex = digest(['codex-publication-v1', planId, ordinal]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function pendingPublication(engine: BrainEngine, authority: MaintenanceAuthority, kind: 'patterns' | 'synthesis'): Promise<PublicationPlan | null> {
  const [plan] = await engine.executeRaw<PublicationPlan>(`SELECT plan_id,payload,payload_hash,state FROM codex_publication_plans
    WHERE source_id=$1 AND source_incarnation=$2 AND kind=$3 AND state='accepted'`,
  [authority.writer.sourceId, authority.writer.sourceIncarnation, kind]);
  if (plan && (digest(plan.payload) !== plan.payload_hash || digest(plan.payload.authority) !== digest(authority.writer))) fail();
  return plan ?? null;
}
/** Bank the entire immutable plan before the first prepared write is admitted. */
export async function retainPublication(engine: BrainEngine, authority: MaintenanceAuthority, kind: 'patterns' | 'synthesis', payload: PublicationPayload, signal?: AbortSignal): Promise<PublicationPlan> {
  assertActive(signal);
  const hash = digest(payload), planId = digest([kind, authority.writer.sourceIncarnation, hash]);
  await engine.transaction(async tx => {
    assertActive(signal);
    await codexSubscriptionContext()?.checkAuthorityInTransaction?.(tx);
    await tx.lockPageKeys([...payload.pages, ...payload.evidence].map(page => ({ sourceId: authority.writer.sourceId, slug: page.slug })));
    await validateMaintenance(tx, authority, payload.evidence[0]!.slug);
    await validatePublicationEvidence(tx, authority.writer.sourceId, payload.evidence);
    for (const page of payload.pages) {
      await validateMaintenance(tx, authority, page.slug);
      const target = await tx.readPageSnapshot(page.slug, { sourceId: authority.writer.sourceId, includeDeleted: true });
      if ((target?.revision ?? null) !== page.expectedRevision) throw opError('revision_conflict', 'Publication target changed.', 'No plan was accepted; propose again from current evidence.');
    }
    // The unique pending slot prevents concurrent runs from publishing different proposals.
    await tx.executeRaw(`INSERT INTO codex_publication_plans(plan_id,source_id,source_incarnation,kind,protocol_version,payload,payload_hash)
      VALUES($1,$2,$3,$4,1,$5::text::jsonb,$6) ON CONFLICT DO NOTHING`,
    [planId, authority.writer.sourceId, authority.writer.sourceIncarnation, kind, JSON.stringify(payload), hash]);
  });
  const [row] = await engine.executeRaw<PublicationPlan>('SELECT plan_id,payload,payload_hash,state FROM codex_publication_plans WHERE plan_id=$1', [planId]);
  if (!row || row.payload_hash !== hash) throw new Error('codex_publication_pending: resume the accepted plan before proposing again');
  return row;
}
/** Per-page receipt coupling is replayable; the batch is deliberately not described as atomic. */
export async function executePublication(engine: BrainEngine, authority: MaintenanceAuthority, plan: PublicationPlan, signal?: AbortSignal): Promise<number> {
  assertActive(signal);
  await codexSubscriptionContext()?.checkAuthority?.();
  const [stored] = await engine.executeRaw<{payload_hash:string;state:string}>(
    'SELECT payload_hash,state FROM codex_publication_plans WHERE plan_id=$1 AND source_id=$2 AND source_incarnation=$3',
    [plan.plan_id, authority.writer.sourceId, authority.writer.sourceIncarnation]);
  if (!stored || stored.payload_hash !== plan.payload_hash) fail();
  if (digest(plan.payload) !== plan.payload_hash || digest(plan.payload.authority) !== digest(authority.writer)) fail();
  if (stored.state === 'complete') return plan.payload.pages.length;
  for (let i = 0; i < plan.payload.pages.length; i++) {
    assertActive(signal);
    await codexSubscriptionContext()?.checkAuthority?.();
    const page = plan.payload.pages[i]!;
    await submitMaintenanceIntent(engine, authority, page.slug, { kind: 'managed_maintenance_codex_page',
      content: page.content, expected_revision: page.expectedRevision, evidence: page.evidence }, publicationRequestId(plan.plan_id, i));
    const receipt = await getWriteRequest(engine, authority.writer.principal, publicationRequestId(plan.plan_id, i));
    if (!receipt || receipt.state !== 'committed') throw new Error('codex_publication_needs_reconciliation');
  }
  await engine.transaction(async tx => {
    assertActive(signal);
    await codexSubscriptionContext()?.checkAuthorityInTransaction?.(tx);
    const [current] = await tx.executeRaw<{state:string;payload_hash:string}>(
      'SELECT state,payload_hash FROM codex_publication_plans WHERE plan_id=$1 FOR UPDATE', [plan.plan_id]);
    if (!current || current.payload_hash !== plan.payload_hash) fail();
    // Concurrent recovery may already have completed this plan and a newer one.
    if (current.state === 'complete') return;
    await validateMaintenance(tx, authority, plan.payload.pages[0]?.slug ?? plan.payload.evidence[0]!.slug);
    // A clean zero still verifies the evidence before advancing its watermark.
    if (plan.payload.skipped) {
      await tx.lockPageKeys(plan.payload.evidence.map(page => ({ sourceId: authority.writer.sourceId, slug: page.slug })));
      await validatePublicationEvidence(tx, authority.writer.sourceId, plan.payload.evidence);
    }
    await tx.setConfig(plan.payload.watermark.key, plan.payload.watermark.value);
    await tx.executeRaw("UPDATE codex_publication_plans SET state='complete',completed_at=now() WHERE plan_id=$1 AND payload_hash=$2", [plan.plan_id, plan.payload_hash]);
  });
  return plan.payload.pages.length;
}
export async function validatePublicationEvidence(engine: BrainEngine, sourceId: string, evidence: PublicationEvidence[]): Promise<void> {
  for (const page of evidence) {
    const current = await engine.readPageSnapshot(page.slug, { sourceId, excludePrivate: true });
    if (!current || current.page.id !== page.id || current.revision !== page.revision ||
      (current.page.frontmatter?.visibility ?? 'world') !== 'world' || isQuarantined(current.page.frontmatter)) throw opError('revision_conflict', 'Publication evidence changed.', 'Resume the retained plan only after inspecting its write receipts.');
  }
}
