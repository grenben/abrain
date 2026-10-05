import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteBackup, restorePgliteBackup } from '../src/core/backup/snapshot.ts';
import { MANAGED_POSTGRES_UNSUPPORTED_CODE, MANAGED_POSTGRES_UNSUPPORTED_MESSAGE } from '../src/core/managed-postgres-unsupported.ts';
import { runMigrateEngine } from '../src/commands/migrate-engine.ts';
import { readBackupArchive, writeBackupArchive } from '../src/core/backup/archive.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

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

test.each([
  ['mixed managed target', {
    engine: 'pglite', database_path: '/attacker/database', managed_postgres: {
      manager_id: 'gbrain-managed-postgres', cluster_id: '01234567-89ab-cdef-0123-456789abcdef',
    },
  }, 'EngineTargetError'],
  ['malformed managed reference', {
    engine: 'pglite', managed_postgres: { manager_id: 'attacker-value', cluster_id: 'not-a-uuid' },
  }, 'EngineTargetError'],
  ['valid managed reference', {
    engine: 'postgres', managed_postgres: {
      manager_id: 'gbrain-managed-postgres', cluster_id: '01234567-89ab-cdef-0123-456789abcdef',
    },
  }, 'ManagedPostgresUnsupportedError'],
])('archived %s is refused before dump loading or engine connection', async (_label, config, expectedName) => {
  const parent = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'gbrain-archived-target-'));
  roots.push(parent);
  const archive = join(parent, 'untrusted.gbrain-backup');
  const into = join(parent, 'restore-target');
  const database = join(parent, 'database.tar');
  const archivedConfig = join(parent, 'config.json');
  fs.writeFileSync(database, 'not a PGLite dump');
  fs.writeFileSync(archivedConfig, JSON.stringify(config));
  await writeBackupArchive(archive, {
    kind: 'gbrain-pglite', created_at: new Date().toISOString(), gbrain_version: 'test',
    schema_version: 1, original_root: join(parent, 'original'),
    classification: 'sensitive-full-database-state', sources: [], omitted: [],
    credential_references: [], managed_paths: [], installation: null,
  }, [
    { path: 'database.tar', file: database },
    { path: 'config.json', file: archivedConfig },
  ]);

  const connect = spyOn(PGLiteEngine.prototype, 'connectForRestore');
  try {
    const failure = await restorePgliteBackup({ archive, into }).then(
      () => { throw new Error('expected archived target refusal'); },
      error => error,
    );
    expect(failure.name).toBe(expectedName);
    expect(failure.message).not.toContain('attacker-value');
    expect(failure.message).not.toContain('/attacker/database');
    expect(connect).not.toHaveBeenCalled();
    expect(fs.existsSync(join(into, 'restore-receipt.json'))).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(join(into, 'restore-receipt.json'), 'utf8'));
    expect(receipt.state).toBe('failed');
    expect(receipt.original_preserved).toBe(true);
    expect(fs.readdirSync(into).some(name => name === 'restored')).toBe(false);
    const stageName = fs.readdirSync(into).find(name => name.startsWith('.restore-'));
    expect(stageName).toBeDefined();
    expect(fs.readdirSync(join(into, stageName!, 'payload'))).toEqual([]);
  } finally {
    connect.mockRestore();
  }
});

test('archive pre-extraction callback reads verified entries before output, and default extraction is unchanged', async () => {
  const parent = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'gbrain-archive-callback-'));
  roots.push(parent);
  const configFile = join(parent, 'config.json');
  const dataFile = join(parent, 'database.tar');
  const archive = join(parent, 'archive.gbrain-backup');
  const plainArchive = join(parent, 'plain.gbrain-backup');
  fs.writeFileSync(configFile, JSON.stringify({ engine: 'pglite' }));
  fs.writeFileSync(dataFile, 'payload');
  const metadata = { kind: 'test' };
  await writeBackupArchive(archive, metadata, [
    { path: 'config.json', file: configFile },
    { path: 'database.tar', file: dataFile },
  ]);
  await writeBackupArchive(plainArchive, metadata, [
    { path: 'config.json', file: configFile },
    { path: 'database.tar', file: dataFile },
  ]);

  const destination = join(parent, 'callback-output');
  fs.mkdirSync(destination);
  let callbackCalled = false;
  readBackupArchive(archive, destination, {
    beforeExtract: (manifest, readVerifiedEntry) => {
      callbackCalled = true;
      expect(manifest.entries.map(entry => entry.path)).toEqual(['config.json', 'database.tar']);
      expect(readVerifiedEntry('config.json', 1024).toString()).toBe(JSON.stringify({ engine: 'pglite' }));
      expect(() => readVerifiedEntry('missing', 1024)).toThrow('Requested backup entry is missing.');
      expect(() => readVerifiedEntry('database.tar', 2)).toThrow('Backup entry exceeds the verification read limit.');
      expect(fs.readdirSync(destination)).toEqual([]);
    },
  });
  expect(callbackCalled).toBe(true);
  expect(fs.readFileSync(join(destination, 'config.json'), 'utf8')).toBe(JSON.stringify({ engine: 'pglite' }));
  expect(fs.readFileSync(join(destination, 'database.tar'), 'utf8')).toBe('payload');

  const ordinaryDestination = join(parent, 'ordinary-output');
  fs.mkdirSync(ordinaryDestination);
  readBackupArchive(plainArchive, ordinaryDestination);
  expect(fs.readFileSync(join(ordinaryDestination, 'config.json'), 'utf8')).toBe(JSON.stringify({ engine: 'pglite' }));
  expect(fs.readFileSync(join(ordinaryDestination, 'database.tar'), 'utf8')).toBe('payload');

  const corruptArchive = join(parent, 'corrupt.gbrain-backup');
  const corrupted = fs.readFileSync(archive);
  const configOffset = corrupted.indexOf(Buffer.from(JSON.stringify({ engine: 'pglite' })));
  expect(configOffset).toBeGreaterThan(0);
  corrupted[configOffset] ^= 1;
  fs.writeFileSync(corruptArchive, corrupted);
  const corruptDestination = join(parent, 'corrupt-output');
  fs.mkdirSync(corruptDestination);
  expect(() => readBackupArchive(corruptArchive, corruptDestination, {
    beforeExtract: (_manifest, readVerifiedEntry) => readVerifiedEntry('config.json', 1024),
  })).toThrow('Backup checksum mismatch.');
  expect(fs.readdirSync(corruptDestination)).toEqual([]);
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
