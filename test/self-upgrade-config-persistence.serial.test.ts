import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { attemptAutopilotSelfUpgrade, reconcileSelfUpgradeAtBoot } from '../src/commands/autopilot.ts';
import { applySelfUpgradeSetup } from '../src/commands/upgrade.ts';
import { VERSION } from '../src/version.ts';
import { writeUpdateCache } from '../src/core/self-upgrade.ts';

let tmp = '';
let prior: Record<string, string | undefined> = {};
const managedTarget = {
  manager_id: 'gbrain-managed-postgres',
  cluster_id: '123e4567-e89b-42d3-a456-426614174000',
};

function seedConfig(self_upgrade: Record<string, unknown>) {
  const dir = join(tmp, '.gbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    engine: 'postgres',
    managed_postgres: managedTarget,
    unrelated: { keep: 'durable-value' },
    self_upgrade,
  }));
}

function expectManagedConfig(saved: Record<string, any>) {
  expect(saved.engine).toBe('postgres');
  expect(saved.managed_postgres).toEqual(managedTarget);
  expect(saved).not.toHaveProperty('database_url');
  expect(saved.unrelated).toEqual({ keep: 'durable-value' });
  expect(JSON.stringify(saved)).not.toContain('override.example');
  expect(JSON.stringify(saved)).not.toContain('trusted.example');
  expect(JSON.stringify(saved)).not.toContain('secret');
}

function savedConfig(): Record<string, any> {
  return JSON.parse(readFileSync(join(tmp, '.gbrain', 'config.json'), 'utf8'));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-self-upgrade-persistence-'));
  for (const key of ['HOME', 'GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_SELF_UPGRADE_MODE']) prior[key] = process.env[key];
  process.env.HOME = tmp;
  process.env.GBRAIN_HOME = tmp;
  process.env.GBRAIN_DATABASE_URL = 'postgres://transient:secret@override.example:5432/other';
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('self-upgrade metadata persistence uses the durable file config', () => {
  test('boot reconciliation changes metadata without persisting an environment URL', () => {
    seedConfig({ attempting_version: VERSION, mode: 'auto', unrelated: 'keep' });
    reconcileSelfUpgradeAtBoot();
    const saved = savedConfig();
    expectManagedConfig(saved);
    expect(saved.self_upgrade).toMatchObject({ mode: 'auto', unrelated: 'keep', last_applied_version: VERSION });
    expect(saved.self_upgrade.attempting_version).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('transient');
  });

  test('upgrade setup preserves durable target and unrelated fields while applying defaults', async () => {
    seedConfig({});
    await applySelfUpgradeSetup(true);
    const saved = savedConfig();
    expectManagedConfig(saved);
    expect(saved.self_upgrade).toMatchObject({ mode: 'notify', mode_prompted: true });
    expect(JSON.stringify(saved)).not.toContain('transient');
  });

  test('attempt breadcrumb and failed-swap metadata are recorded against the durable config', async () => {
    const hour = new Date().getUTCHours();
    seedConfig({ mode: 'auto', quiet_hours: { start: (hour + 23) % 24, end: (hour + 2) % 24, tz: 'UTC' }, existing: 'keep' });
    writeUpdateCache({ kind: 'upgrade_available', current: '0.60.25', latest: '99.0.0' });
    let breadcrumbDuringSwap: Record<string, any> | undefined;
    await attemptAutopilotSelfUpgrade({} as any, 'pglite', join(tmp, 'lock'), () => true, {
      idle: async () => true,
      installMethod: () => 'bun',
      swap: () => { breadcrumbDuringSwap = savedConfig(); throw new Error('test swap failure'); },
    });
    expect(breadcrumbDuringSwap?.self_upgrade).toMatchObject({ mode: 'auto', existing: 'keep', attempting_version: '99.0.0' });
    expectManagedConfig(breadcrumbDuringSwap!);
    const saved = savedConfig();
    expectManagedConfig(saved);
    expect(saved.self_upgrade).toMatchObject({ mode: 'auto', existing: 'keep', failed_versions: ['99.0.0'] });
    expect(saved.self_upgrade.attempting_version).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('transient');
  });

  test('trusted DATABASE_URL override remains runtime-effective but is not persisted', () => {
    seedConfig({ attempting_version: VERSION });
    delete process.env.GBRAIN_DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://trusted:secret@trusted.example:5432/runtime';
    reconcileSelfUpgradeAtBoot();
    const saved = savedConfig();
    expectManagedConfig(saved);
    expect(saved.self_upgrade.last_applied_version).toBe(VERSION);
  });

  test('ordinary configured URL remains unchanged by metadata writes', () => {
    const dir = join(tmp, '.gbrain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      engine: 'postgres',
      database_url: 'postgres://durable:password@ordinary.example:5432/brain',
      unrelated: 'ordinary-field',
      self_upgrade: { attempting_version: VERSION },
    }));
    reconcileSelfUpgradeAtBoot();
    const saved = savedConfig();
    expect(saved.database_url).toBe('postgres://durable:password@ordinary.example:5432/brain');
    expect(saved.unrelated).toBe('ordinary-field');
    expect(saved.self_upgrade.last_applied_version).toBe(VERSION);
    expect(JSON.stringify(saved)).not.toContain('override.example');
  });

  test('env-only URL cannot start an unattributed upgrade without file config', async () => {
    process.env.GBRAIN_SELF_UPGRADE_MODE = 'auto';
    writeUpdateCache({ kind: 'upgrade_available', current: '0.60.25', latest: '99.0.0' });
    let swapCalled = false;
    await attemptAutopilotSelfUpgrade({} as any, 'pglite', join(tmp, 'lock'), () => true, {
      idle: async () => true,
      installMethod: () => 'bun',
      swap: () => { swapCalled = true; },
    });
    expect(swapCalled).toBe(false);
    expect(existsSync(join(tmp, '.gbrain', 'config.json'))).toBe(false);
  });

  test('PGLite config remains PGLite despite an environment-selected Postgres URL', async () => {
    mkdirSync(join(tmp, '.gbrain'), { recursive: true });
    writeFileSync(join(tmp, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', unrelated: 'keep' }));
    await applySelfUpgradeSetup(true);
    const saved = savedConfig();
    expect(saved.engine).toBe('pglite');
    expect(saved.unrelated).toBe('keep');
    expect(saved.database_url).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('override.example');
  });
});
