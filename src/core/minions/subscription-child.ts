import type { BrainEngine } from '../engine.ts';

let supported = false;
let actionsSupported = false;
let discoverySupported = false;
export function noteChildSubscriptionEnforcement(features: readonly string[]): void {
  discoverySupported = features.includes('codex-discovery-v1');
  supported = features.includes('codex-subscription-v1');
  actionsSupported = features.includes('codex-host-read-v1') && features.includes('codex-host-actions-v1');
}
export function childSubscriptionEnforcementReady(): boolean { return supported; }
export function childCodexActionsReady(discovery = false): boolean { return actionsSupported && (!discovery || discoverySupported); }
export async function jobSubscriptionBound(engine: BrainEngine, jobId: number): Promise<boolean> {
  const rows = await engine.executeRaw('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1 LIMIT 1', [`codex-job:${jobId}:%`]);
  return rows.length !== 0;
}
