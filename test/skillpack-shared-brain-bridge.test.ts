import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sharedBrainBridgePlan, installSharedBrainBridge, __testing as bridgeTesting } from '../src/core/skillpack/shared-brain-bridge.ts';
import { sha256 } from '../src/core/agent-install/state.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { ManagedPostgresUnsupportedError, MANAGED_POSTGRES_UNSUPPORTED_MESSAGE } from '../src/core/managed-postgres-unsupported.ts';
import { EngineTargetError } from '../src/core/engine-target.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'gbrain-shared-bridge-')); roots.push(root);
  const dest = join(root, 'skills'), statePath = join(root, 'bridge.json');
  mkdirSync(join(dest, 'recall'), { recursive: true });
  mkdirSync(join(dest, 'unrelated'));
  writeFileSync(join(dest, 'recall', 'SKILL.md'), 'old owned copy');
  writeFileSync(join(dest, 'unrelated', 'SKILL.md'), 'unrelated identity skill');
  writeFileSync(statePath, JSON.stringify({ schema_version: 'gbrain-skillpack-bridge-v1', entries: [{
    harness: 'codex', dest, written: { recall: { mode: 'full', files: { 'recall/SKILL.md': sha256('old owned copy') } } },
  }] }));
  const engine = { executeRaw: async () => [{ skill_bundles_enabled: true }] } as unknown as BrainEngine;
  return { root, dest, statePath, engine, config: { engine: 'pglite' } as GBrainConfig, harness: 'codex' };
}

test('active shared brains inventory unchanged owned copies without installing or removing stale bodies', async () => {
  const f = fixture(); const before = readFileSync(f.statePath, 'utf8');
  const result = await sharedBrainBridgePlan(f);
  expect(result?.reason).toBe('legacy_skill_migration_required');
  expect(result?.migration.owned_unchanged).toEqual(['recall/SKILL.md']);
  expect(result?.legacy_copy_written).toBe(false);
  expect(readFileSync(join(f.dest, 'recall', 'SKILL.md'), 'utf8')).toBe('old owned copy');
  expect(readFileSync(join(f.dest, 'unrelated', 'SKILL.md'), 'utf8')).toBe('unrelated identity skill');
  expect(readFileSync(f.statePath, 'utf8')).toBe(before);
});

test('edited and escaping ledger paths remain visible conflicts without modifying user files', async () => {
  const f = fixture(); writeFileSync(join(f.dest, 'recall', 'SKILL.md'), 'local user changes');
  const ledger = JSON.parse(readFileSync(f.statePath, 'utf8'));
  ledger.entries[0].written.recall.files['../outside.md'] = sha256('outside');
  writeFileSync(f.statePath, JSON.stringify(ledger));
  writeFileSync(join(f.root, 'outside.md'), 'outside');
  const result = await sharedBrainBridgePlan(f);
  expect(result?.reason).toBe('legacy_skill_conflict');
  expect(result?.migration.modified).toEqual(['recall/SKILL.md', '../outside.md']);
  expect(readFileSync(join(f.dest, 'recall', 'SKILL.md'), 'utf8')).toBe('local user changes');
  expect(readFileSync(join(f.root, 'outside.md'), 'utf8')).toBe('outside');
});

test('thin connection needs its explicit remote grant and never probes or mints from a local brain', async () => {
  const f = fixture(); let touched = false;
  const result = await sharedBrainBridgePlan({ ...f, dest: undefined,
    config: { remote_mcp: { mcp_url: 'https://brain.example/mcp' } } as GBrainConfig,
    engine: { executeRaw: async () => { touched = true; throw new Error('wrong local brain'); } } as unknown as BrainEngine });
  expect(touched).toBe(false);
  expect(result?.reason).toBe('follow_approval_required');
  expect(result?.next_action).toContain('skills_member_self');
  expect(result?.next_action).toContain('sync_brain_skills');
  expect(result?.native).toBe('unverified');
});

test('plain unconfigured and known legacy brains keep their existing bridge lane', async () => {
  expect(await sharedBrainBridgePlan({ engine: null, config: null, harness: 'codex' })).toBeNull();
  expect(await sharedBrainBridgePlan({ engine: { executeRaw: async () => [{ skill_bundles_enabled: false }] } as unknown as BrainEngine,
    config: { engine: 'pglite' }, harness: 'codex' })).toBeNull();
  expect((await installSharedBrainBridge({ engine: null, config: null, harness: 'codex', policy: 'follow' }))?.reason).toBe('shared_content_migration_required');
  expect((await installSharedBrainBridge({ engine: null, config: null, harness: 'codex', policy: 'memory-only' }))?.reason).toBe('memory_only');
});

test('managed bridge plan refuses without exposing its reference and install performs no writes or engine calls', async () => {
  const f = fixture();
  const uuid = '01234567-89ab-cdef-0123-456789abcdef';
  const config = { engine: 'postgres', managed_postgres: {
    manager_id: 'gbrain-managed-postgres', cluster_id: uuid,
  } } as unknown as GBrainConfig;
  let called = false;
  const engine = { executeRaw: async () => { called = true; return []; } } as unknown as BrainEngine;
  const before = readFileSync(f.statePath, 'utf8');
  const planned = await sharedBrainBridgePlan({ ...f, config, engine });
  expect(planned?.reason).toBe('managed_postgres_unsupported');
  expect(JSON.stringify(planned)).not.toContain(uuid);
  expect(planned?.next_action).toBe(MANAGED_POSTGRES_UNSUPPORTED_MESSAGE);
  await expect(installSharedBrainBridge({ ...f, config, engine, policy: 'follow' }))
    .rejects.toBeInstanceOf(ManagedPostgresUnsupportedError);
  expect(called).toBe(false);
  expect(readFileSync(f.statePath, 'utf8')).toBe(before);
  expect(existsSync(join(f.root, 'skillpack-shared'))).toBe(false);
  await expect(sharedBrainBridgePlan({ ...f, engine, config: {
    ...config, database_url: 'postgresql://secret@host/db',
  } as GBrainConfig })).rejects.toBeInstanceOf(EngineTargetError);
});

test('bridge configured-target equality compares canonical target identity', () => {
  const managed = (cluster_id: string) => ({ engine: 'postgres', managed_postgres: {
    manager_id: 'gbrain-managed-postgres', cluster_id,
  } } as unknown as GBrainConfig);
  const first = managed('01234567-89ab-cdef-0123-456789abcdef');
  const other = managed('11234567-89ab-cdef-0123-456789abcdef');
  expect(bridgeTesting.sameConfiguredTarget(first, managed('01234567-89ab-cdef-0123-456789abcdef'))).toBe(true);
  expect(bridgeTesting.sameConfiguredTarget(first, other)).toBe(false);
  expect(bridgeTesting.sameConfiguredTarget({ engine: 'postgres', database_url: 'postgresql://host/db' },
    { engine: 'postgres', database_url: 'postgresql://host/db' })).toBe(true);
  expect(bridgeTesting.sameConfiguredTarget({ engine: 'postgres', database_url: 'postgresql://host/db' },
    { engine: 'postgres', database_url: 'postgresql://host/other' })).toBe(false);
  expect(bridgeTesting.sameConfiguredTarget({ engine: 'pglite', database_path: '/brain' },
    { engine: 'pglite', database_path: '/brain' })).toBe(true);
  expect(bridgeTesting.sameConfiguredTarget({ engine: 'pglite', database_path: '/brain' },
    { engine: 'pglite', database_path: '/other' })).toBe(false);
  expect(bridgeTesting.sameConfiguredTarget({ engine: 'postgres' },
    { engine: 'postgres', database_url: '' })).toBe(false);
});

test('unavailable configured brain cannot silently fall back to unqualified copies', async () => {
  const f = fixture(); const absent = join(f.root, 'new-skills');
  const result = await sharedBrainBridgePlan({ ...f, dest: absent, engine: null });
  expect(result?.reason).toBe('shared_brain_unavailable');
  expect(existsSync(absent)).toBe(false);
});
