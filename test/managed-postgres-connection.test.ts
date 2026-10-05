import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveManagedPostgresConnection, ManagedPostgresConnectionError } from '../src/core/managed-postgres/connection.ts';
import { createManagedPostgresCandidate, ManagedPostgresPoolError } from '../src/core/managed-postgres-pool.ts';
import { renderManagedPostgresConfig, verifyManagedPostgresLiveIdentity, type LiveIdentity } from '../src/core/managed-postgres/identity.ts';
import { captureInitializationReceipt, createOwner, managedPaths, NATIVE_POSTGRES_AUTO_CONF, readOwner, writeInitializationReceipt, writeOwner } from '../src/core/managed-postgres/ownership.ts';

const roots: string[] = [];
const secret = 'x'.repeat(48);
const ref = (cluster_id: string) => ({ manager_id: 'gbrain-managed-postgres' as const, cluster_id });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'mpc-')); roots.push(root);
  const configDir = join(root, 'config with spaces'); mkdirSync(configDir, { mode: 0o700 });
  const paths = managedPaths(configDir), uid = process.getuid?.() ?? 1;
  for (const path of [paths.root, paths.data, paths.log, paths.socket, join(paths.data, 'global'), join(paths.data, 'pg_wal'), join(paths.data, 'pg_tblspc')]) mkdirSync(path, { mode: 0o700, recursive: true });
  const clusterId = randomUUID(), owner = createOwner(paths, uid, '/brew/opt/postgresql@17', '17.5', '0.8.0', 55432, clusterId);
  owner.phase = 'provisioned'; owner.systemIdentifier = '123456789';
  const managed = renderManagedPostgresConfig(owner, paths);
  const privateFile = (path: string, body: string) => writeFileSync(path, body, { mode: 0o600 });
  privateFile(join(paths.data, 'postgresql.conf'), managed.config);
  privateFile(join(paths.data, 'pg_hba.conf'), managed.hba);
  privateFile(join(paths.data, 'postgresql.auto.conf'), NATIVE_POSTGRES_AUTO_CONF);
  privateFile(join(paths.data, 'PG_VERSION'), '17\n');
  privateFile(join(paths.data, 'global', 'pg_control'), 'control');
  privateFile(paths.credentials, JSON.stringify({ password: secret }));
  writeOwner(paths, owner);
  const receipt = captureInitializationReceipt(paths, owner, uid, owner.systemIdentifier);
  writeInitializationReceipt(paths, receipt);
  privateFile(join(paths.data, 'postgresql.auto.conf'), '');
  return { configDir, paths, owner, uid, reference: ref(clusterId) };
}

function live(f: ReturnType<typeof fixture>, patch: Partial<LiveIdentity> = {}): LiveIdentity {
  return { data_directory: f.owner.dataPath, server_version_num: 170005, port: f.owner.port, database: f.owner.database,
    role: f.owner.role, system_identifier: f.owner.systemIdentifier!, listen_addresses: '127.0.0.1', socket_directories: f.owner.socketPath,
    config_file: join(f.paths.data, 'postgresql.conf'), hba_file: join(f.paths.data, 'pg_hba.conf'), password_encryption: 'scram-sha-256', ...patch };
}

describe('managed PostgreSQL connection resolver', () => {
  it('marks the fixed public resolver error as target_unverified', () => {
    const error = new ManagedPostgresConnectionError();
    expect(error.code).toBe('target_unverified');
    expect(error.message).toBe('Managed PostgreSQL connection target is unavailable or could not be verified.');
  });

  it('resolves a provisioned app database to a secret-free full socket filename', async () => {
    const f = fixture();
    const result = resolveManagedPostgresConnection(f.reference, { configDir: f.configDir, uid: f.uid });
    expect(result.identity).toBe(`postgres-managed:v1:gbrain-managed-postgres:${f.owner.clusterId}`);
    expect(result.options).toMatchObject({ path: join(f.owner.socketPath, '.s.PGSQL.55432'), port: 55432, database: 'gbrain', user: 'gbrain', ssl: false, debug: false });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).not.toHaveProperty('url'); expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('paths'); expect(result).not.toHaveProperty('expectedOwner'); expect(result).not.toHaveProperty('expectedLiveIdentity');
    expect(await result.options.password()).toBe(secret);
    expect(() => result.assertPinnedState()).not.toThrow();
    expect(verifyManagedPostgresLiveIdentity(live(f), f.owner, f.paths, 'gbrain')).not.toBeNull();
    expect(verifyManagedPostgresLiveIdentity(live(f), f.owner, f.paths, 'postgres')).toBeNull();
    expect(result.verifyLiveIdentity(live(f))).toEqual(live(f));
    expect(() => result.verifyLiveIdentity(live(f, { database: 'postgres' }))).toThrow(ManagedPostgresConnectionError);
  });

  it('re-reads credentials for each challenge and observes protected rotation', async () => {
    const f = fixture(), resolution = resolveManagedPostgresConnection(f.reference, { configDir: f.configDir, uid: f.uid });
    expect(await resolution.options.password()).toBe(secret);
    const rotated = 'rotated-' + 'z'.repeat(48);
    writeFileSync(f.paths.credentials, JSON.stringify({ password: rotated }), { mode: 0o600 }); chmodSync(f.paths.credentials, 0o600);
    expect(await resolution.options.password()).toBe(rotated);
  });

  it('uses one generic error for invalid references and post-resolution state changes', async () => {
    const f = fixture();
    expect(() => resolveManagedPostgresConnection({ ...f.reference, cluster_id: 'not-a-uuid' }, { configDir: f.configDir, uid: f.uid })).toThrow(ManagedPostgresConnectionError);
    expect(() => resolveManagedPostgresConnection(ref('00000000-0000-4000-8000-000000000099'), { configDir: f.configDir, uid: f.uid })).toThrow(ManagedPostgresConnectionError);
    const resolution = resolveManagedPostgresConnection(f.reference, { configDir: f.configDir, uid: f.uid });
    chmodSync(f.paths.credentials, 0o644);
    await expect(resolution.options.password()).rejects.toMatchObject({ message: 'Managed PostgreSQL connection target is unavailable or could not be verified.' });
  });

  it('rejects non-provisioned, missing-identity, and tampered config states without changing bytes', () => {
    const f = fixture(), config = join(f.paths.data, 'postgresql.conf'), original = readFileSync(config);
    writeFileSync(config, `${original.toString()}# tampered\n`, { mode: 0o600 });
    const tampered = readFileSync(config);
    expect(() => resolveManagedPostgresConnection(f.reference, { configDir: f.configDir, uid: f.uid })).toThrow(ManagedPostgresConnectionError);
    expect(readFileSync(config)).toEqual(tampered);
  });

  it('refuses changed owner, receipt, HBA, auto-conf, credential mode, and symlink state read-only', () => {
    const cases = ['phase', 'null-id', 'wrong-id', 'receipt', 'receipt-symlink', 'hba', 'auto-conf', 'credential-mode', 'config-symlink', 'credential-symlink'] as const;
    for (const kind of cases) {
      const f = fixture(), ownerFile = readOwner(f.paths, f.uid);
      if (kind === 'phase') { ownerFile.phase = 'initialized'; writeOwner(f.paths, ownerFile); }
      if (kind === 'null-id') { ownerFile.systemIdentifier = null; writeOwner(f.paths, ownerFile); }
      if (kind === 'wrong-id') { ownerFile.systemIdentifier = '987654321'; writeOwner(f.paths, ownerFile); }
      if (kind === 'receipt') writeFileSync(f.paths.receipt, '{}', { mode: 0o600 });
      if (kind === 'receipt-symlink') {
        const outside = join(f.paths.root, 'foreign-receipt');
        writeFileSync(outside, readFileSync(f.paths.receipt), { mode: 0o600 }); unlinkSync(f.paths.receipt); symlinkSync(outside, f.paths.receipt);
      }
      if (kind === 'hba') writeFileSync(join(f.paths.data, 'pg_hba.conf'), 'local all all trust\n', { mode: 0o600 });
      if (kind === 'auto-conf') writeFileSync(join(f.paths.data, 'postgresql.auto.conf'), 'port = 54333\n', { mode: 0o600 });
      if (kind === 'credential-mode') chmodSync(f.paths.credentials, 0o644);
      if (kind === 'credential-symlink') {
        const outside = join(f.paths.root, 'foreign-credentials');
        writeFileSync(outside, readFileSync(f.paths.credentials), { mode: 0o600 }); unlinkSync(f.paths.credentials); symlinkSync(outside, f.paths.credentials);
      }
      if (kind === 'config-symlink') {
        const config = join(f.paths.data, 'postgresql.conf'), outside = join(f.paths.root, 'foreign-config');
        writeFileSync(outside, readFileSync(config), { mode: 0o600 }); unlinkSync(config); symlinkSync(outside, config);
      }
      const watched = [f.paths.owner, f.paths.receipt, f.paths.credentials, join(f.paths.data, 'postgresql.conf'), join(f.paths.data, 'pg_hba.conf'), join(f.paths.data, 'postgresql.auto.conf')];
      const before = watched.map(path => { try { return [readFileSync(path), statSync(path).mode & 0o777] as const; } catch { return null; } });
      expect(() => resolveManagedPostgresConnection(f.reference, { configDir: f.configDir, uid: f.uid })).toThrow(ManagedPostgresConnectionError);
      const after = watched.map(path => { try { return [readFileSync(path), statSync(path).mode & 0o777] as const; } catch { return null; } });
      expect(after).toEqual(before);
    }
  });

  it('rejects owner provenance replacement after resolution with fixed generic callback errors', async () => {
    const f = fixture(), resolution = resolveManagedPostgresConnection(f.reference, { configDir: f.configDir, uid: f.uid });
    const changed = readOwner(f.paths, f.uid); changed.binaryVersion = '17.6'; writeOwner(f.paths, changed);
    await expect(resolution.options.password()).rejects.toMatchObject({
      name: 'ManagedPostgresConnectionError', code: 'target_unverified', message: 'Managed PostgreSQL connection target is unavailable or could not be verified.',
    });
    expect(() => resolution.assertPinnedState()).toThrow(ManagedPostgresConnectionError);
    expect(() => resolution.verifyLiveIdentity(live(f))).toThrow('Managed PostgreSQL connection target is unavailable or could not be verified.');
  });

  it('checks every live identity field and required numeric shape against the application database', () => {
    const f = fixture(), good = live(f);
    expect(verifyManagedPostgresLiveIdentity(good, f.owner, f.paths, 'gbrain')).toEqual(good);
    const invalid: Array<Partial<LiveIdentity>> = [
      { data_directory: '' }, { database: 'postgres' }, { role: 'other' }, { system_identifier: 'wrong' },
      { data_directory: '/foreign' }, { config_file: '/foreign/postgresql.conf' }, { hba_file: '/foreign/pg_hba.conf' },
      { socket_directories: '/foreign/socket' }, { port: 55433 }, { server_version_num: 160000 },
      { server_version_num: Number.NaN }, { server_version_num: '170005' as unknown as number },
      { listen_addresses: '*' }, { password_encryption: 'md5' },
    ];
    for (const patch of invalid) expect(verifyManagedPostgresLiveIdentity({ ...good, ...patch }, f.owner, f.paths, 'gbrain')).toBeNull();
    const missing = { ...good } as Record<string, unknown>; delete missing.role;
    expect(verifyManagedPostgresLiveIdentity(missing, f.owner, f.paths, 'gbrain')).toBeNull();
  });
});

describe('managed PostgreSQL candidate query classification', () => {
  async function attempt(f: ReturnType<typeof fixture>, query: (pool: unknown, password: () => Promise<string>) => Promise<unknown>) {
    const pool = { unsafe: async () => [], end: async () => {} };
    let closes = 0;
    let password: (() => Promise<string>) | undefined;
    const error = await createManagedPostgresCandidate(
      { engine: 'postgres', managed_postgres: f.reference } as never,
      {},
      {
        resolve: resolveManagedPostgresConnection,
        configDir: () => f.configDir,
        create: ((options: Record<string, unknown>) => { password = options.password as () => Promise<string>; return pool; }) as never,
        end: async () => { closes++; },
        query: ((value: unknown) => query(value, password!)) as never,
      },
    ).then(() => null, reason => reason);
    return { error, closes };
  }

  it('classifies signature mismatch as target_unverified and closes once', async () => {
    const f = fixture();
    const outcome = await attempt(f, async () => { throw Object.assign(new Error('sensitive driver text'), { code: 'SASL_SIGNATURE_MISMATCH' }); });
    expect(outcome.error).toBeInstanceOf(ManagedPostgresPoolError);
    expect(outcome.error).toMatchObject({ kind: 'target_unverified', message: 'Managed PostgreSQL pool could not be constructed or verified.' });
    expect(outcome.closes).toBe(1);
  });

  it('latches callback refusal even when pinned files are restored before query rejection', async () => {
    const f = fixture();
    const ownerBytes = readFileSync(f.paths.owner);
    const outcome = await attempt(f, async (_pool, password) => {
      writeFileSync(f.paths.owner, '{}', { mode: 0o600 });
      await expect(password()).rejects.toBeInstanceOf(ManagedPostgresConnectionError);
      writeFileSync(f.paths.owner, ownerBytes, { mode: 0o600 });
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    });
    expect(outcome.error).toMatchObject({ kind: 'target_unverified' });
    expect(outcome.closes).toBe(1);
  });

  it('keeps the unavailable classification only for recognized transport codes', async () => {
    const outcome = await attempt(fixture(), async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); });
    expect(outcome.error).toMatchObject({ kind: 'unavailable' });
    expect(outcome.closes).toBe(1);
  });

  it('fails unknown secret-bearing query errors closed without reflecting details', async () => {
    const f = fixture();
    const rawUuid = f.owner.clusterId;
    const outcome = await attempt(f, async () => { throw new Error(`postgres://user:${secret}@${f.paths.socket}/${rawUuid}`); });
    expect(outcome.error).toMatchObject({ kind: 'target_unverified', message: 'Managed PostgreSQL pool could not be constructed or verified.' });
    expect(JSON.stringify(outcome.error)).not.toMatch(new RegExp(`${secret}|${f.paths.root}|${rawUuid}|postgres:`));
    expect(outcome.closes).toBe(1);
  });
});
