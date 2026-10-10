import { preflightThinkAction } from './publication-preflight.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { loadConfig } from '../config.ts';
import { digest } from '../persistence/digest.ts';
import { initializeLocalPersistence, preparePageAdmission } from '../persistence/page-mutations.ts';
import { declareDurablePersistence } from '../persistence/protocol.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { readPrivateCodexConfig } from '../ai/private-policy.ts';
import { resolveModel } from '../model-config.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { serializeMarkdown } from '../markdown.ts';
import { resolveOwnerHolder } from '../owner-holder.ts';
import { claimFromAnswer } from './persist-take.ts';
import { stripGapsSection, type RunThinkOpts, type ThinkResult } from './index.ts';
import type { ThinkGatherResult } from './gather.ts';
import type { ThinkEvidence, ThinkPublicationPayload, ThinkPublicationPlan } from './publication-model.ts';
import { captureThinkEvidence, validateThinkEvidence } from './publication-evidence.ts';
import { readThinkPlan, thinkConflict } from './publication-guard.ts';
import { submissionAuthority, authorizeWrite } from '../persistence/authority.ts';
interface PendingThink {
    ctx: OperationContext;
    opts: RunThinkOpts;
    evidence?: ThinkEvidence[];
}
const pending = new AsyncLocalStorage<PendingThink>();
export async function captureThinkPublicationEvidence(gather: ThinkGatherResult): Promise<void> {
    const state = pending.getStore();
    if (state)
        state.evidence = await captureThinkEvidence(state.ctx, state.opts, gather);
}
export function thinkPublicationContext(engine: BrainEngine, opts: RunThinkOpts): OperationContext {
    return opts.publicationContext ?? { engine, config: loadConfig() ?? { engine: engine.kind }, remote: false, sourceId: opts.sourceId ?? 'default', dryRun: false, logger: { info() { }, warn() { }, error() { } } };
}
const tagged = (plan: ThinkPublicationPlan): ThinkResult => ({ ...plan.payload.result, codex_publication: { plan_id: plan.plan_id, payload_hash: plan.payload_hash } });
/** Retain a validated proposal and frozen write admissions; no effect runs until the caller requests publication. */
export async function retainPrivateThink(engine: BrainEngine, opts: RunThinkOpts, run: () => Promise<ThinkResult>): Promise<ThinkResult> {
    if (!opts.save && !opts.take)
        return run();
    const context = codexSubscriptionContext()!, ctx = thinkPublicationContext(engine, opts);
    if (opts.remote !== false || ctx.remote !== false || ctx.engine !== engine || currentSubmissionAuthority()?.kind && currentSubmissionAuthority()?.kind !== 'application')
        throw new OperationError('permission_denied', 'Think publication requires trusted local authority.', 'Use a local authorized publication context.');
    await initializeLocalPersistence(ctx);
    const sourceId = opts.sourceId ?? 'default';
    const [source] = await engine.executeRaw<{
        incarnation: string;
    }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
    if (!source)
        throw new OperationError('source_changed', 'The think destination is not active.', 'Select an active source.');
    const model = await resolveModel(engine, { cliFlag: opts.model, configKey: 'models.think', tier: 'deep', fallback: 'opus' });
    const requestKey = digest([sourceId, opts.question]);
    const inputHash = digest({ sourceId, incarnation: source.incarnation, question: opts.question, anchor: opts.anchor ?? null,
        save: !!opts.save, take: !!opts.take, model, scope: opts.allowedSources ?? null, since: opts.since ?? null, until: opts.until ?? null,
        referenceDate: opts.referenceDate ?? null, withCalibration: !!opts.withCalibration, calibrationHolder: opts.calibrationHolder ?? null,
        excludePrivate: opts.excludePrivate ?? null, takesHoldersAllowList: opts.takesHoldersAllowList ?? null, rounds: opts.rounds ?? 1, withTrajectory: opts.withTrajectory ?? null, policy: readPrivateCodexConfig() });
    const [prior] = await engine.executeRaw<ThinkPublicationPlan>('SELECT * FROM codex_think_publications WHERE run_id=$1 AND request_key=$2', [context.runId, requestKey]);
    if (prior) {
        const plan = await readThinkPlan(engine, prior.plan_id);
        if (plan.payload.inputHash !== inputHash)
            thinkConflict();
        for (const { admission: a } of plan.payload.actions) {
            await submissionAuthority(ctx, a.operation, a.sourceId, a.sourceIncarnation, a.slug);
            await authorizeWrite(engine, a.authority, a.operation, a.slug);
        }
        return tagged(plan);
    }
    if (opts.take && !opts.anchor)
        throw new OperationError('invalid_params', 'A think take requires an anchor.', 'Specify the destination page before inference.');
    const date = new Date().toISOString().slice(0, 10), suffix = digest([context.runId, requestKey]).slice(0, 12);
    const questionSlug = opts.question.toLowerCase().replace(/[^a-z0-9\s]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'untitled';
    const slug = `synthesis/${questionSlug}-${date}-${suffix}`;
    if (opts.save)
        await submissionAuthority(ctx, 'put_page', sourceId, source.incarnation, slug);
    if (opts.take)
        await submissionAuthority(ctx, 'takes_add', sourceId, source.incarnation, opts.anchor!);
    const target = await engine.readPageSnapshot(opts.anchor ?? slug, { sourceId, includeDeleted: true });
    if (opts.take && (!target || target.page.deleted_at))
        throw new OperationError('page_not_found', 'The think take anchor is unavailable.', 'Read the active anchor page before synthesis.');
    const state: PendingThink = { ctx, opts };
    const result = await pending.run(state, run);
    if (result.synthesisOk !== true)
        return result;
    if (!state.evidence)
        throw new OperationError('invalid_params', 'Think publication has no retained retrieval evidence.', 'Run the validated private think pipeline before publication.');
    const planId = randomUUID(), actions: ThinkPublicationPayload['actions'] = [];
    const privateEvidence = state.evidence.some(e => e.private);
    const title = result.question.slice(0, 200), answer = stripGapsSection(result.persist?.answer ?? result.answer);
    if (opts.save) {
        const body = [`# ${result.question}`, answer, ...result.gaps.length ? ['## Gaps', ...result.gaps.map(g => `- ${g}`)] : []].join('\n\n');
        const content = serializeMarkdown({ question: result.question, model: result.modelUsed, date, visibility: privateEvidence ? 'private' : 'world',
            pages_gathered: result.pagesGathered, takes_gathered: result.takesGathered, unverified_claims: result.persist?.unverified_claims ?? [] }, body, '', { type: 'synthesis', title, tags: [] });
        actions.push(await prepareAction(ctx, planId, 'page', { slug, source_id: sourceId, content, expected_revision: null, expected_source_incarnation: source.incarnation }));
    }
    if (opts.take) {
        const claim = claimFromAnswer(answer);
        if (!claim)
            throw new OperationError('invalid_params', 'No verified think claim is available.', 'Review the quoted claims before saving a take.');
        const holder = resolveOwnerHolder({ configValue: await engine.getConfig('emotional_weight.user_holder') });
        if (privateEvidence && holder === 'world')
            throw new OperationError('permission_denied', 'Private think evidence cannot become a world-held take.', 'Use a private holder or public evidence.');
        actions.push(await prepareAction(ctx, planId, 'take', { slug: opts.anchor!, source_id: sourceId, claim, kind: 'take', holder, source: `think:${planId}`, expected_revision: target!.revision, expected_source_incarnation: source.incarnation }));
    }
    for (const action of actions)
        await preflightThinkAction(ctx, action.admission);
    const payload: ThinkPublicationPayload = { version: 1, inputHash, result, evidence: state.evidence, actions, ...context.publicationFence ? { fence: context.publicationFence } : {} };
    await engine.transaction(async (tx) => {
        await declareDurablePersistence(tx);
        await context.checkAuthorityInTransaction?.(tx);
        context.signal?.throwIfAborted();
        await tx.executeRaw('SELECT id FROM sources WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [[...new Set([sourceId, ...state.evidence!.map(e => e.sourceId)])]]);
        for (const action of actions)
            await authorizeWrite(tx, action.admission.authority, action.admission.operation, action.admission.slug, true);
        for (const e of state.evidence!)
            await authorizeWrite(tx, e.authority, 'think', e.slug, true);
        await tx.lockPageKeys(state.evidence!.map(e => ({ sourceId: e.sourceId, slug: e.slug })));
        await validateThinkEvidence(tx, state.evidence!);
        await tx.executeRaw(`INSERT INTO codex_think_publications(plan_id,run_id,request_key,source_id,source_incarnation,payload,payload_hash)
      VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::text::jsonb,$7) ON CONFLICT(run_id,request_key) DO NOTHING`, [planId, context.runId, requestKey, sourceId, source.incarnation, JSON.stringify(payload), digest(payload)]);
    });
    const [accepted] = await engine.executeRaw<ThinkPublicationPlan>('SELECT * FROM codex_think_publications WHERE run_id=$1 AND request_key=$2', [context.runId, requestKey]);
    const plan = await readThinkPlan(engine, accepted!.plan_id);
    if (plan.payload.inputHash !== inputHash)
        thinkConflict();
    return tagged(plan);
}
async function prepareAction(ctx: OperationContext, planId: string, kind: 'page' | 'take', params: Record<string, unknown>): Promise<ThinkPublicationPayload['actions'][number]> {
    const expectedRevision = typeof params.expected_revision === 'string' ? params.expected_revision : null;
    if (params.expected_revision === null)
        delete params.expected_revision;
    const prepared = await preparePageAdmission(ctx, { operation: kind === 'page' ? 'put_page' : 'takes_add', params: { ...params, request_id: randomUUID() } });
    if (prepared.prior)
        thinkConflict();
    if (expectedRevision === null && prepared.admission!.pageId !== null)
        throw new OperationError('revision_conflict', 'The think destination already exists.', 'Reconcile the original publication before creating another page.');
    return { kind, expectedRevision, admission: { ...prepared.admission!, protocolVersion: 4, intent: { ...prepared.admission!.intent, codex_think_plan: planId } } };
}
