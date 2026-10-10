import type { BrainEngine } from '../engine.ts';

let supported = false;
let actionsSupported = false;
export function noteChildSubscriptionEnforcement(features: readonly string[]): void {
  supported = features.includes('codex-subscription-v1');
  actionsSupported = features.includes('codex-host-read-v1');
}
export function childSubscriptionEnforcementReady(): boolean { return supported; }
export function childCodexActionsReady(): boolean { return actionsSupported; }
export async function jobSubscriptionBound(engine: BrainEngine, jobId: number): Promise<boolean> {
  const rows = await engine.executeRaw('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1 LIMIT 1', [`codex-job:${jobId}:%`]);
  return rows.length !== 0;
}
