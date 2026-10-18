import type { BrainEngine } from '../engine.ts';
import type { AutoThinkConfig, AutoThinkPhaseOpts, DreamPhaseResult } from './auto-think.ts';
import { runThink, persistSynthesis } from '../think/index.ts';
import { thinkPublicationContext } from '../think/publication.ts';
import { initializeLocalPersistence } from '../persistence/page-mutations.ts';
import { submissionAuthority } from '../persistence/authority.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { OperationError } from '../ops/contract.ts';
import { resolveModel } from '../model-config.ts';
import { digest } from '../persistence/digest.ts';
import { embedQueryWithPrefix } from '../search/query-prefix.ts';
import { hasAIInvocationGuard } from '../ai/invocation-guard.ts';
import { withSubscriptionAuxiliaryBudget } from '../ai/subscription-auxiliary.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { acceptAutoThinkBatch } from './auto-think-batch.ts';
import { autoThinkConflict, storeAutoThinkEntry, finishAutoThink, type AutoThinkRun } from './auto-think-store.ts';
/** No provider fallback and no cooldown after a partial batch. The enclosing host
 * owns the subscription envelope; a phase USD setting only limits auxiliary APIs. */
export async function runPrivateAutoThink(engine: BrainEngine, opts: AutoThinkPhaseOpts, config: AutoThinkConfig): Promise<DreamPhaseResult> {
    const context = codexSubscriptionContext();
    if (!context || opts.dryRun || !config.enabled)
        return runBatch(engine, opts, config);
    const controller = new AbortController();
    const signals = [controller.signal, context.signal, opts.signal].filter((s): s is AbortSignal => !!s);
    const signal = AbortSignal.any(signals);
    const timer = opts.deadlineAtMs == null ? undefined : setTimeout(() => controller.abort(), Math.max(0, Math.min(2147483647, opts.deadlineAtMs - Date.now())));
    timer?.unref();
    try {
        return await withCodexSubscription({ ...context, signal }, () => runBatch(engine, opts, config));
    }
    finally {
        clearTimeout(timer);
    }
}
async function runBatch(engine: BrainEngine, opts: AutoThinkPhaseOpts, config: AutoThinkConfig): Promise<DreamPhaseResult> {
    const start = Date.now(), sourceId = opts.sourceId ?? 'default';
    const report = (status: DreamPhaseResult['status'], detail: string, completed = 0): DreamPhaseResult => ({ name: 'auto_think', status, detail, duration_ms: Date.now() - start, totals: { synthesized: completed } });
    if (!config.enabled)
        return report('skipped', 'dream.auto_think.enabled is false');
    if (!config.questions.length)
        return report('skipped', 'dream.auto_think.questions is empty');
    if (config.questions.length > 100 || new Set(config.questions).size !== config.questions.length || config.questions.some(q => !q.trim() || q.length > 16000) || !Number.isSafeInteger(config.maxPerCycle) || config.maxPerCycle < 1 || config.maxPerCycle > 20 || !Number.isFinite(config.cooldownDays))
        throw new OperationError('invalid_params', 'Automatic think configuration is not bounded.', 'Use distinct nonempty questions and max_per_cycle between 1 and 20.');
    const questions = config.questions.slice(0, config.maxPerCycle);
    if (opts.dryRun)
        return report('skipped', `Dry run: ${questions.length} questions; no inference or publication.`);
    const context = codexSubscriptionContext();
    if (!context)
        throw new SubscriptionAdmissionError('subscription_required');
    context.signal?.throwIfAborted();
    const [brain] = await engine.executeRaw<{
        brain_id: string;
    }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    const [admitted] = await context.engine.executeRaw<{
        brain_id: string;
    }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    if (!brain || brain.brain_id !== admitted?.brain_id)
        throw new SubscriptionAdmissionError('subscription_identity_conflict');
    if (opts.client)
        throw new OperationError('invalid_params', 'Private automatic think cannot use an injected model client.', 'Use the native structured Codex gateway.');
    const model = await resolveModel(engine, { configKey: 'models.auto_think', deprecatedConfigKey: 'dream.auto_think.model', tier: 'deep', fallback: 'opus' });
    const ctx = thinkPublicationContext(engine, { question: 'auto-think', sourceId, remote: false });
    await initializeLocalPersistence(ctx);
    const [source] = await engine.executeRaw<{
        incarnation: string;
    }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
    if (!source)
        autoThinkConflict();
    const authority = await submissionAuthority(ctx, 'submit_job', sourceId, source!.incarnation, '');
    if (authority.remote || authority.slugPrefixes !== null && !authority.slugPrefixes.includes('*'))
        throw new OperationError('permission_denied', 'Automatic think requires a source-wide local grant.', 'Use an authorized local maintenance context.');
    const inputHash = digest({ sourceId, incarnation: source!.incarnation, config, model });
    const candidate: AutoThinkRun = { run_id: context.runId, source_id: sourceId, source_incarnation: source!.incarnation, input_hash: inputHash,
        binding: { authority, questions, autoCommit: config.autoCommit, ...context.publicationFence ? { fence: context.publicationFence } : {} }, results: {}, state: 'accepted' };
    const batch = await acceptAutoThinkBatch(engine, candidate, config.cooldownDays);
    if (!batch)
        return report('skipped', 'Automatic think cooldown is active.');
    const auxiliaryAuthorized = hasAIInvocationGuard();
    let completed = 0;
    for (let i = 0; i < questions.length; i++) {
        opts.signal?.throwIfAborted();
        context.signal?.throwIfAborted();
        await context.checkAuthority?.();
        if (opts.deadlineAtMs && Date.now() >= opts.deadlineAtMs)
            return report('partial', 'Automatic think deadline reached; retained results remain pending.', completed);
        const previous = batch!.results[String(i)];
        if (previous?.state === 'complete') {
            completed++;
            continue;
        }
        try {
            const result = previous?.result ?? await withSubscriptionAuxiliaryBudget(engine, `group:auto-think:${context.runId}:${sourceId}:${inputHash}`, auxiliaryAuthorized ? config.budgetUsd : undefined, () => runThink(engine, { question: questions[i]!, sourceId, remote: false, model, save: config.autoCommit, embedQuestion: (q: string) => embedQueryWithPrefix(engine, q) }));
            if (result.synthesisOk !== true)
                return report('partial', 'Automatic think produced a valid empty answer; cooldown unchanged.', completed);
            if (!previous)
                await storeAutoThinkEntry(engine, batch!, i, { state: 'accepted', result });
            const saved = config.autoCommit ? await persistSynthesis(engine, result, { sourceId }) : undefined;
            if (config.autoCommit && !saved?.slug)
                autoThinkConflict();
            await storeAutoThinkEntry(engine, batch!, i, { state: 'complete', result, ...saved ? { slug: saved.slug } : {} });
            completed++;
        }
        catch (error) {
            if (opts.signal?.aborted || context.signal?.aborted)
                throw error;
            // Return a bounded classification, never raw provider/storage details.
            const code = error instanceof SubscriptionAdmissionError ? error.code : error instanceof OperationError ? error.code : error instanceof CodexProposalError ? error.reason : 'generation_failed';
            return report('partial', `Automatic think stopped (${code}); cooldown unchanged.`, completed);
        }
    }
    const complete = await finishAutoThink(engine, batch!);
    return report(complete ? 'complete' : 'partial', `${completed} synthesized; monetary cost unknown (subscription).`, completed);
}
