import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import type { RunThinkOpts } from '../core/think/index.ts';
import { readPrivateCodexConfig } from '../core/ai/private-policy.ts';
import { createSubscriptionRun, SubscriptionAdmissionError } from '../core/ai/subscription-admission.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../core/ai/subscription-context.ts';
import { withSubscriptionAuxiliaryBudget } from '../core/ai/subscription-auxiliary.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../core/minions/subscription-jobs.ts';
import { declareDurablePersistence } from '../core/persistence/protocol.ts';
import { digest } from '../core/persistence/digest.ts';
import { isWriteRequestId } from '../core/persistence/types.ts';
import { resolveModel } from '../core/model-config.ts';
import { usageError } from '../cli/cli-error.ts';
import { prepareCodexJobSubmit, codexSubmitSummary } from './jobs/subscription.ts';
export const THINK_ALLOWANCE_FLAGS = ['--codex-max-attempts', '--codex-max-turns', '--codex-deadline', '--codex-request-id', '--max-usd'];
export function hasThinkAllowanceFlags(args: string[]): boolean {
    return args.some(arg => arg.startsWith('--codex-') || arg === '--max-usd' || arg.startsWith('--max-usd='));
}
/** Host-only local CLI consent wraps both inference and required publication. */
export async function withThinkSubscription<T>(engine: BrainEngine, args: string[], opts: RunThinkOpts, run: () => Promise<T>): Promise<T> {
    const policy = readPrivateCodexConfig();
    if (!policy || codexSubscriptionContext()) {
        if (hasThinkAllowanceFlags(args))
            throw usageError('Think allowance flags require a new local private subscription request.', 'Use strict private mode, or reuse the enclosing host allowance without extra flags.');
        return run();
    }
    if (opts.remote !== false)
        throw new SubscriptionAdmissionError('subscription_required');
    if (args.some(arg => arg.startsWith('--codex-') && !THINK_ALLOWANCE_FLAGS.includes(arg)))
        throw usageError('Unknown or malformed Codex allowance flag.', 'Use the space-separated allowance flags listed by think --help.');
    const model = await resolveModel(engine, { cliFlag: opts.model, configKey: 'models.think', tier: 'deep', fallback: 'opus' });
    const { codexSubscription, spendAuthorization } = await prepareCodexJobSubmit(engine, 'autopilot-cycle', { phases: ['auto_think'] }, args);
    if (!codexSubscription)
        throw new SubscriptionAdmissionError('subscription_required');
    const positions = args.flatMap((arg, i) => arg === '--codex-request-id' ? [i] : []);
    const requestId = positions.length ? args[positions[0]! + 1] : randomUUID();
    if (positions.length > 1 || !isWriteRequestId(requestId))
        throw usageError('Use one --codex-request-id UUID.', 'Reuse the same UUID, deadline, limits and question to reconcile a previous request.');
    const capUsd = spendAuthorization?.cap_usd ?? undefined;
    const sourceId = opts.sourceId ?? 'default';
    const { embedQuestion, publicationContext: _ctx, client: _client, stubResponse: _stub, ...input } = opts;
    const runId = await engine.transaction(async (tx) => {
        await tx.executeRaw("SELECT set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
        await tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
        await declareDurablePersistence(tx);
        const ids = [...new Set([sourceId, ...opts.allowedSources ?? []])].sort();
        const sources = await tx.executeRaw<{
            id: string;
            incarnation: string;
        }>('SELECT id,incarnation FROM sources WHERE id=ANY($1::text[]) AND NOT archived ORDER BY id FOR SHARE', [ids]);
        if (sources.length !== ids.length)
            throw new SubscriptionAdmissionError('subscription_identity_conflict');
        const prefix = `codex-think:${requestId.toLowerCase()}:`;
        const id = prefix + digest({ input, sources, model, bin: policy.bin, auxiliaryUsd: capUsd ?? null, embedding: !!embedQuestion });
        const previous = await tx.executeRaw<{
            run_id: string;
        }>('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1', [`${prefix}%`]);
        if (previous.some(row => row.run_id !== id))
            throw new SubscriptionAdmissionError('subscription_identity_conflict');
        await createSubscriptionRun(tx, { ...codexSubscription, runId: id, accountLane: CODEX_JOB_ACCOUNT_LANE });
        return id;
    });
    process.stderr.write(`[think] subscription request ${requestId.toLowerCase()} ${codexSubmitSummary(codexSubscription)}\n`);
    return withCodexSubscription({ engine, runId }, () => withSubscriptionAuxiliaryBudget(engine, `group:${runId}`, capUsd, run));
}
