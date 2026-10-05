import { describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyManagedInitPreflight,
  MANAGED_INIT_PREFLIGHT_REFUSAL_CODE,
  MANAGED_INIT_PREFLIGHT_REFUSAL_MESSAGE,
  ManagedInitPreflightRefusal,
  type ManagedInitPreflightInput,
} from '../src/core/managed-postgres/init-preflight.ts';
import { inspectManagedInitCommandEligibility, inspectManagedInitPreflight } from '../src/core/managed-postgres/init-preflight-observer.ts';
import {
  MANAGER_ID, NATIVE_POSTGRES_AUTO_CONF, captureInitializationReceipt, createOwner, managedPaths,
  writeInitializationReceipt, writeOwner, type OwnerMetadata, type SetupPhase,
} from '../src/core/managed-postgres/ownership.ts';
import { renderManagedPostgresConfig } from '../src/core/managed-postgres/identity.ts';

const id = '01234567-89ab-cdef-0123-456789abcdef';
const otherId = 'abcdef01-2345-6789-abcd-ef0123456789';

interface RealFixture { temp: string; configDir: string; root: string; paths: ReturnType<typeof managedPaths>; uid: number; }

function realFixture(): RealFixture {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-managed-init-')));
  const configDir = join(temp, '.gbrain');
  mkdirSync(configDir, { mode: 0o700 });
  const root = join(configDir, 'postgres', '17');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const paths = managedPaths(configDir, root);
  const uid = process.getuid?.() ?? -1;
  return { temp, configDir, root, paths, uid };
}

function observerInput(fixture: RealFixture, acceptedEnvironmentUrl = false) {
  return {
    configDir: fixture.configDir, root: fixture.root, uid: fixture.uid, acceptedEnvironmentUrl,
    canonicalPgliteArtifactPaths: [join(fixture.configDir, 'brain.pglite'), join(fixture.configDir, 'pglite')],
  };
}

function createOwnedFixture(fixture: RealFixture, phase: SetupPhase, interruptedAllocated = false): OwnerMetadata {
  for (const directory of [fixture.paths.data, fixture.paths.log, fixture.paths.socket]) mkdirSync(directory, { mode: 0o700 });
  const owner = createOwner(fixture.paths, fixture.uid, '/opt/postgresql@17', '17.2', '0.8.1', 55432, id);
  const shortSocket = join(fixture.temp, 's');
  mkdirSync(shortSocket, { mode: 0o700 });
  owner.socketPath = shortSocket;
  writeFileSync(join(shortSocket, '.gbrain-managed-owner'), `${MANAGER_ID}:${owner.clusterId}:${fixture.uid}`, { mode: 0o600 });
  owner.phase = phase;
  const password = 'p'.repeat(48);
  writeFileSync(fixture.paths.credentials, JSON.stringify({ password }), { mode: 0o600 });
  if (phase !== 'allocated' || interruptedAllocated) {
    owner.systemIdentifier = '123456789';
    writeFileSync(join(fixture.paths.data, 'PG_VERSION'), '17\n', { mode: 0o600 });
    const rendered = renderManagedPostgresConfig(owner, fixture.paths);
    writeFileSync(join(fixture.paths.data, 'postgresql.conf'), 'native initialized postgresql.conf\n', { mode: 0o600 });
    writeFileSync(join(fixture.paths.data, 'pg_hba.conf'), 'native initialized pg_hba.conf\n', { mode: 0o600 });
    writeFileSync(join(fixture.paths.data, 'postgresql.auto.conf'), NATIVE_POSTGRES_AUTO_CONF, { mode: 0o600 });
    const receipt = captureInitializationReceipt(fixture.paths, owner, fixture.uid, owner.systemIdentifier!);
    if (!interruptedAllocated) {
      writeFileSync(join(fixture.paths.data, 'postgresql.conf'), rendered.config, { mode: 0o600 });
      writeFileSync(join(fixture.paths.data, 'pg_hba.conf'), rendered.hba, { mode: 0o600 });
    }
    // The managed lifecycle clears PostgreSQL's auto config after initial receipt capture.
    writeFileSync(join(fixture.paths.data, 'postgresql.auto.conf'), '', { mode: 0o600 });
    if (phase !== 'allocated') writeFileSync(join(fixture.paths.root, 'pgpass'), `${owner.socketPath}:${owner.port}:*:${owner.role}:${password}\n`, { mode: 0o600 });
    writeInitializationReceipt(fixture.paths, receipt);
  }
  writeOwner(fixture.paths, owner);
  return owner;
}

function treeSnapshot(root: string): string {
  const entries: string[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    const relative = path.slice(root.length);
    entries.push(`${relative}:${stat.mode & 0o777}:${stat.uid}:${stat.size}:${stat.mtimeMs}`);
    if (stat.isSymbolicLink()) entries.push(`link:${readlinkSync(path)}`);
    else if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else if (stat.isFile()) entries.push(readFileSync(path).toString('base64'));
  };
  visit(root);
  return entries.join('\n');
}

function fixedRefusal(operation: () => unknown): void {
  try { operation(); throw new Error('expected refusal'); }
  catch (error) {
    expect(error).toBeInstanceOf(ManagedInitPreflightRefusal);
    expect((error as Error).message).toBe(MANAGED_INIT_PREFLIGHT_REFUSAL_MESSAGE);
  }
}

function base(): ManagedInitPreflightInput {
  const root = '/home/operator/.gbrain/postgres/17';
  const configDir = '/home/operator/.gbrain';
  const paths = {
    configDir, configFile: `${configDir}/config.json`, root, owner: `${root}/owner.json`, lock: `${root}/.lifecycle.lock`,
    credentials: `${root}/credentials.json`, receipt: `${root}/init-receipt.json`, data: `${root}/data`,
    log: `${root}/log`, socket: `${root}/socket`,
  };
  return {
    fileConfig: { kind: 'absent', path: paths.configFile, ancestrySafe: true, finalReread: true }, acceptedEnvironmentUrl: false,
    canonicalPgliteArtifacts: [
      { path: '/home/operator/.gbrain/brain.pglite', canonical: true, state: 'absent' },
      { path: '/home/operator/.gbrain/pglite', canonical: true, state: 'absent' },
    ],
    paths, uid: 501,
    root: { kind: 'absent', path: root, ancestrySafe: true },
    owner: { kind: 'absent', path: paths.owner },
    lock: { path: paths.lock, state: 'absent' },
  };
}

function managedConfig(clusterId = id) {
  return { kind: 'valid' as const, path: '/home/operator/.gbrain/config.json', fileType: 'regular' as const, ancestrySafe: true, finalReread: true, config: {
    engine: 'postgres',
    managed_postgres: { manager_id: 'gbrain-managed-postgres', cluster_id: clusterId },
    memory: { auto_writeback: 'off' },
  } };
}

function owned(input = base(), phase: SetupPhase = 'allocated', data: 'empty' | 'initialized' = phase === 'allocated' ? 'empty' : 'initialized') {
  const paths = input.paths;
  const owner: OwnerMetadata = {
    formatVersion: 1, managerId: 'gbrain-managed-postgres', clusterId: id, uid: input.uid,
    configPath: paths.configDir, rootPath: paths.root, dataPath: paths.data, pgMajor: 17,
    binaryPrefix: '/opt/postgresql@17', binaryVersion: '17.2', pgvectorVersion: '0.8.1',
    systemIdentifier: data === 'empty' ? null : '123456789', database: 'gbrain', role: 'gbrain',
    socketPath: paths.socket, port: 55432, phase, controller: 'manual',
  };
  const entries = ['owner.json', 'credentials.json', 'data', 'log', 'socket'];
  const receipt = data === 'initialized' ? 'complete' as const : 'absent' as const;
  if (receipt === 'complete') entries.push('init-receipt.json');
  if (phase !== 'allocated') entries.push('pgpass');
  input.root = { kind: 'directory', path: paths.root, ancestrySafe: true, safe: true, entries };
  input.owner = {
    kind: 'valid', path: paths.owner, owner, credentials: 'complete', receipt,
    configProvenance: 'complete', socketProvenance: 'complete', data,
  };
  return input;
}

function refusal(input: ManagedInitPreflightInput): void {
  try {
    classifyManagedInitPreflight(input);
    throw new Error('expected fixed managed-init refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedInitPreflightRefusal);
    expect((error as ManagedInitPreflightRefusal).code).toBe(MANAGED_INIT_PREFLIGHT_REFUSAL_CODE);
    expect((error as Error).message).toBe(MANAGED_INIT_PREFLIGHT_REFUSAL_MESSAGE);
  }
}

describe('managed-init preflight classifier', () => {
  test('absent config and metadata-only config classify fresh; a safely empty managed root is also fresh', () => {
    expect(classifyManagedInitPreflight(base())).toEqual({ kind: 'fresh' });
    const metadata = base();
    metadata.fileConfig = { ...managedConfig(), config: { memory: { auto_writeback: 'off' }, backup: { check_enabled: false } } };
    expect(classifyManagedInitPreflight(metadata)).toEqual({ kind: 'fresh' });
    const empty = base();
    empty.root = { kind: 'directory', path: empty.paths.root, ancestrySafe: true, safe: true, entries: [] };
    expect(classifyManagedInitPreflight(empty)).toEqual({ kind: 'fresh' });
  });

  test('classifier source exposes no process, package, network, engine or mutation APIs', () => {
    const source = readFileSync(join(import.meta.dir, '../src/core/managed-postgres/init-preflight.ts'), 'utf8');
    const observer = readFileSync(join(import.meta.dir, '../src/core/managed-postgres/init-preflight-observer.ts'), 'utf8');
    expect(source).not.toMatch(/child_process|managed-postgres\/packages|ProcessRunner|fetch\s*\(|writeFile|mkdirSync|createEngine|BrainEngine|process\./);
    expect(observer).toContain('O_NOFOLLOW');
    expect(observer).toContain('fstatSync');
    expect(observer).toContain("new TextDecoder('utf-8', { fatal: true })");
    expect(observer).toContain('const finalState = observeManagedState');
    expect(observer).toContain('const finalCommand = observeFullCommand');
    expect(observer).toContain('verifySession(session, input.uid)');
    expect(observer).not.toMatch(/\b(readOwner|readCredentials|readInitializationReceipt|assertPrivateFile|matchesInitializationOrManaged)\b|child_process|packages\.ts|fetch\s*\(|writeFile|mkdirSync|process\./);
  });

  test('refuses any engine, locator, topology, invalid file config or accepted URL observation', () => {
    for (const config of [
      { engine: undefined }, { engine: 'pglite' }, { engine: 'postgres' },
      { database_path: undefined }, { database_path: '/private/brain.pglite' },
      { database_url: 'postgresql://user:SECRET@host.invalid/db' },
      { remote_mcp: {} }, { thin_client: true }, { thin_client_url: 'https://secret.invalid' },
    ]) {
      const input = base();
      input.fileConfig = { ...managedConfig(), config };
      refusal(input);
    }
    for (const kind of ['malformed', 'unreadable', 'symlink', 'dangling-symlink', 'nonregular', 'ambiguous'] as const) {
      const input = base();
      input.fileConfig = { kind, path: input.paths.configFile };
      refusal(input);
    }
    for (const config of [null, 0, 'json scalar', [], ['array']]) {
      const input = base();
      input.fileConfig = { ...managedConfig(), config };
      refusal(input);
    }
    const noEngine = base();
    noEngine.fileConfig = { ...managedConfig(), config: { managed_postgres: { manager_id: 'gbrain-managed-postgres', cluster_id: id } } };
    refusal(noEngine);
    const unsafeAncestry = base();
    unsafeAncestry.fileConfig = { kind: 'absent', path: unsafeAncestry.paths.configFile, ancestrySafe: false, finalReread: true };
    refusal(unsafeAncestry);
    const staleRead = base();
    staleRead.fileConfig = { kind: 'absent', path: staleRead.paths.configFile, ancestrySafe: true, finalReread: false };
    refusal(staleRead);
    const environment = base();
    environment.acceptedEnvironmentUrl = true;
    refusal(environment);
  });

  test('refuses orphaned, ambiguous and noncanonical local PGLite artifacts', () => {
    for (const artifact of [
      { path: '/home/operator/.gbrain/brain.pglite', canonical: true, state: 'present' as const },
      { path: '/home/operator/.gbrain/brain.pglite', canonical: true, state: 'ambiguous' as const },
      { path: '/home/operator/.gbrain/brain.pglite', canonical: false, state: 'absent' as const },
    ]) {
      const input = base();
      input.canonicalPgliteArtifacts = [artifact];
      refusal(input);
    }
  });

  test('owned structural resumes accept each lifecycle phase; matching config is published-resume', () => {
    for (const phase of ['allocated', 'initialized', 'provisioned'] as const) {
      expect(classifyManagedInitPreflight(owned(base(), phase))).toEqual({ kind: 'owned-resume', phase, evidence: 'structural-only' });
    }
    const published = owned(base(), 'provisioned');
    published.fileConfig = managedConfig();
    expect(classifyManagedInitPreflight(published)).toEqual({ kind: 'published-resume', phase: 'provisioned', evidence: 'structural-only' });
    for (const phase of ['allocated', 'initialized'] as const) {
      const premature = owned(base(), phase);
      premature.fileConfig = managedConfig();
      refusal(premature);
    }
  });

  test('refuses missing/different ownership, ownerless roots, unknown root entries, unsafe ancestry and lock residue', () => {
    const missing = base(); missing.fileConfig = managedConfig(); refusal(missing);
    const different = owned(base(), 'provisioned'); different.fileConfig = managedConfig(otherId); refusal(different);
    for (const entries of [['unowned-file'], ['owner.json', 'unknown']]) {
      const root = base(); root.root = { kind: 'directory', path: root.paths.root, ancestrySafe: true, safe: true, entries }; refusal(root);
    }
    const unsafe = owned(base(), 'provisioned');
    unsafe.root = { ...unsafe.root, kind: 'directory', safe: false } as typeof unsafe.root;
    refusal(unsafe);
    const ancestry = owned(base(), 'provisioned');
    ancestry.root = { ...ancestry.root, kind: 'directory', ancestrySafe: false } as typeof ancestry.root;
    refusal(ancestry);
    for (const state of ['present', 'ambiguous'] as const) {
      const locked = owned(base(), 'allocated'); locked.lock = { path: locked.paths.lock, state }; refusal(locked);
    }
    const malformed = owned(base(), 'provisioned'); malformed.owner = { kind: 'malformed', path: malformed.paths.owner }; refusal(malformed);
    const malformedPayload = owned(base(), 'provisioned');
    (malformedPayload.owner as Extract<typeof malformedPayload.owner, { kind: 'valid' }>).owner = null as never;
    refusal(malformedPayload);
    const foreign = owned(base(), 'provisioned');
    (foreign.owner as Extract<typeof foreign.owner, { kind: 'valid' }>).owner.managerId = 'foreign-manager';
    refusal(foreign);
    const symlinked = base(); symlinked.root = { kind: 'ambiguous', path: symlinked.paths.root }; refusal(symlinked);
    const unsafeOwner = owned(base(), 'provisioned'); unsafeOwner.owner = { kind: 'unsafe', path: unsafeOwner.paths.owner }; refusal(unsafeOwner);
  });

  test('refuses incomplete credentials, receipts, config and socket provenance or ambiguous data', () => {
    const cases: Array<(input: ManagedInitPreflightInput) => void> = [
      (input) => { (input.owner as Extract<typeof input.owner, { kind: 'valid' }>).credentials = 'incomplete'; },
      (input) => { (input.owner as Extract<typeof input.owner, { kind: 'valid' }>).receipt = 'incomplete'; },
      (input) => { (input.owner as Extract<typeof input.owner, { kind: 'valid' }>).configProvenance = 'incomplete'; },
      (input) => { (input.owner as Extract<typeof input.owner, { kind: 'valid' }>).socketProvenance = 'incomplete'; },
      (input) => { (input.owner as Extract<typeof input.owner, { kind: 'valid' }>).data = 'ambiguous'; },
    ];
    for (const mutate of cases) { const input = owned(base(), 'provisioned'); mutate(input); refusal(input); }
    const allocatedWithUnexpectedReceipt = owned(base(), 'allocated');
    (allocatedWithUnexpectedReceipt.owner as Extract<typeof allocatedWithUnexpectedReceipt.owner, { kind: 'valid' }>).receipt = 'complete';
    refusal(allocatedWithUnexpectedReceipt);
  });

  test('all refusals redact observed config bytes, paths and cluster identifiers', () => {
    const input = base();
    input.fileConfig = { ...managedConfig(), config: { database_url: `postgresql://secret@invalid/${id}` } };
    let message = '';
    try { classifyManagedInitPreflight(input); } catch (error) { message = (error as Error).message; }
    expect(message).toBe(MANAGED_INIT_PREFLIGHT_REFUSAL_MESSAGE);
    expect(message).not.toContain('secret');
    expect(message).not.toContain(id);
    expect(message).not.toContain(input.paths.root);
  });

  test('real observer accepts absent/empty home, metadata-only config, and every structural owner phase without mutation', () => {
    const absentTemp = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-init-absent-')));
    const absent = { temp: absentTemp, configDir: join(absentTemp, 'home'), root: join(absentTemp, 'home', 'postgres', '17'),
      paths: managedPaths(join(absentTemp, 'home'), join(absentTemp, 'home', 'postgres', '17')), uid: process.getuid?.() ?? -1 };
    try {
      const before = treeSnapshot(absentTemp);
      expect(inspectManagedInitPreflight(observerInput(absent))).toEqual({ kind: 'fresh' });
      expect(treeSnapshot(absentTemp)).toBe(before);
    } finally { rmSync(absentTemp, { recursive: true, force: true }); }

    const empty = realFixture();
    try {
      expect(inspectManagedInitPreflight(observerInput(empty))).toEqual({ kind: 'fresh' });
      writeFileSync(join(empty.configDir, 'config.json'), JSON.stringify({ memory: { auto_writeback: 'off' } }), { mode: 0o600 });
      expect(inspectManagedInitPreflight(observerInput(empty))).toEqual({ kind: 'fresh' });
      rmSync(join(empty.configDir, 'config.json'));
    } finally { rmSync(empty.temp, { recursive: true, force: true }); }

    for (const phase of ['allocated', 'initialized', 'provisioned'] as const) {
      const fixture = realFixture();
      try {
        createOwnedFixture(fixture, phase);
        if (phase !== 'provisioned') {
          writeFileSync(join(fixture.configDir, 'config.json'), JSON.stringify({ engine: 'postgres', managed_postgres: { manager_id: MANAGER_ID, cluster_id: id } }), { mode: 0o600 });
          fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
          rmSync(join(fixture.configDir, 'config.json'));
        }
        const before = treeSnapshot(fixture.temp);
        expect(inspectManagedInitPreflight(observerInput(fixture))).toEqual({ kind: 'owned-resume', phase, evidence: 'structural-only' });
        expect(treeSnapshot(fixture.temp)).toBe(before);
      if (phase === 'provisioned') {
          const published = { engine: 'postgres', managed_postgres: { manager_id: MANAGER_ID, cluster_id: id }, memory: { auto_writeback: 'off' } };
          writeFileSync(join(fixture.configDir, 'config.json'), JSON.stringify(published), { mode: 0o600 });
          expect(inspectManagedInitPreflight(observerInput(fixture))).toEqual({ kind: 'published-resume', phase, evidence: 'structural-only' });
        }
      } finally { rmSync(fixture.temp, { recursive: true, force: true }); }
    }
  });

  test('allocated interrupted init accepts receipt evidence; published phases require exact managed bytes', () => {
    const interrupted = realFixture();
    try {
      createOwnedFixture(interrupted, 'allocated', true);
      expect(inspectManagedInitPreflight(observerInput(interrupted))).toEqual({ kind: 'owned-resume', phase: 'allocated', evidence: 'structural-only' });
    } finally { rmSync(interrupted.temp, { recursive: true, force: true }); }

    for (const phase of ['initialized', 'provisioned'] as const) {
      for (const file of ['postgresql.conf', 'pg_hba.conf', 'postgresql.auto.conf']) {
        const fixture = realFixture();
        try {
          createOwnedFixture(fixture, phase);
          writeFileSync(join(fixture.paths.data, file), 'hash-valid-but-not-lifecycle-managed\n', { mode: 0o600 });
          fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
        } finally { rmSync(fixture.temp, { recursive: true, force: true }); }
      }
    }
  });

  test('real observer refuses target conflicts, malformed/nonregular/oversize config, and config symlinks', () => {
    const fixture = realFixture();
    const configPath = join(fixture.configDir, 'config.json');
    try {
      for (const config of [
        { engine: 'postgres' },
        { managed_postgres: { manager_id: MANAGER_ID, cluster_id: id } },
        { engine: 'postgres', managed_postgres: { manager_id: MANAGER_ID, cluster_id: otherId } },
        { engine: 'postgres', managed_postgres: { manager_id: MANAGER_ID, cluster_id: id }, database_url: 'postgres://secret' },
        null, [], 7,
      ]) {
        writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
        const before = treeSnapshot(fixture.temp);
        fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
        expect(treeSnapshot(fixture.temp)).toBe(before);
        rmSync(configPath);
      }
      writeFileSync(configPath, '{ malformed', { mode: 0o600 });
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
      rmSync(configPath);
      writeFileSync(configPath, Buffer.from([0xff, 0xfe]), { mode: 0o600 });
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
      rmSync(configPath);
      writeFileSync(configPath, ' '.repeat(1024 * 1024 + 1), { mode: 0o600 });
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
      rmSync(configPath);
      mkdirSync(configPath, { mode: 0o700 });
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
      rmSync(configPath, { recursive: true });
      const target = join(fixture.temp, 'target-config.json');
      writeFileSync(target, '{}', { mode: 0o600 });
      symlinkSync(target, configPath);
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
      rmSync(configPath);
      symlinkSync(join(fixture.temp, 'missing-target'), configPath);
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
      rmSync(configPath);
    } finally { rmSync(fixture.temp, { recursive: true, force: true }); }
  });

  test('real observer rejects config/root/ancestor symlinks, artifacts, lock residue and incomplete ownership', () => {
    const fixture = realFixture();
    try {
      const linkedHome = join(fixture.temp, 'home-link');
      symlinkSync(fixture.configDir, linkedHome);
      fixedRefusal(() => inspectManagedInitPreflight({ ...observerInput(fixture), configDir: linkedHome, root: join(linkedHome, 'postgres', '17') }));
      const danglingParent = join(fixture.temp, 'dangling-parent');
      symlinkSync(join(fixture.temp, 'not-created'), danglingParent);
      fixedRefusal(() => inspectManagedInitPreflight({ ...observerInput(fixture), configDir: join(danglingParent, 'home'), root: join(danglingParent, 'home', 'postgres', '17') }));

      const externalRoot = join(fixture.temp, 'external-root');
      mkdirSync(externalRoot, { mode: 0o700 });
      rmSync(fixture.root, { recursive: true });
      symlinkSync(externalRoot, fixture.root);
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
      rmSync(fixture.root);
      mkdirSync(fixture.root, { mode: 0o700 });
      rmSync(fixture.root, { recursive: true });
      symlinkSync(join(fixture.temp, 'missing-root'), fixture.root);
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
      rmSync(fixture.root);
      mkdirSync(fixture.root, { mode: 0o700 });

      const artifact = join(fixture.configDir, 'brain.pglite');
      writeFileSync(artifact, 'artifact', { mode: 0o600 });
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
      rmSync(artifact);
      symlinkSync(join(fixture.temp, 'missing-artifact'), artifact);
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
      rmSync(artifact);

      mkdirSync(fixture.paths.lock, { mode: 0o700 });
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
      rmSync(fixture.paths.lock, { recursive: true });

      chmodSync(fixture.configDir, 0o777);
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
      chmodSync(fixture.configDir, 0o700);

      createOwnedFixture(fixture, 'allocated');
      rmSync(fixture.paths.credentials);
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(fixture)));
    } finally { rmSync(fixture.temp, { recursive: true, force: true }); }
  });

  test('command-only eligibility classifies publication without touching lifecycle state', () => {
    const fixture = realFixture();
    const input = {
      configDir: fixture.configDir, uid: fixture.uid, acceptedEnvironmentUrl: false,
      canonicalPgliteArtifactPaths: [join(fixture.configDir, 'brain.pglite')],
    };
    try {
      expect(inspectManagedInitCommandEligibility(input)).toEqual({ kind: 'unpublished' });
      writeFileSync(join(fixture.configDir, 'config.json'), JSON.stringify({ memory: { auto_writeback: 'off' } }), { mode: 0o600 });
      expect(inspectManagedInitCommandEligibility(input)).toEqual({ kind: 'unpublished' });
      writeFileSync(join(fixture.configDir, 'config.json'), JSON.stringify({ engine: 'postgres', managed_postgres: { manager_id: MANAGER_ID, cluster_id: id } }), { mode: 0o600 });
      const before = treeSnapshot(fixture.temp);
      expect(inspectManagedInitCommandEligibility(input)).toEqual({ kind: 'published', reference: { manager_id: MANAGER_ID, cluster_id: id } });
      expect(treeSnapshot(fixture.temp)).toBe(before);
      fixedRefusal(() => inspectManagedInitCommandEligibility({ ...input, acceptedEnvironmentUrl: true }));
      writeFileSync(join(fixture.configDir, 'brain.pglite'), 'pglite', { mode: 0o600 });
      fixedRefusal(() => inspectManagedInitCommandEligibility(input));
    } finally { rmSync(fixture.temp, { recursive: true, force: true }); }
  });

  test('nested owner, data, marker and root-entry substitutions refuse without revealing contents', () => {
    const ownerFixture = realFixture();
    try {
      createOwnedFixture(ownerFixture, 'allocated');
      const ownerTarget = join(ownerFixture.temp, 'owner-copy');
      writeFileSync(ownerTarget, readFileSync(ownerFixture.paths.owner), { mode: 0o600 });
      rmSync(ownerFixture.paths.owner);
      symlinkSync(ownerTarget, ownerFixture.paths.owner);
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(ownerFixture)));
    } finally { rmSync(ownerFixture.temp, { recursive: true, force: true }); }

    const dataFixture = realFixture();
    try {
      createOwnedFixture(dataFixture, 'allocated', true);
      const version = join(dataFixture.paths.data, 'PG_VERSION');
      rmSync(version);
      symlinkSync(join(dataFixture.temp, 'version-copy'), version);
      writeFileSync(join(dataFixture.temp, 'version-copy'), '17\n', { mode: 0o600 });
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(dataFixture)));
    } finally { rmSync(dataFixture.temp, { recursive: true, force: true }); }

    const markerFixture = realFixture();
    try {
      createOwnedFixture(markerFixture, 'allocated');
      const marker = join(markerFixture.temp, 's', '.gbrain-managed-owner');
      const markerCopy = join(markerFixture.temp, 'marker-copy');
      writeFileSync(markerCopy, readFileSync(marker), { mode: 0o600 });
      rmSync(marker);
      symlinkSync(markerCopy, marker);
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(markerFixture)));
      writeFileSync(join(markerFixture.paths.root, 'foreign-entry'), 'must not be reported');
      fixedRefusal(() => inspectManagedInitPreflight(observerInput(markerFixture)));
    } finally { rmSync(markerFixture.temp, { recursive: true, force: true }); }
  });

  test('verified /var alias is accepted and sticky root-owned writable ancestry is allowed', () => {
    const fixture = realFixture();
    try {
      let varReal = '';
      try { varReal = realpathSync('/var'); } catch { /* platform has no /var alias */ }
      if (varReal === '/private/var' && fixture.configDir.startsWith('/private/var/')) {
        const alias = (path: string) => `/var${path.slice('/private/var'.length)}`;
        expect(inspectManagedInitCommandEligibility({
          configDir: alias(fixture.configDir), uid: fixture.uid, acceptedEnvironmentUrl: false,
          canonicalPgliteArtifactPaths: [alias(join(fixture.configDir, 'brain.pglite'))],
        })).toEqual({ kind: 'unpublished' });
      }
      // macOS's /private/tmp is root-owned and sticky; this confirms the ancestry policy permits that exact safe mode.
      const tempParent = realpathSync('/tmp');
      const parentStat = lstatSync(tempParent);
      if (parentStat.uid === 0 && (parentStat.mode & 0o1000) !== 0) {
        const nested = realpathSync(mkdtempSync(join(tempParent, 'gbrain-sticky-')));
        try {
          expect(inspectManagedInitCommandEligibility({
            configDir: nested, uid: fixture.uid, acceptedEnvironmentUrl: false,
            canonicalPgliteArtifactPaths: [join(nested, 'brain.pglite')],
          })).toEqual({ kind: 'unpublished' });
        } finally { rmSync(nested, { recursive: true, force: true }); }
      }
    } finally { rmSync(fixture.temp, { recursive: true, force: true }); }
  });

  test('observer race hooks refuse path swaps, same-inode edits and late artifact appearance', () => {
    const replaced = realFixture();
    try {
      const config = join(replaced.configDir, 'config.json');
      writeFileSync(config, JSON.stringify({ memory: { auto_writeback: 'off' } }), { mode: 0o600 });
      let swapped = false;
      let configChecks = 0;
      const result = () => inspectManagedInitPreflight({ ...observerInput(replaced), testHooks: {
        afterInitialLstat(path) {
          if (path !== config || swapped || ++configChecks < 2) return;
          swapped = true;
          const replacement = join(replaced.configDir, 'replacement.json');
          writeFileSync(replacement, JSON.stringify({ memory: { auto_writeback: 'off' } }), { mode: 0o600 });
          renameSync(config, join(replaced.configDir, 'old-config.json'));
          renameSync(replacement, config);
        },
      } });
      fixedRefusal(result);
    } finally { rmSync(replaced.temp, { recursive: true, force: true }); }

    const edited = realFixture();
    try {
      const config = join(edited.configDir, 'config.json');
      writeFileSync(config, JSON.stringify({ memory: { auto_writeback: 'off' } }), { mode: 0o600 });
      let modified = false;
      fixedRefusal(() => inspectManagedInitPreflight({ ...observerInput(edited), testHooks: {
        afterDescriptorRead(path) {
          if (path === config && !modified) { modified = true; writeFileSync(path, '{"secret":"not-for-errors"}', { mode: 0o600 }); }
        },
      } }));
    } finally { rmSync(edited.temp, { recursive: true, force: true }); }

    const artifact = realFixture();
    try {
      const pglite = join(artifact.configDir, 'brain.pglite');
      fixedRefusal(() => inspectManagedInitPreflight({ ...observerInput(artifact), testHooks: {
        beforeFinalArtifactVerification() { writeFileSync(pglite, 'private-artifact', { mode: 0o600 }); },
      } }));
    } finally { rmSync(artifact.temp, { recursive: true, force: true }); }
  });

  test('rejects foreign-owned intermediate ancestry via the lstat-only test seam', () => {
    const fixture = realFixture();
    try {
      let injected = false;
      fixedRefusal(() => inspectManagedInitPreflight({ ...observerInput(fixture), testHooks: {
        lstatSync(path: string) {
          const stat = lstatSync(path);
          if (path === fixture.configDir && !injected) {
            injected = true;
            return new Proxy(stat, { get(target, property, receiver) { return property === 'uid' ? fixture.uid + 1 : Reflect.get(target, property, receiver); } });
          }
          return stat;
        },
      } }));
      expect(injected).toBe(true);
    } finally { rmSync(fixture.temp, { recursive: true, force: true }); }
  });
});
