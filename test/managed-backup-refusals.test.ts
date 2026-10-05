import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteBackup, restorePgliteBackup } from '../src/core/backup/snapshot.ts';
import { MANAGED_POSTGRES_UNSUPPORTED_CODE, MANAGED_POSTGRES_UNSUPPORTED_MESSAGE } from '../src/core/managed-postgres-unsupported.ts';
import { runMigrateEngine } from '../src/commands/migrate-engine.ts';

const roots: string[] = [];
const managedConfig = JSON.stringify({ engine: 'postgres', managed_postgres: {
  manager_id: 'gbrain-managed-postgres', cluster_id: '01234567-89ab-cdef-0123-456789abcdef',
} });

function managedRoot(): string {
  const root = fs.mkdtempSync(join(tmpdir(), 'gbrain-managed-refusal-'));
  roots.push(root);
  fs.mkdirSync(join(root, '.gbrain'), { recursive: true });
  fs.writeFileSync(join(root, '.gbrain', 'config.json'), managedConfig);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('managed PGLite backup target refuses before output validation or creation', async () => {
  const root = managedRoot();
  const output = join(root, 'missing-parent', 'should-not-exist.gbrain-backup');
  const before = fs.readFileSync(join(root, '.gbrain', 'config.json'));
  await expect(createPgliteBackup({ root, output })).rejects.toMatchObject({
    code: MANAGED_POSTGRES_UNSUPPORTED_CODE,
    message: MANAGED_POSTGRES_UNSUPPORTED_MESSAGE,
    operation: 'backup',
  });
  expect(fs.readFileSync(join(root, '.gbrain', 'config.json'))).toEqual(before);
  expect(fs.existsSync(dirnameFor(output))).toBe(false);
});

test('restore refuses an existing managed target before archive access or root writes', async () => {
  const target = managedRoot();
  const before = fs.readFileSync(join(target, '.gbrain', 'config.json'));
  await expect(restorePgliteBackup({ archive: join(target, 'not-an-archive'), into: target }).then(() => {
    throw new Error('expected refusal');
  })).rejects.toMatchObject({
    code: MANAGED_POSTGRES_UNSUPPORTED_CODE,
    message: MANAGED_POSTGRES_UNSUPPORTED_MESSAGE,
    operation: 'snapshot-replacement',
  });
  expect(fs.readFileSync(join(target, '.gbrain', 'config.json'))).toEqual(before);
  expect(fs.readdirSync(target).sort()).toEqual(['.gbrain']);
});

test('managed migration source refuses before touching the source engine', async () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'gbrain-managed-migrate-'));
  roots.push(home);
  fs.mkdirSync(join(home, '.gbrain'), { recursive: true });
  fs.writeFileSync(join(home, '.gbrain', 'config.json'), managedConfig);
  const previousHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = home;
  let calls = 0;
  try {
    await expect(runMigrateEngine({ executeRaw: async () => { calls++; return []; } } as never, ['--to', 'pglite']))
      .rejects.toMatchObject({ code: MANAGED_POSTGRES_UNSUPPORTED_CODE, message: MANAGED_POSTGRES_UNSUPPORTED_MESSAGE, operation: 'migration-source' });
    expect(calls).toBe(0);
    expect(fs.readdirSync(join(home, '.gbrain')).sort()).toEqual(['config.json']);
  } finally {
    if (previousHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = previousHome;
  }
});

function dirnameFor(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}
