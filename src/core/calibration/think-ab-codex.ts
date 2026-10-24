import type { BrainEngine } from '../engine.ts';
import { runThink } from '../think/index.ts';
import { thinkPublicationContext, withThinkEvidence } from '../think/publication.ts';
import { initializeLocalPersistence } from '../persistence/page-mutations.ts';
import { submissionAuthority } from '../persistence/authority.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { bindPrivateRoleScope } from '../ai/private-role-scope.ts';
import { readPrivateCodexConfig, privatePolicyFingerprint } from '../ai/private-policy.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { OperationError } from '../ops/contract.ts';
import { digest, requireUuid, jsonBytes } from '../persistence/digest.ts';
import { getLatestProfile } from '../../commands/calibration.ts';
import { resolveModel } from '../model-config.ts';
import { embedQueryWithPrefix } from '../search/query-prefix.ts';
import { abConflict, authorizeTrial, checkTrialGeneration, readTrial, rateTrial, saveTrialAnswer, type ABTrial, type ABPreference } from './think-ab-store.ts';
export interface PrivateABInput {
    engine: BrainEngine;
    sourceId: string;
    remote: boolean;
    trialId: string;
    question: string;
    holder: string;
    model?: string;
    signal?: AbortSignal;
}
async function localContext(engine: BrainEngine, sourceId: string, remote: boolean, initialize = false) {
    if (remote !== false || currentSubmissionAuthority()?.kind && currentSubmissionAuthority()?.kind !== 'application')
        throw new OperationError('permission_denied', 'A/B trials require trusted local authority.', 'Use the brain host with an authorized source-wide grant.');
    const ctx = thinkPublicationContext(engine, { question: 'calibration A/B', sourceId, remote: false });
    if (initialize)
        await initializeLocalPersistence(ctx);
    const [source] = await engine.executeRaw<{
        incarnation: string;
    }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
    if (!source)
        throw new OperationError('not_found', 'A/B source not found.', 'Use an active source.');
    const authority = await submissionAuthority(ctx, 'submit_job', sourceId, source!.incarnation, '');
    if (authority.remote || authority.slugPrefixes !== null && !authority.slugPrefixes.includes('*'))
        throw new OperationError('permission_denied', 'A/B trials require a source-wide grant.', 'Use an authorized local source.');
    return { source: source!, authority };
}
/** Owner reads and preferences do not acquire an inference dependency. */
export async function inspectPrivateAbTrial(engine: BrainEngine, sourceId: string, trialId: string, remote: boolean): Promise<ABTrial> {
    const id = requireUuid(trialId);
    await localContext(engine, sourceId, remote);
    return engine.transaction(async (tx) => { await declareDurablePersistence(tx); const trial = await readTrial(tx, id, sourceId); await authorizeTrial(tx, trial, false); return trial; });
}
export async function recordPrivateAbPreference(engine: BrainEngine, sourceId: string, trialId: string, remote: boolean, preferred: ABPreference, notes = '') {
    const trial = await inspectPrivateAbTrial(engine, sourceId, trialId, remote);
    return rateTrial(engine, trial, preferred, notes);
}
/** Two sequential native calls, with each accepted answer retained before the next. */
export async function preparePrivateAbTrial(input: PrivateABInput): Promise<ABTrial> {
    const policy = readPrivateCodexConfig(), parent = codexSubscriptionContext();
    const context = parent && policy ? bindPrivateRoleScope(parent, ['calibration-think-ab']) : undefined;
    if (!policy || !context)
        throw new SubscriptionAdmissionError('subscription_required');
    const id = requireUuid(input.trialId), { engine, sourceId, question, holder } = input;
    if (!question.trim() || question.length > 16000 || !holder.trim() || holder.length > 300)
        throw new OperationError('invalid_params', 'A/B question or holder is invalid.', 'Use a nonempty bounded question and holder.');
    const [brain] = await engine.executeRaw<{
        brain_id: string;
    }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    const [admitted] = await context.engine.executeRaw<{
        brain_id: string;
    }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    if (!brain || brain.brain_id !== admitted?.brain_id)
        throw new SubscriptionAdmissionError('subscription_identity_conflict');
    const signals = [context.signal, input.signal].filter((s): s is AbortSignal => !!s);
    return withCodexSubscription({ ...context, signal: signals.length ? AbortSignal.any(signals) : undefined }, async () => {
        codexSubscriptionContext()!.signal?.throwIfAborted();
        await context.checkAuthority?.();
        const { source, authority } = await localContext(engine, sourceId, input.remote, true);
        const model = await resolveModel(engine, { privateRole: 'calibration-think-ab', cliFlag: input.model, configKey: 'models.think', tier: 'deep', fallback: 'opus' });
        const inputHash = digest({ protocol: 'codex-think-ab-v1', sourceId, incarnation: source.incarnation, question, holder, model, bin: policy.bin,
            ...(policy.models ? { policyIdentity: privatePolicyFingerprint(policy) } : {}) });
        let trial = await engine.transaction(async (tx) => {
            await declareDurablePersistence(tx);
            const existing = await tx.executeRaw<ABTrial>('SELECT * FROM codex_think_ab_trials WHERE trial_id=$1::uuid', [id]);
            if (existing[0]) {
                if (existing[0].input_hash !== inputHash || existing[0].run_id !== context.runId)
                    abConflict();
                await authorizeTrial(tx, existing[0], true);
                return existing[0];
            }
            const profile = await getLatestProfile(tx, { sourceId, holder });
            if (!profile || !profile.pattern_statements.length)
                throw new OperationError('not_found', 'No calibration profile is available for this comparison.', 'Generate a profile for this source and holder before starting an A/B trial.');
            const candidate: ABTrial = { trial_id: id, run_id: context.runId, source_id: sourceId, source_incarnation: source.incarnation, input_hash: inputHash,
                binding: { question, holder, model, profile, authority, ...context.publicationFence ? { fence: context.publicationFence } : {} }, baseline: null, calibrated: null, result_id: null, state: 'accepted' };
            if (jsonBytes(candidate.binding)>524288) throw new OperationError('invalid_params','A/B profile exceeds the retained input bound.','Use a bounded calibration profile.');
            await authorizeTrial(tx, candidate, true);
            await tx.executeRaw('INSERT INTO codex_think_ab_trials(trial_id,run_id,source_id,source_incarnation,input_hash,binding) VALUES($1::uuid,$2,$3,$4::uuid,$5,$6::text::jsonb) ON CONFLICT DO NOTHING', [id, context.runId, sourceId, source.incarnation, inputHash, JSON.stringify(candidate.binding)]);
            const accepted = await readTrial(tx, id, sourceId);
            if (accepted.input_hash !== inputHash || accepted.run_id !== context.runId)
                abConflict();
            await authorizeTrial(tx, accepted, true);
            return accepted;
        });
        for (const side of ['baseline', 'calibrated'] as const) {
            if (trial[side])
                continue;
            await context.checkAuthority?.();
            await checkTrialGeneration(engine, trial);
            const opts = { privateRole: 'calibration-think-ab' as const, question, sourceId, remote: false as const, model, withCalibration: side === 'calibrated', calibrationHolder: holder, embedQuestion: (q: string) => embedQueryWithPrefix(engine, q) };
            const captured = await withThinkEvidence(thinkPublicationContext(engine, opts), opts, () => runThink(engine, opts));
            await saveTrialAnswer(engine, trial, side, { ...captured.result, comparison_evidence: captured.evidence });
            trial = await readTrial(engine, id, sourceId);
        }
        await context.checkAuthority?.();
        return trial;
    });
}
