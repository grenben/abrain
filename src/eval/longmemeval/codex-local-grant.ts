import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../../core/engine.ts';
import { createSubscriptionRun, SubscriptionAdmissionError } from '../../core/ai/subscription-admission.ts';
import { codexSubscriptionContext, withCodexSubscription, type CodexSubscriptionContext } from '../../core/ai/subscription-context.ts';
import { withSubscriptionAuxiliaryBudget } from '../../core/ai/subscription-auxiliary.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../../core/minions/subscription-jobs.ts';
import { declareDurablePersistence } from '../../core/persistence/protocol.ts';
import { readPrivateCodexConfig } from '../../core/ai/private-policy.ts';
import { claimEvalRun, type EvalClaim, type EvalStage } from './codex-run-store.ts';
import type { EvalAllowance } from './codex-allowance-flags.ts';

const pending = new AsyncLocalStorage<Readonly<EvalAllowance>>();
/** Local CLI consent only; creating a durable grant waits for the actual parsed run binding. */
export function withLocalEvalAllowance<T>(engine: BrainEngine, allowance: EvalAllowance, run: () => Promise<T>): Promise<T> {
  if (!readPrivateCodexConfig() || codexSubscriptionContext()) throw new SubscriptionAdmissionError('subscription_required');
  const grant=Object.freeze({...allowance,deadline:new Date(allowance.deadline)}),runId=`codex-eval:${grant.requestId}`;
  return pending.run(grant,()=>withCodexSubscription({engine,runId},()=>
    withSubscriptionAuxiliaryBudget(engine,`group:${runId}`,grant.auxiliaryUsd,run)));
}

/** Brain lock serializes creation and binding, including same UUID with changed inputs. */
export async function claimAuthorizedEvalRun(host: CodexSubscriptionContext, bindingHash: string, count: number, stage: EvalStage): Promise<EvalClaim> {
  const grant=pending.getStore();
  if (!grant) return claimEvalRun(host,bindingHash,count,stage);
  if (host.runId!==`codex-eval:${grant.requestId}`) throw new SubscriptionAdmissionError('subscription_identity_conflict');
  const claim=await host.engine.transaction(async tx=>{
    await tx.executeRaw("SELECT set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    const [brain]=await tx.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    if (!brain) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    await declareDurablePersistence(tx);
    const [prior]=await tx.executeRaw<{account_lane:string;max_attempts:number;max_turns:number;deadline:Date|string}>(
      'SELECT account_lane,max_attempts,max_turns,deadline FROM codex_subscription_runs WHERE run_id=$1 FOR UPDATE',[host.runId]);
    if (prior) {
      if (prior.account_lane!==CODEX_JOB_ACCOUNT_LANE || prior.max_attempts!==grant.maxAttempts || prior.max_turns!==grant.maxTurns ||
          new Date(prior.deadline).getTime()!==grant.deadline.getTime()) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    } else await createSubscriptionRun(tx,{...grant,runId:host.runId,accountLane:CODEX_JOB_ACCOUNT_LANE});
    return claimEvalRun({...host,engine:tx},bindingHash,count,stage);
  });
  process.stderr.write(`[longmemeval] subscription request ${grant.requestId} ${JSON.stringify({billing:'subscription',max_attempts:grant.maxAttempts,
    max_turns:grant.maxTurns,deadline:grant.deadline.toISOString(),auxiliary_cap_usd:grant.auxiliaryUsd??null,monetary_cost_usd:null,remaining_quota:null})}\n`);
  return claim;
}
