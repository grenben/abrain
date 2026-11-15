import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validatePrivateSchedules, type PrivateScheduleAllowance } from '../../src/core/ai/private-schedules.ts';
import { validatePrivateCodexConfig, privateModelForRole } from '../../src/core/ai/private-policy.ts';
import { SubscriptionAdmissionError } from '../../src/core/ai/subscription-admission.ts';
import { scheduledCodexSubmit } from '../../src/core/minions/subscription-schedules.ts';
import { withEnv } from '../helpers/with-env.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-private-schedules-'));
const configDir = join(root, '.gbrain');
const schedule: PrivateScheduleAllowance = { maxAttempts: 4, maxTurns: 2, windowMs: 60_000 };

function save(scheduledJobs?: unknown, enabledRoles: string[] = ['atoms']): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ private_codex: {
    mode: 'strict', bin: '/fixture/codex', models: {
      utility: 'codex-cli:utility-test', reasoning: 'codex-cli:reasoning-test',
      deep: 'codex-cli:deep-test', subagent: 'codex-cli:subagent-test',
    }, enabled_roles: enabledRoles,
    ...(scheduledJobs === undefined ? {} : { scheduled_jobs: scheduledJobs }),
  } }));
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('private scheduled Codex allowances', () => {
  test('allows the atom drain schedule and validates its bounds', () => withEnv({ GBRAIN_HOME: root }, () => {
    expect(validatePrivateSchedules({ 'extract-atoms-drain': schedule })).toEqual({ 'extract-atoms-drain': schedule });
    for (const malformed of [
      { ...schedule, windowMs: 86_400_001 }, { ...schedule, maxTurns: 5 },
      { ...schedule, auxiliaryMaxUsd: 0 }, { ...schedule, unexpected: true },
    ]) expect(() => validatePrivateSchedules({ 'extract-atoms-drain': malformed })).toThrow('invalid_private_schedules');
  }));

  test('scheduled atom drain uses a fixed UTC deadline and refuses an insufficient remaining window', () => withEnv({ GBRAIN_HOME: root }, () => {
    save({ 'extract-atoms-drain': schedule });
    const slot = '2026-10-21T00:00:00.000Z';
    const call = (nowMs: number, minRemainingMs = 30_000) => (scheduledCodexSubmit as any)(
      'extract-atoms-drain', {}, slot, { nowMs, minRemainingMs },
    );
    const grant = call(Date.parse(slot) + 20_000);
    expect(grant?.codexSubscription?.deadline.toISOString()).toBe('2026-10-21T00:01:00.000Z');
    expect(() => call(Date.parse(slot) + 30_001)).toThrow(new SubscriptionAdmissionError('subscription_exhausted'));
    expect(() => call(Date.parse(slot) + 20_000, 0)).toThrow(new SubscriptionAdmissionError('subscription_invalid'));
  }));

  test('absence of a private schedule refuses admission rather than granting an implicit allowance', () => withEnv({ GBRAIN_HOME: root }, () => {
    save();
    expect(() => (scheduledCodexSubmit as any)('extract-atoms-drain', {}, '2026-10-21T00:00:00.000Z', { nowMs: Date.parse('2026-10-21T00:00:00Z') }))
      .toThrow(new SubscriptionAdmissionError('subscription_required'));
  }));

  test('scheduled atom drain adds an optional auxiliary spend cap only when configured', () => withEnv({ GBRAIN_HOME: root }, () => {
    const slot = '2026-10-21T00:00:00.000Z', nowMs = Date.parse(slot);
    save({ 'extract-atoms-drain': schedule });
    expect((scheduledCodexSubmit as any)('extract-atoms-drain', {}, slot, { nowMs }).spendAuthorization).toBeUndefined();
    save({ 'extract-atoms-drain': { ...schedule, auxiliaryMaxUsd: 1.25 } });
    expect((scheduledCodexSubmit as any)('extract-atoms-drain', {}, slot, { nowMs }).spendAuthorization?.cap_usd).toBe(1.25);
  }));

  test('scheduled atom drain rejects unsafe clock options', () => withEnv({ GBRAIN_HOME: root }, () => {
    save({ 'extract-atoms-drain': schedule });
    const slot = '2026-10-21T00:00:00.000Z';
    for (const options of [{ nowMs: Number.NaN }, { nowMs: -Infinity }, { nowMs: -1 }, { minRemainingMs: 0 }, { minRemainingMs: -1 }, { minRemainingMs: Infinity }]) {
      expect(() => (scheduledCodexSubmit as any)('extract-atoms-drain', {}, slot, options))
        .toThrow(new SubscriptionAdmissionError('subscription_invalid'));
    }
  }));

  test('tiered atoms activation requires the atoms role; schedule alone does not enable it', () => withEnv({ GBRAIN_HOME: root }, () => {
    save(undefined, []);
    const disabled = validatePrivateCodexConfig(JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')).private_codex)!;
    expect(disabled.enabled_roles).not.toContain('atoms');
    expect(() => privateModelForRole(disabled, 'atoms')).toThrow('private_role_disabled');

    save(undefined, ['atoms']);
    const enabled = validatePrivateCodexConfig(JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')).private_codex)!;
    expect(enabled.enabled_roles).toContain('atoms');
    expect(privateModelForRole(enabled, 'atoms')).toBe('codex-cli:utility-test');
  }));

  test('tiered atoms role remains enabled when the scheduled drain allowance is separately configured', () => withEnv({ GBRAIN_HOME: root }, () => {
    save({ 'extract-atoms-drain': schedule }, ['atoms']);
    const raw = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')).private_codex;
    const policy = validatePrivateCodexConfig(raw);
    expect(policy?.enabled_roles).toContain('atoms');
    expect(policy?.scheduled_jobs?.['extract-atoms-drain' as keyof typeof policy.scheduled_jobs]).toEqual(schedule);
  }));
});
