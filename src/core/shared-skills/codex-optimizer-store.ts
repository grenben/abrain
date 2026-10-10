import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SqlEngine } from '../persistence/model.ts';
import type { WriteAdmission } from '../persistence/journal.ts';
import type { CodexSubscriptionContext } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { digest, jsonBytes } from '../persistence/digest.ts';
import { ensureLocalOptimizerGrant } from '../skillopt/codex-local-grant.ts';
import type { RunSkillOptResult } from '../skillopt/orchestrator.ts';
import type { StoredSkillFile, SkillMetadata } from './model.ts';
import type { SkillOptOpts } from '../skillopt/types.ts';
export interface SharedOptimizerInput {
  controls: Record<string, unknown>; target: NonNullable<SkillOptOpts['sharedSkill']>; stageRoot: string;
  files: StoredSkillFile[]; metadata: SkillMetadata; skillText: string; evaluationInputs: string[];
  mutate: boolean; bundled: boolean; skillsDir: string; model: string; bin: string;
}
export interface SharedOptimizerRow {
  run_id: string; request_id: string; protocol: number; input: SharedOptimizerInput; input_hash: string;
  owner_token: string | null; lease_until: Date | string | null; publication_fence: CodexSubscriptionContext['publicationFence'] | null;
  result: RunSkillOptResult | null; result_hash: string | null; admission: WriteAdmission | null; admission_hash: string | null;
  response: RunSkillOptResult | null; response_hash: string | null;
}
export interface SharedOptimizerClaim { runId: string; token: string; inputHash: string }
export const sharedOptimizerConflict = (): never => { throw new SubscriptionAdmissionError('subscription_identity_conflict'); };
export async function readSharedOptimizer(engine: SqlEngine, runId: string): Promise<SharedOptimizerRow | undefined> {
  const [row] = await engine.executeRaw<SharedOptimizerRow>('SELECT * FROM codex_shared_skill_optimizations WHERE run_id=$1', [runId]);
  if (row && (row.protocol !== 1 || digest(row.input) !== row.input_hash ||
      row.result && digest(row.result) !== row.result_hash || row.admission && digest(row.admission) !== row.admission_hash ||
      row.response && digest(row.response) !== row.response_hash)) sharedOptimizerConflict();
  return row;
}
export async function claimSharedOptimizer(host: CodexSubscriptionContext, input: SharedOptimizerInput): Promise<SharedOptimizerClaim> {
  if (jsonBytes(input) > 2097152) sharedOptimizerConflict();
  await host.checkAuthority?.(); host.signal?.throwIfAborted();
  const token = randomUUID(), hash = digest(input);
  await host.engine.transaction(async tx => {
    await declareDurablePersistence(tx); await host.checkAuthorityInTransaction?.(tx); await ensureLocalOptimizerGrant(tx, host.runId);
    const [grant] = await tx.executeRaw<{ parent_run_id: string | null }>('SELECT parent_run_id FROM codex_subscription_runs WHERE run_id=$1 FOR UPDATE', [host.runId]);
    if (!grant || grant.parent_run_id) throw new SubscriptionAdmissionError('subscription_required');
    await tx.executeRaw(`INSERT INTO codex_shared_skill_optimizations(run_id,request_id,protocol,input,input_hash)
      VALUES($1,$2::uuid,1,$3::text::jsonb,$4) ON CONFLICT DO NOTHING`, [host.runId, input.target.request_id, JSON.stringify(input), hash]);
    const revisions = await tx.executeRaw(`SELECT revision FROM shared_skill_revisions WHERE source_id=$1 AND source_incarnation=$2::uuid
      AND pack_id=$3 AND name=$4 AND revision=$5::uuid FOR KEY SHARE`,
      [input.target.source_id, input.target.source_incarnation, input.target.pack_id, input.controls.skillName, input.target.expected_revision]);
    if (revisions.length !== 1) sharedOptimizerConflict();
    const prior = await readSharedOptimizer(tx, host.runId);
    if (!prior || prior.input_hash !== hash) sharedOptimizerConflict();
    const rows = await tx.executeRaw(`UPDATE codex_shared_skill_optimizations SET owner_token=$2::uuid,lease_until=now()+interval '15 minutes',publication_fence=$3::text::jsonb
      WHERE run_id=$1 AND (owner_token IS NULL OR lease_until<now()) RETURNING run_id`, [host.runId, token, JSON.stringify(host.publicationFence ?? null)]);
    if (rows.length !== 1) throw new SubscriptionAdmissionError('subscription_owner_lost');
  });
  return { runId: host.runId, token, inputHash: hash };
}
export async function fenceSharedOptimizer(tx: BrainEngine, host: CodexSubscriptionContext, claim: SharedOptimizerClaim): Promise<void> {
  await declareDurablePersistence(tx); host.signal?.throwIfAborted(); await host.checkAuthorityInTransaction?.(tx);
  const rows = await tx.executeRaw(`UPDATE codex_shared_skill_optimizations SET lease_until=now()+interval '15 minutes'
    WHERE run_id=$1 AND input_hash=$2 AND owner_token=$3::uuid AND lease_until>now() RETURNING run_id`, [claim.runId, claim.inputHash, claim.token]);
  if (rows.length !== 1) throw new SubscriptionAdmissionError('subscription_owner_lost');
}
export async function saveSharedOptimizerResult(tx: BrainEngine, claim: SharedOptimizerClaim, result: RunSkillOptResult, response = false): Promise<void> {
  if (jsonBytes(result) > 524288) sharedOptimizerConflict();
  const row = await readSharedOptimizer(tx, claim.runId), existing = response ? row?.response : row?.result;
  if (existing && digest(existing) !== digest(result)) sharedOptimizerConflict();
  const column = response ? 'response' : 'result';
  await tx.executeRaw(`UPDATE codex_shared_skill_optimizations SET ${column}=$2::text::jsonb,${column}_hash=$3 WHERE run_id=$1 AND owner_token=$4::uuid`,
    [claim.runId, JSON.stringify(result), digest(result), claim.token]);
}
export async function releaseSharedOptimizer(host: CodexSubscriptionContext, claim: SharedOptimizerClaim): Promise<void> {
  await host.engine.transaction(async tx => { await declareDurablePersistence(tx);
    await tx.executeRaw('UPDATE codex_shared_skill_optimizations SET owner_token=NULL,lease_until=NULL WHERE run_id=$1 AND owner_token=$2::uuid', [claim.runId, claim.token]); });
}
