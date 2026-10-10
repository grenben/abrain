import type { BrainEngine } from '../engine.ts';
import type { ThinkEvidence } from '../think/publication-model.ts';
import { validateThinkEvidence } from '../think/publication-evidence.ts';
import type { ThinkResult } from '../think/index.ts';
import type { CalibrationProfileRow } from '../../commands/calibration.ts';
import { getLatestProfile } from '../../commands/calibration.ts';
import type { WriteAuthority } from '../persistence/model.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { codexSubscriptionContext, type CodexSubscriptionContext } from '../ai/subscription-context.ts';
import { digest, jsonBytes } from '../persistence/digest.ts';
import { OperationError } from '../ops/contract.ts';
export type ABPreference = 'baseline' | 'with_calibration' | 'neither' | 'tie';
export type ABTrialAnswer = ThinkResult & {
    comparison_evidence: ThinkEvidence[];
};
export interface ABTrial {
    trial_id: string;
    run_id: string;
    source_id: string;
    source_incarnation: string;
    input_hash: string;
    binding: {
        question: string;
        holder: string;
        model: string;
        profile: CalibrationProfileRow;
        authority: WriteAuthority;
        fence?: CodexSubscriptionContext['publicationFence'];
    };
    baseline: ABTrialAnswer | null;
    calibrated: ABTrialAnswer | null;
    result_id: string | null;
    state: 'accepted' | 'ready' | 'rated';
}
export const abConflict = (): never => { throw new OperationError('idempotency_conflict', 'The A/B trial differs from its retained request.', 'Resume the original trial without changing its source, question, profile, model or allowance.'); };
export async function readTrial(engine: BrainEngine, id: string, sourceId: string, lock = false): Promise<ABTrial> {
    const [row] = await engine.executeRaw<ABTrial>(`SELECT * FROM codex_think_ab_trials WHERE trial_id=$1::uuid AND source_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, sourceId]);
    if (!row)
        throw new OperationError('not_found', 'A/B trial not found in this source.', 'Use the original trial ID and source.');
    return row!;
}
export async function authorizeTrial(engine: BrainEngine, trial: ABTrial, generation: boolean): Promise<void> {
    if (generation) {
        const context = codexSubscriptionContext();
        if (!context || context.runId !== trial.run_id)
            abConflict();
        context!.signal?.throwIfAborted();
        await context!.checkAuthorityInTransaction?.(engine);
        const fence = trial.binding.fence;
        if (fence) {
            const [job] = await engine.executeRaw<{
                data: unknown;
                submission_authority: unknown;
            }>("SELECT data,submission_authority FROM minion_jobs WHERE id=$1 AND lock_token=$2 AND status='active' AND lock_until>now() FOR SHARE", [fence.jobId, fence.lockToken]);
            if (!job || digest({ data: job.data, authority: job.submission_authority }) !== fence.jobDigest)
                throw new OperationError('write_claim_lost', 'The A/B trial no longer owns its worker lease.', 'Reconcile the retained trial before changing its worker.');
        }
    }
    const [source] = await engine.executeRaw<{
        incarnation: string;
    }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived FOR SHARE', [trial.source_id]);
    if (source?.incarnation !== trial.source_incarnation)
        abConflict();
    await authorizeWrite(engine, trial.binding.authority, 'submit_job', '', true);
    if (!generation)
        return;
    if (trial.baseline)
        await validateThinkEvidence(engine, trial.baseline.comparison_evidence);
    const profile = await getLatestProfile(engine, { holder: trial.binding.holder, sourceId: trial.source_id });
    if (digest(profile) !== digest(trial.binding.profile))
        throw new OperationError('revision_conflict', 'The calibration profile changed during the trial.', 'Retain this trial for inspection; start a new comparison with the current profile.');
}
export async function checkTrialGeneration(engine: BrainEngine, trial: ABTrial): Promise<void> {
    await engine.transaction(async (tx) => { await declareDurablePersistence(tx); await authorizeTrial(tx, trial, true); });
}
export async function saveTrialAnswer(engine: BrainEngine, trial: ABTrial, side: 'baseline' | 'calibrated', result: ABTrialAnswer): Promise<void> {
    if (result.synthesisOk !== true || result.synthesis_status !== 'ok' || !result.answer.trim() || result.modelUsed !== trial.binding.model || !result.codex_evidence_hash || jsonBytes(result) > 524288)
        throw new OperationError('invalid_params', 'A/B generation did not produce a valid complete answer.', 'Resolve the generation failure before recording a preference.');
    await engine.transaction(async (tx) => {
        await declareDurablePersistence(tx);
        await authorizeTrial(tx, trial, true);
        const current = await readTrial(tx, trial.trial_id, trial.source_id, true), previous = current[side];
        if (current.input_hash !== trial.input_hash)
            abConflict();
        if (previous) {
            if (digest(previous) !== digest(result))
                abConflict();
            return;
        }
        if (current.state !== 'accepted' || side === 'calibrated' && !current.baseline)
            abConflict();
        await validateThinkEvidence(tx, result.comparison_evidence);
        const ordered = (e: ThinkEvidence[]) => e.map(item => ({ ...item, takes: [...item.takes].sort((a, b) => a.id - b.id) })).sort((a, b) => a.id - b.id);
        if (side === 'calibrated' && (digest(ordered(current.baseline!.comparison_evidence)) !== digest(ordered(result.comparison_evidence)) || digest(current.baseline!.temporal) !== digest(result.temporal)))
            throw new OperationError('revision_conflict', 'A/B retrieval evidence changed between answers.', 'Start a new comparison after reconciling the retained trial.');
        // Column name is a closed host enum, never model-authored SQL.
        await tx.executeRaw(`UPDATE codex_think_ab_trials SET ${side}=$2::text::jsonb,state=$3 WHERE trial_id=$1::uuid`, [trial.trial_id, JSON.stringify(result), side === 'calibrated' ? 'ready' : 'accepted']);
    });
}
export async function rateTrial(engine: BrainEngine, trial: ABTrial, preferred: ABPreference, notes: string): Promise<string> {
    if (!['baseline', 'with_calibration', 'neither', 'tie'].includes(preferred) || typeof notes !== 'string' || notes.length > 4000)
        throw new OperationError('invalid_params', 'A/B preference or notes are invalid.', 'Choose baseline, with_calibration, neither or tie; notes are limited to 4000 characters.');
    return engine.transaction(async (tx) => {
        await declareDurablePersistence(tx);
        await authorizeTrial(tx, trial, false);
        const current = await readTrial(tx, trial.trial_id, trial.source_id, true);
        if (current.input_hash !== trial.input_hash)
            abConflict();
        if (current.result_id !== null) {
            const [row] = await tx.executeRaw<{
                preferred: string;
                notes: string | null;
            }>('SELECT preferred,notes FROM think_ab_results WHERE id=$1', [current.result_id]);
            if (!row || row.preferred !== preferred || (row.notes ?? '') !== notes)
                abConflict();
            return String(current.result_id);
        }
        if (current.state !== 'ready' || !current.baseline || !current.calibrated)
            throw new OperationError('write_pending', 'Both A/B answers must be ready before rating.', 'Resume the original trial; failed or empty answers cannot become a preference.');
        const [row] = await tx.executeRaw<{
            id: string;
        }>(`INSERT INTO think_ab_results(source_id,question,baseline_answer,with_calibration_answer,preferred,model_id,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [current.source_id, current.binding.question, current.baseline.answer, current.calibrated.answer, preferred, current.binding.model, notes || null]);
        if (!row)
            abConflict();
        await tx.executeRaw("UPDATE codex_think_ab_trials SET result_id=$2,state='rated' WHERE trial_id=$1::uuid", [trial.trial_id, String(row!.id)]);
        return String(row!.id);
    });
}
