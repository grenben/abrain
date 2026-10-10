import type { BrainEngine } from '../../core/engine.ts';
import { runBrainstorm, BRAINSTORM_PROFILE, type BrainstormRunConfig } from '../../core/brainstorm/orchestrator.ts';
import { withBrainstormFixture } from '../../core/brainstorm/codex-fixture.ts';
import { ensureLocalBrainstormGrant, reportBrainstormAllowance } from '../../core/brainstorm/codex-local-grant.ts';
import { loadConfig } from '../../core/config.ts';
import { resolveSourceWithTier, localFederatedSourceIds, ALL_SOURCES } from '../../core/source-resolver.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../../core/ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../../core/ai/subscription-admission.ts';
import { CodexProposalError } from '../../core/ai/providers/codex-contract.ts';
import { readPrivateCodexConfig, assertPrivateRoute } from '../../core/ai/private-policy.ts';
import { withSubscriptionAuxiliaryBudget, subscriptionAuxiliaryBudgets } from '../../core/ai/subscription-auxiliary.ts';
import { OperationError } from '../../core/ops/contract.ts';
import { currentVerifiedLocalWriter } from '../../core/persistence/identity.ts';
import { currentSubmissionAuthority } from '../../core/minions/submission-authority.ts';
import { resolveModel } from '../../core/model-config.ts';
import { digest } from '../../core/persistence/digest.ts';
import { getEmbeddingModel, getEmbeddingDimensions } from '../../core/ai/gateway.ts';
import { claimEvalRun, fenceEvalRun, readEvalResult, retainEvalResult, releaseEvalRun, type EvalOutcome } from '../longmemeval/codex-run-store.ts';
import { captureBrainstormFixtures, type BrainstormEvalInput } from './input.ts';
import { summarizeFixture, computeVerdict, type BrainstormEvalReport, type PerFixtureResult } from './metrics.ts';
export interface NativeBrainstormEvalReport extends Omit<BrainstormEvalReport, 'schema_version'> {
    schema_version: 2;
    run_id: string;
    selected_fixtures: number;
    completed_fixtures: number;
    failure_code?: string;
}
interface Outcome extends EvalOutcome {
    row: {
        question_id: string;
        summary: PerFixtureResult;
        brainstorm_hash: string;
    };
}
const conflict = (): never => { throw new SubscriptionAdmissionError('subscription_identity_conflict'); };
const failureCode = (e: unknown) => e instanceof SubscriptionAdmissionError ? e.code : e instanceof CodexProposalError ? e.reason : e instanceof OperationError ? e.code : 'evaluation_failed';
/** One grant across every fixture. No child allowances and no success after a partial evaluation. */
export async function runPrivateBrainstormEval(engine: BrainEngine, original: BrainstormEvalInput): Promise<NativeBrainstormEvalReport> {
    const host = codexSubscriptionContext();
    if (!host || !readPrivateCodexConfig())
        throw new SubscriptionAdmissionError('subscription_required');
    if (currentVerifiedLocalWriter()?.remote || currentSubmissionAuthority()?.kind && currentSubmissionAuthority()?.kind !== 'application')
        throw new OperationError('permission_denied', 'Private brainstorm evaluation requires local host authority.', 'Use an authorized local subscription allowance.');
    const input = JSON.parse(JSON.stringify(original)) as BrainstormEvalInput, captured = captureBrainstormFixtures(input), config = (loadConfig() ?? {}) as BrainstormRunConfig;
    const [brain] = await engine.executeRaw<{
        brain_id: string;
    }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    const [owner] = await host.engine.executeRaw<{
        brain_id: string;
    }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    if (!brain || brain.brain_id !== owner?.brain_id)
        conflict();
    if (config.chat_model)
        assertPrivateRoute(config.chat_model, 'eval.brainstorm:config.chat_model');
    const model = await resolveModel(engine, { tier: 'deep', fallback: 'opus' }), judge = await resolveModel(engine, { configKey: 'models.brainstorm.judge', tier: 'utility', fallback: 'haiku' });
    const resolved = await resolveSourceWithTier(engine, input.source ?? null), sourceId = resolved.source_id === ALL_SOURCES ? undefined : resolved.source_id;
    const sourceIds = await localFederatedSourceIds(engine, resolved.source_id, resolved.tier);
    const sources = await engine.executeRaw<{
        id: string;
        incarnation: string;
    }>('SELECT id,incarnation FROM sources WHERE NOT archived ORDER BY id');
    const ids = sourceIds ?? (sourceId ? [sourceId] : sources.map(s => s.id));
    if (!ids.length || ids.length > 20 || ids.some(id => !sources.some(s => s.id === id)))
        conflict();
    const execute = async (): Promise<NativeBrainstormEvalReport> => {
        const auxiliary = [];
        for (const budget of subscriptionAuxiliaryBudgets()) {
            const [db] = await budget.engine.executeRaw<{
                brain_id: string;
            }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
            if (!db)
                conflict();
            auxiliary.push({ brain: db!.brain_id, key: budget.budgetKey, cap: budget.capUsd });
        }
        const relevant = (settings: Record<string, string>) => Object.fromEntries(Object.entries(settings).filter(([k]) => /^(search\.|models\.|decide\.|embedding)/.test(k)));
        const settings = relevant(await engine.getAllConfig()), policy = readPrivateCodexConfig(), selectedSources = sources.filter(s => ids.includes(s.id));
        const bindingHash = digest({ protocol: 'codex-brainstorm-eval-v1', dataset: captured.hash, fixtures: captured.fixtures, thresholds: input.thresholds, sourceId, sourceIds: ids,
            sources: selectedSources, model, judge, policy, auxiliary, profile: BRAINSTORM_PROFILE,
            holder: config.emotional_weight?.user_holder ?? null, embedding: [getEmbeddingModel(), getEmbeddingDimensions()],
            retrieval: settings });
        await host.checkAuthority?.();
        host.signal?.throwIfAborted();
        const claim = await host.engine.transaction(async (tx) => {
            await ensureLocalBrainstormGrant(tx, host.runId);
            if ((await tx.executeRaw('SELECT run_id FROM codex_brainstorm_runs WHERE run_id=$1', [host.runId])).length)
                conflict();
            return claimEvalRun({ ...host, engine: tx, checkAuthority: undefined }, bindingHash, captured.fixtures.length, 'answer');
        });
        reportBrainstormAllowance();
        const summaries: PerFixtureResult[] = [], fence = async (tx: BrainEngine) => {
            await fenceEvalRun(tx, host, claim);
            const currentSources = await tx.executeRaw('SELECT id,incarnation FROM sources WHERE NOT archived AND id=ANY($1::text[]) ORDER BY id', [ids]);
            if (digest(currentSources) !== digest(selectedSources) || digest(relevant(await tx.getAllConfig())) !== digest(settings) || digest(readPrivateCodexConfig()) !== digest(policy))
                conflict();
        };
        const check = async () => { await host.checkAuthority?.(); await host.engine.transaction(fence); };
        let completed = 0, code: string | undefined;
        try {
            await withCodexSubscription({ ...host, checkAuthority: check, checkAuthorityInTransaction: fence }, async () => {
                for (const [index, fixture] of captured.fixtures.entries()) {
                    const question = { question_id: digest([bindingHash, index]), fixture };
                    await check();
                    const prior = await readEvalResult<Outcome>(host.engine, claim, question, 'answer');
                    // Even retained summaries must revalidate the actual source/evidence-backed brainstorm receipt.
                    const result = await withBrainstormFixture(host.runId, question.question_id, () => runBrainstorm(engine, config, {
                        question: fixture.question, sourceId, sourceIds: ids, profile: BRAINSTORM_PROFILE, skipCostPreview: true,
                    }));
                    const summary = summarizeFixture(fixture.question, result, new Set([...result.close_set, ...result.far_set].map(p => p.slug)));
                    if (!Number.isFinite(summary.mean_usefulness))
                        summary.mean_usefulness = null;
                    summary.outcome = result.generation_status === 'empty' ? 'empty' : 'complete';
                    const outcome: Outcome = { row: { question_id: question.question_id, summary, brainstorm_hash: digest(result) }, rerankerSkipped: false, vectorDegraded: false, expansionFailed: false };
                    if (prior && digest(prior) !== digest(outcome))
                        conflict();
                    await host.engine.transaction(async (tx) => { await fence(tx); await retainEvalResult(tx, claim, question, 'answer', outcome); });
                    summaries.push(summary);
                    completed++;
                }
            });
            await releaseEvalRun(host, claim, true);
        }
        catch (error) {
            code = failureCode(error);
            await releaseEvalRun(host, claim, false);
        }
        const scores = computeVerdict(summaries, input.thresholds);
        if (code) {
            scores.verdict = 'inconclusive';
            scores.reasons = [`Evaluation stopped (${code}); retained completed fixtures can be resumed with the same request.`];
        }
        return { schema_version: 2, run_id: host.runId, fixture_path: input.path, total_fixtures: captured.total, selected_fixtures: captured.fixtures.length, completed_fixtures: completed,
            parseable_fixtures: summaries.filter(r => r.total_ideas > 0 && !r.judge_failed).length, thresholds: input.thresholds, per_fixture: summaries, ...scores, total_cost_usd: null, ...code ? { failure_code: code } : {} };
    };
    return subscriptionAuxiliaryBudgets().length ? execute() : withSubscriptionAuxiliaryBudget(engine, `group:${host.runId}`, undefined, execute);
}
