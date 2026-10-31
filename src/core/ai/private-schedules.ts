/** Trusted file-plane opt-in for the two automatic cycle producers. */
export interface PrivateScheduleAllowance {
  maxAttempts: number; maxTurns: number; windowMs: number; auxiliaryMaxUsd?: number;
}
export type PrivateSchedules = Partial<Record<'autopilot-cycle' | 'autopilot-global-maintenance' | 'nightly-quality-probe' | 'extract-atoms-drain', PrivateScheduleAllowance>>;

export function validatePrivateSchedules(value: unknown): PrivateSchedules | undefined {
  if (value === undefined) return undefined;
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const invalid = (): never => { throw new Error('invalid_private_schedules'); };
  if (!record(value)) return invalid();
  const result: PrivateSchedules = {};
  for (const [name, limits] of Object.entries(value)) {
    if (!['autopilot-cycle', 'autopilot-global-maintenance', 'nightly-quality-probe', 'extract-atoms-drain'].includes(name) || !record(limits) ||
        Object.keys(limits).some(k => !['maxAttempts', 'maxTurns', 'windowMs', 'auxiliaryMaxUsd'].includes(k))) return invalid();
    const { maxAttempts, maxTurns, windowMs, auxiliaryMaxUsd } = limits;
    if (![maxAttempts, maxTurns].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= 1000) ||
        (maxTurns as number) > (maxAttempts as number) || typeof windowMs !== 'number' || !Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 86_400_000 ||
        (auxiliaryMaxUsd !== undefined && (typeof auxiliaryMaxUsd !== 'number' || !Number.isFinite(auxiliaryMaxUsd) || auxiliaryMaxUsd <= 0))) return invalid();
    result[name as keyof PrivateSchedules] = { maxAttempts: maxAttempts as number, maxTurns: maxTurns as number, windowMs,
      ...(auxiliaryMaxUsd === undefined ? {} : { auxiliaryMaxUsd: auxiliaryMaxUsd as number }) };
  }
  return result;
}
