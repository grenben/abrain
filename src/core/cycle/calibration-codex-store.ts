import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import type { WriteAuthority } from '../persistence/model.ts';
import { initializeLocalPersistence } from '../persistence/page-mutations.ts';
import { submissionAuthority, authorizeWrite } from '../persistence/authority.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { calibrationPack, calibrationFingerprint, type CalibrationData } from './calibration-codex-data.ts';
import type { CalibrationFact, CalibrationProposal } from './calibration-codex-proposal.ts';

export interface CalibrationBinding { sourceId: string; incarnation: string; writer: WriteAuthority }
export interface PrivateProfile { id: string | number; total_resolved: number; brier: number | null; pattern_statements: string[];
  active_bias_tags: string[]; voice_gate_attempts: number; codex_evidence: { request_hash: string; source_incarnation: string } }
export async function calibrationTransaction<T>(ctx: OperationContext, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
  await initializeLocalPersistence(ctx);
  return maintenanceTransaction(ctx.engine, async original => {
    const tx = new Proxy(original, { get(target, key) {
      if (key === 'executeRaw') return (sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) => {
        const signal = codexSubscriptionContext()?.signal;
        if (signal?.aborted) throw new CodexProposalError('aborted');
        return target.executeRaw(sql, params, { ...opts, signal: signal ?? opts?.signal });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await declareDurablePersistence(tx);
    await codexSubscriptionContext()?.checkAuthorityInTransaction?.(tx);
    return run(tx);
  });
}
export async function bindCalibration(ctx: OperationContext, sourceId: string): Promise<CalibrationBinding> {
  const [source] = await ctx.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived FOR SHARE', [sourceId]);
  if (!source) throw new OperationError('source_changed', 'The calibration source is not active.', 'Review the source before retrying.');
  const writer = await submissionAuthority(ctx, 'submit_job', sourceId, source.incarnation, '');
  // A source-wide aggregate requires a source-wide local grant.
  if (writer.remote || writer.excludePrivate || writer.slugPrefixes !== null && !writer.slugPrefixes.includes('*')) {
    throw new OperationError('permission_denied', 'Calibration requires access to the complete source.', 'Use a local writer authorized to aggregate this source.');
  }
  return { sourceId, incarnation: source.incarnation, writer };
}
export async function readPrivateProfile(tx: BrainEngine, binding: CalibrationBinding, holder: string, runId: string, requestHash: string): Promise<PrivateProfile | undefined> {
  const [profile] = await tx.executeRaw<PrivateProfile>(`SELECT id,total_resolved,brier,pattern_statements,active_bias_tags,voice_gate_attempts,codex_evidence
    FROM calibration_profiles WHERE source_id=$1 AND holder=$2 AND codex_evidence->>'subscription_run_id'=$3`, [binding.sourceId,holder,runId]);
  if (profile && (profile.codex_evidence.request_hash !== requestHash || profile.codex_evidence.source_incarnation !== binding.incarnation)) {
    throw new OperationError('idempotency_conflict', 'Calibration request inputs differ from the retained profile.', 'Reconcile the existing profile; use a separately admitted run for new inputs.');
  }
  return profile;
}
export async function recheckCalibrationAuthority(ctx: OperationContext, tx: BrainEngine, binding: CalibrationBinding): Promise<void> {
  const live = await bindCalibration({ ...ctx, engine: tx }, binding.sourceId);
  if (live.incarnation !== binding.incarnation) throw new OperationError('source_changed', 'The calibration source was replaced.', 'Review the new source before generating another profile.');
  await authorizeWrite(tx, binding.writer, 'submit_job', '', true);
}
export async function persistPrivateProfile(ctx: OperationContext, input: { binding: CalibrationBinding; holder: string; runId: string; requestHash: string;
  data: CalibrationData; model: string; gradeCompletion: number; proposal: CalibrationProposal; facts: CalibrationFact[]; attempts: number; version: string; packIdentity: string }) {
  return calibrationTransaction(ctx, async tx => {
    const { binding, data } = input;
    await recheckCalibrationAuthority(ctx, tx, binding);
    const prior = await readPrivateProfile(tx, binding, input.holder, input.runId, input.requestHash);
    if (prior) return { profile: prior, cacheHit: true };
    const pack = await calibrationPack({ ...ctx, engine: tx }, binding.sourceId);
    if (pack.identity !== input.packIdentity) throw new OperationError('revision_conflict', 'The calibration pack changed.', 'Retry with the current pack.');
    if (data.fingerprint !== await calibrationFingerprint(tx, binding.sourceId, input.holder)) {
      throw new OperationError('revision_conflict', 'Calibration evidence changed before persistence.', 'Retry with a fresh source snapshot.');
    }
    const evidence = { version: input.version, request_hash: input.requestHash, subscription_run_id: input.runId,
      source_incarnation: binding.incarnation, principal: binding.writer.principal, pack_identity: input.packIdentity,
      snapshot_hash: data.fingerprint, scorecard: data.scorecard, mean_confidence: data.meanConfidence, facts: input.facts, proposal: input.proposal };
    const s = data.scorecard;
    const inserted = await tx.executeRaw<{ id: string }>(`INSERT INTO calibration_profiles(source_id,holder,published,total_resolved,brier,accuracy,partial_rate,grade_completion,
      domain_scorecards,pattern_statements,voice_gate_passed,voice_gate_attempts,active_bias_tags,model_id,cost_usd,judge_model_agreement,codex_evidence)
      VALUES($1,$2,false,$3,$4,$5,$6,$7,$8::text::jsonb,$9::text[],true,$10,$11::text[],$12,NULL,NULL,$13::text::jsonb)
      ON CONFLICT DO NOTHING RETURNING id`, [binding.sourceId,input.holder,s.resolved,s.brier,s.accuracy,s.partial_rate,input.gradeCompletion,
      JSON.stringify(data.domains),input.proposal.patterns.map(p => p.statement),input.attempts,[...new Set(input.proposal.patterns.flatMap(p => p.bias_tag ? [p.bias_tag] : []))],input.model,JSON.stringify(evidence)]);
    const profile = await readPrivateProfile(tx, binding, input.holder, input.runId, input.requestHash);
    if (!profile) throw new OperationError('storage_error', 'Calibration persistence did not return its receipt.', 'Inspect the profile before retrying the same run.');
    return { profile, cacheHit: inserted.length === 0 };
  });
}
