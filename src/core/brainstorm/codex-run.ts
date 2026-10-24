import { bindPrivateRoleScope } from '../ai/private-role-scope.ts';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { loadConfig } from '../config.ts';
import { readPrivateCodexConfig, assertPrivateRoute, PrivateRoutingError } from '../ai/private-policy.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { withSubscriptionAuxiliaryBudget, subscriptionAuxiliaryBudgets } from '../ai/subscription-auxiliary.ts';
import { withAIInvocationPreflight } from '../ai/invocation-guard.ts';
import { withCodexProposalCache } from '../ai/codex-proposal-cache.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { getEmbeddingModel, getEmbeddingDimensions } from '../ai/gateway.ts';
import { resolveModel } from '../model-config.ts';
import { resolveOwnerHolder } from '../owner-holder.ts';
import { initializeLocalPersistence } from '../persistence/page-mutations.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { digest } from '../persistence/digest.ts';
import { pickDecideConfig, readDecideConfig } from '../ai/decide/config.ts';
import { BRAINSTORM_PROFILE, type BrainstormOptions, type BrainstormRunConfig, type BrainstormResult } from './orchestrator.ts';
import { validateCodexBrainstormJudgeInput } from './codex-judge.ts';
import { currentVerifiedLocalWriter } from '../persistence/identity.ts';
import { runJudge } from './judges.ts';
import { selectBrainstormPages, validateBrainstormSelection, type BrainstormSelection } from './codex-selection.ts';
import { proposeBrainstormCross } from './codex-cross.ts';
import { prepareBrainstormPublication } from './codex-publication.ts';
import { claimBrainstormRun, fenceBrainstormRun, readBrainstormRun, retainBrainstormStage, releaseBrainstormRun } from './codex-store.ts';
export const CODEX_BRAINSTORM_RUN_VERSION = 'codex-brainstorm-run-v1';
export async function runCodexBrainstorm(engine: BrainEngine, config: BrainstormRunConfig, original: BrainstormOptions): Promise<BrainstormResult> {
    const parent = codexSubscriptionContext();
    const host = parent ? bindPrivateRoleScope(parent, ['brainstorm', 'brainstorm-judge']) : undefined;
    if (!host)
        throw new SubscriptionAdmissionError('subscription_required');
    const profile = original.profile ?? BRAINSTORM_PROFILE;
    if (original.chatFn || original.embedQueryFn || !original.question.trim() || original.question.length > 16000 || original.forceResume ||
        original.resumeRunId !== undefined && original.resumeRunId !== host.runId ||
        !['brainstorm', 'lsd'].includes(profile.label) || !Number.isSafeInteger(profile.k_close) || profile.k_close < 0 || profile.k_close > 8 ||
        !Number.isSafeInteger(profile.m_far) || profile.m_far < 1 || profile.m_far > 24 || !Number.isSafeInteger(profile.ideas_per_cross) || profile.ideas_per_cross < 1 || profile.ideas_per_cross > 5 ||
        Math.max(1, profile.k_close) * profile.m_far * profile.ideas_per_cross > 512 ||
        original.maxFarSet !== undefined && (!Number.isSafeInteger(original.maxFarSet) || original.maxFarSet < 1 || original.maxFarSet > 128) ||
        original.maxCostUsd !== undefined && original.maxCostUsd !== null && (!Number.isFinite(original.maxCostUsd) || original.maxCostUsd <= 0) ||
        profile.generator_voice.length > 4000 || (profile.generator_constraint?.length ?? 0) > 4000)
        throw new CodexProposalError('invalid_input');
    validateCodexBrainstormJudgeInput(profile.judge_config, [{ id: 'preflight', text: 'Host input validation.', close_slug: 'preflight', far_slug: 'preflight' }], { maxIdeasPerCall: original.maxIdeasPerJudgeCall });
    const { abortSignal, stderrWrite: _stderr, chatFn: _chat, embedQueryFn: _embed, skipCostPreview: _preview, resumeRunId: _resume, forceResume: _force, ...material } = original;
    const opts = JSON.parse(JSON.stringify({ ...material, profile })) as BrainstormOptions & {
        profile: typeof profile;
    };
    const ctx: OperationContext = { engine, config: loadConfig() ?? { engine: engine.kind }, remote: false, sourceId: opts.sourceId ?? 'default', dryRun: false, logger: { info() { }, warn() { }, error() { } } };
    if (currentVerifiedLocalWriter()?.remote || currentSubmissionAuthority()?.kind && currentSubmissionAuthority()?.kind !== 'application')
        throw new OperationError('permission_denied', 'Brainstorm requires local host authority.', 'Use an authorized local host subscription context.');
    const [brain] = await engine.executeRaw<{
        brain_id: string;
    }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    const [owner] = await host.engine.executeRaw<{
        brain_id: string;
    }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    if (!brain || brain.brain_id !== owner?.brain_id)
        throw new SubscriptionAdmissionError('subscription_identity_conflict');
    await initializeLocalPersistence(ctx);
    if (config.chat_model)
        assertPrivateRoute(config.chat_model, 'brainstorm:config.chat_model');
    const model = await resolveModel(engine, { privateRole: 'brainstorm', cliFlag: opts.modelOverride, tier: 'deep', fallback: 'opus' });
    const judgeModel = await resolveModel(engine, { privateRole: 'brainstorm-judge', cliFlag: opts.judgeModel, configKey: 'models.brainstorm.judge', tier: 'utility', fallback: 'haiku' });
    const settings = await engine.getAllConfig();
    if (Object.values(readDecideConfig(pickDecideConfig(settings) ?? {}).slots).some(s => s.mode !== 'off'))
        throw new PrivateRoutingError('brainstorm:decide.slots');
    const available = await engine.executeRaw<{
        id: string;
        incarnation: string;
    }>('SELECT id,incarnation FROM sources WHERE NOT archived ORDER BY id');
    const ids = [...new Set(opts.sourceIds ?? (opts.sourceId ? [opts.sourceId] : available.map(s => s.id)))].sort();
    if (!ids.length || ids.length > 20 || ids.some(id => !available.some(s => s.id === id)))
        throw new CodexProposalError('invalid_input');
    const execute = async () => {
        const auxiliary = [];
        for (const budget of subscriptionAuxiliaryBudgets()) {
            const [db] = await budget.engine.executeRaw<{
                brain_id: string;
            }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
            if (!db)
                throw new SubscriptionAdmissionError('subscription_identity_conflict');
            auxiliary.push({ brain: db.brain_id, key: budget.budgetKey, cap: budget.capUsd });
        }
        const requestHash = digest({ protocol: CODEX_BRAINSTORM_RUN_VERSION, opts, model, judgeModel, policy: readPrivateCodexConfig(), auxiliary,
            embedding: [getEmbeddingModel(), getEmbeddingDimensions()], sources: available.filter(s => ids.includes(s.id)), holder: config.emotional_weight?.user_holder ?? null,
            retrieval: Object.fromEntries(Object.entries(settings).filter(([k]) => /^(search\.|models\.|decide\.|embedding)/.test(k))) });
        const claim = await claimBrainstormRun(host, requestHash);
        let selection: BrainstormSelection | undefined;
        const fence = async (tx: BrainEngine) => {
            await fenceBrainstormRun(tx, host, claim);
            abortSignal?.throwIfAborted();
            await resolveModel(tx, { privateRole: 'brainstorm', cliFlag: opts.modelOverride, tier: 'deep', fallback: 'opus' });
            await resolveModel(tx, { privateRole: 'brainstorm-judge', cliFlag: opts.judgeModel, configKey: 'models.brainstorm.judge', tier: 'utility', fallback: 'haiku' });
            if (selection)
                await validateBrainstormSelection(tx, selection);
        };
        const check = async () => { await host.checkAuthority?.(); await engine.transaction(fence); };
        try {
            const result = await withCodexSubscription({ ...host, checkAuthority: check, checkAuthorityInTransaction: fence }, () => withAIInvocationPreflight(async () => {
                await check();
                const [grant] = await engine.executeRaw<{
                    current: boolean;
                }>('SELECT deadline>now() AS current FROM codex_subscription_runs WHERE run_id=$1', [host.runId]);
                if (!grant?.current)
                    throw new SubscriptionAdmissionError('subscription_exhausted');
            }, async () => {
                const stored = await readBrainstormRun(engine, claim.runId);
                selection = stored.selection ?? undefined;
                await check();
                if (stored.result)
                    return stored.result;
                if (!selection) {
                    selection = await selectBrainstormPages(ctx, { question: opts.question, profile: opts.profile, sourceIds: ids, holder: resolveOwnerHolder({ override: opts.holderOverride, configValue: config.emotional_weight?.user_holder }), maxFarSet: opts.maxFarSet ?? 50 });
                    await engine.transaction(async (tx) => { await fence(tx); await retainBrainstormStage(tx, host, claim, 'selection', selection!); });
                }
                const selected = selection!;
                const ideas: BrainstormResult['ideas'] = [];
                await withCodexProposalCache({ namespace: CODEX_BRAINSTORM_RUN_VERSION, bindingHash: digest([claim.runId, requestHash, digest(selected)]) }, async () => {
                    for (const close of selected.close.length ? selected.close : [null])
                        for (const far of selected.far) {
                            const proposed = await proposeBrainstormCross({ question: opts.question, profile: opts.profile, close, far, model, signal: abortSignal });
                            for (const proposal of proposed)
                                ideas.push({ id: String(ideas.length + 1).padStart(2, '0'), text: proposal.text,
                                    close_slug: close?.slug ?? '(no anchor)', far_slug: far.slug, close_source_id: close?.sourceId ?? null, far_source_id: far.sourceId,
                                    distance_score: far.distance, passes: false, evidence: [...(close ? [{ source_id: close.sourceId, slug: close.slug, page_id: close.id, revision: close.revision, quote: proposal.close_quote! }] : []),
                                        { source_id: far.sourceId, slug: far.slug, page_id: far.id, revision: far.revision, quote: proposal.far_quote }] });
                        }
                    const judged = await runJudge(opts.profile.judge_config, ideas, { modelOverride: judgeModel, activeBiasTags: selected.biases ?? undefined, maxIdeasPerCall: opts.maxIdeasPerJudgeCall, abortSignal });
                    for (const idea of ideas) {
                        idea.judge = judged.ideas.find(j => j.id === idea.id)!;
                        idea.passes = idea.judge.passes;
                    }
                });
                await check();
                const [usage] = await engine.executeRaw<{
                    input_tokens: number;
                    output_tokens: number;
                }>('SELECT COALESCE(sum(input_tokens),0)::int AS input_tokens,COALESCE(sum(output_tokens),0)::int AS output_tokens FROM codex_subscription_attempts WHERE run_id=$1', [host.runId]);
                const result: BrainstormResult = { profile_label: opts.profile.label, question: opts.question, embedding_model: getEmbeddingModel(), ideas,
                    close_set: selected.close.map(p => ({ slug: p.slug, title: p.title, source_id: p.sourceId })),
                    far_set: selected.far.map(p => ({ slug: p.slug, title: p.title, source_id: p.sourceId, distance_score: p.distance, source: p.sampling })),
                    active_bias_tags: selected.biases, short_of_target: selected.short, judge_failed: false, idea_slug: opts.ideaSlug,
                    generation_status: ideas.length ? 'complete' : 'empty', codex_run: { run_id: claim.runId, request_hash: requestHash },
                    cost: { estimated_usd: null, actual_usd: null, input_tokens: usage!.input_tokens, output_tokens: usage!.output_tokens, cap_usd: opts.maxCostUsd ?? null, cap_source: 'subscription' },
                };
                const publication = await prepareBrainstormPublication(ctx, result, selected);
                await engine.transaction(async (tx) => {
                    await fence(tx);
                    await retainBrainstormStage(tx, host, claim, 'result', result);
                    if (publication)
                        await tx.executeRaw('UPDATE codex_brainstorm_runs SET publication=$2::text::jsonb,publication_hash=$3 WHERE run_id=$1', [claim.runId, JSON.stringify(publication), digest(publication)]);
                });
                return result;
            }));
            await releaseBrainstormRun(host, claim, true);
            return result;
        }
        catch (error) {
            await releaseBrainstormRun(host, claim, false);
            throw error;
        }
    };
    return opts.maxCostUsd != null || !subscriptionAuxiliaryBudgets().length ?
        withSubscriptionAuxiliaryBudget(engine, `group:brainstorm:${host.runId}`, opts.maxCostUsd ?? undefined, execute) : execute();
}
