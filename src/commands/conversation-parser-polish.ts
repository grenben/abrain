import type { BrainEngine } from '../core/engine.ts';
import type { Page } from '../core/types.ts';
import type { ParseResult } from '../core/conversation-parser/types.ts';
import { polishConversation, PARSER_POLISH_VERSION } from '../core/conversation-parser/llm-polish.ts';
import { readPrivateCodexConfig, privatePolicyFingerprint } from '../core/ai/private-policy.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../core/ai/subscription-context.ts';
import { createSubscriptionRun, SubscriptionAdmissionError } from '../core/ai/subscription-admission.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../core/minions/subscription-jobs.ts';
import { declareDurablePersistence } from '../core/persistence/protocol.ts';
import { digest } from '../core/persistence/digest.ts';
import { resolveModel } from '../core/model-config.ts';
import { splitEvalAllowance } from '../eval/longmemeval/codex-allowance-flags.ts';
import { usageError } from '../cli/cli-error.ts';

/** Explicit local preview; only its allowance and validated proposal cache persist. */
export async function previewParserPolish(engine: BrainEngine, args: string[], page: Page, parsed: ParseResult) {
  const { allowance } = splitEvalAllowance(args), context = codexSubscriptionContext();
  const policy = readPrivateCodexConfig();
  if (!policy || allowance?.auxiliaryUsd !== undefined || context && allowance)
    throw usageError('Parser polish needs a private subscription allowance.', 'Supply the three Codex limits, or reuse the enclosing host allowance. No auxiliary provider is used.');
  if (!allowance && !context) throw new SubscriptionAdmissionError('subscription_required');
  const model = await resolveModel(engine, { privateRole: 'parser-polish', tier: 'utility', fallback: 'haiku' });
  const snapshot = digest(parsed), sourceId = page.source_id;
  const run = () => polishConversation({ enabled: true, parsed, engine, model, signal: context?.signal });
  if (context) {
    if (context.engine !== engine) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    return run();
  }
  const runId = await engine.transaction(async tx => {
    await declareDurablePersistence(tx);
    await tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 AND NOT archived FOR SHARE', [sourceId]);
    if (!source) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    const prefix = `codex-parser-polish:${allowance!.requestId}:`;
    const id = prefix + digest({ version: PARSER_POLISH_VERSION, snapshot, pageId: page.id, sourceId, incarnation: source.incarnation, model, policyIdentity: privatePolicyFingerprint(policy) });
    const previous = await tx.executeRaw<{ run_id: string }>('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1', [`${prefix}%`]);
    if (previous.some(row => row.run_id !== id)) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    await createSubscriptionRun(tx, { ...allowance!, runId: id, accountLane: CODEX_JOB_ACCOUNT_LANE });
    return id;
  });
  process.stderr.write(`[conversation-parser] subscription request ${allowance!.requestId}; cost unknown\n`);
  return withCodexSubscription({ engine, runId }, run);
}
