/** Package provenance/architecture and consent parsing are deterministic; never invoke Homebrew. */
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { HOMEBREW_SAFE_ENV, inspectPackages, planPackageImpact, PG_BINARIES } from '../src/core/managed-postgres/packages.ts';
import { ProcessCancelledError, type ProcessRunner } from '../src/core/managed-postgres/process.ts';

function fixture(opts: { installed?: boolean; arch?: string; prefix?: string; wrongVersion?: string; binaryVersion?: string; versionOutputs?: Record<string, string>; missingBinary?: string; missingVector?: string; wrongArch?: string; universal?: boolean; malformedLipo?: boolean; escapeArtifact?: string; nonRegular?: string; mixedUtility?: string } = {}) {
  const installed = opts.installed ?? true, hostPrefix = opts.prefix ?? '/opt/homebrew', pgPrefix = `${hostPrefix}/opt/postgresql@17`, vectorPrefix = `${hostPrefix}/opt/pgvector`;
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: ProcessRunner = async (file, args) => {
    calls.push({ file, args });
    const joined = args.join(' ');
    let stdout = '';
    if (file === '/brew/brew') {
      if (joined === '--prefix') stdout = hostPrefix;
      else if (joined === '--prefix postgresql@17') stdout = installed ? pgPrefix : '';
      else if (joined === '--prefix pgvector') stdout = installed ? vectorPrefix : '';
      else if (joined === 'list --versions postgresql@17') stdout = installed ? `postgresql@17 ${opts.wrongVersion ?? '17.5'}` : '';
      else if (joined === 'list --versions pgvector') stdout = installed ? 'pgvector 0.8.0' : '';
      else throw new Error(`Unexpected fake brew call: ${joined}`);
    } else if (file === '/usr/sbin/sysctl' && args.join(' ') === '-in sysctl.proc_translated') stdout = '0';
    else if (file === '/usr/bin/lipo' && args[0] === '-archs') {
      if (opts.malformedLipo) stdout = 'lipo: unknown format';
      else stdout = opts.wrongArch === args[1] ? 'i386' : opts.universal ? 'arm64 x86_64' : (opts.arch === 'x64' ? 'x86_64' : 'arm64');
    } else if (args[0] === '--version') {
      if (opts.missingBinary === file) stdout = '';
      else {
        const name = file.split('/').at(-1)!;
        const version = opts.mixedUtility === name ? '18.1' : opts.binaryVersion ?? opts.wrongVersion ?? '17.5';
        stdout = opts.versionOutputs?.[name] ?? `${name === 'pg_config' ? 'PostgreSQL' : `${name} (PostgreSQL)`} ${version}`;
      }
    } else if (args[0] === '--sharedir') stdout = '/brew/share/postgresql@17';
    else if (args[0] === '--pkglibdir') stdout = `${vectorPrefix}/lib`;
    else throw new Error(`Unexpected fake runner call: ${file} ${args.join(' ')}`);
    return { code: stdout ? 0 : 1, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), timedOut: false, truncated: false };
  };
  const fileExists = (path: string) => {
    if (path.endsWith('/vector.dylib')) return opts.missingVector !== 'library';
    if (path.endsWith('/vector.control')) return opts.missingVector !== 'control';
    if (path.endsWith('/pg_trgm.control') || path.endsWith('/pgcrypto.control')) return true;
    return false;
  };
  const lstat = (path: string) => ({ isFile: () => path !== opts.nonRegular, isSymbolicLink: () => false });
  const realpath = (path: string) => path === opts.escapeArtifact ? '/outside/escaped-artifact' : path;
  return { calls, runner, fileExists, pgPrefix, vectorPrefix, lstat, realpath };
}

function inspect(f: ReturnType<typeof fixture>, arch = 'arm64') {
  return inspectPackages({ runner: f.runner, brew: '/brew/brew', executable: () => true, fileExists: f.fileExists, listFiles: () => ['vector--0.8.0.sql'], lstat: f.lstat, realpath: f.realpath, platform: 'darwin', arch });
}

describe('managed PostgreSQL package prerequisites', () => {
  it('requires installed formulae, provenance-contained native artifacts, versions and extension files', async () => {
    const f = fixture(), report = await inspect(f);
    expect(report.ready).toBe(true);
    expect(Object.keys(report.binaries)).toEqual([...PG_BINARIES]);
    expect(f.calls.filter(x => x.file === '/usr/bin/lipo')).toHaveLength(PG_BINARIES.length + 1);
    expect(report.installArgv).toEqual(['install', 'postgresql@17', 'pgvector']);
  });
  it('refuses absent formulae and wrong architecture prefixes', async () => {
    const absent = await inspect(fixture({ installed: false }));
    expect(absent.missing).toEqual(['postgresql@17', 'pgvector']);
    expect((await inspect(fixture(), 'x64')).incompatible).toContain('homebrew-prefix-architecture');
  });
  it('validates x64 with Mach-O x86_64 slice', async () => {
    const f = fixture({ prefix: '/usr/local', arch: 'x64' });
    expect((await inspect(f, 'x64')).ready).toBe(true);
  });
  it('rejects wrong versions, missing utilities and extension artifacts', async () => {
    const wrong = fixture({ binaryVersion: '16.8' });
    expect((await inspect(wrong)).incompatible.some(x => x.startsWith('binary-version:'))).toBe(true);
    const missing = fixture({ missingBinary: '/opt/homebrew/opt/postgresql@17/bin/pg_restore' });
    const missingReport = await inspectPackages({ runner: missing.runner, brew: '/brew/brew', executable: p => p !== '/opt/homebrew/opt/postgresql@17/bin/pg_restore', fileExists: missing.fileExists, listFiles: () => ['vector.sql'], lstat: missing.lstat, realpath: missing.realpath, platform: 'darwin', arch: 'arm64' });
    expect(missingReport.incompatible).toContain('missing-binary:pg_restore');
    const vector = fixture({ missingVector: 'library' });
    const vectorReport = await inspectPackages({ runner: vector.runner, brew: '/brew/brew', executable: () => true, fileExists: vector.fileExists, listFiles: () => [], lstat: vector.lstat, realpath: vector.realpath, platform: 'darwin', arch: 'arm64' });
    expect(vectorReport.incompatible).toContain('missing-vector-sql');
  });
  it('accepts captured upstream and exact Homebrew utility-version shapes for every PostgreSQL binary', async () => {
    const captured = (suffix: string) => Object.fromEntries(PG_BINARIES.map(name => [name, `${name === 'pg_config' ? 'PostgreSQL' : `${name} (PostgreSQL)`} 17.11${suffix}`]));
    const upstream = captured('');
    expect(upstream).toEqual({
      postgres: 'postgres (PostgreSQL) 17.11', initdb: 'initdb (PostgreSQL) 17.11', pg_ctl: 'pg_ctl (PostgreSQL) 17.11',
      pg_config: 'PostgreSQL 17.11', pg_controldata: 'pg_controldata (PostgreSQL) 17.11', pg_isready: 'pg_isready (PostgreSQL) 17.11',
      createdb: 'createdb (PostgreSQL) 17.11', psql: 'psql (PostgreSQL) 17.11', pg_dump: 'pg_dump (PostgreSQL) 17.11', pg_restore: 'pg_restore (PostgreSQL) 17.11',
    });
    expect((await inspect(fixture({ versionOutputs: upstream }))).ready).toBe(true);
    const homebrew = captured(' (Homebrew)');
    expect(homebrew.pg_config).toBe('PostgreSQL 17.11 (Homebrew)');
    expect(homebrew.psql).toBe('psql (PostgreSQL) 17.11 (Homebrew)');
    expect((await inspect(fixture({ versionOutputs: homebrew }))).ready).toBe(true);
  });
  it('checks actual slices, provenance, regular file type, utility-specific versions and vector dylib architecture', async () => {
    expect((await inspect(fixture({ wrongArch: '/opt/homebrew/opt/postgresql@17/bin/postgres' }))).incompatible).toContain('binary-architecture:postgres');
    expect((await inspect(fixture({ universal: true }))).ready).toBe(true);
    expect((await inspect(fixture({ malformedLipo: true }))).incompatible).toContain('binary-architecture:postgres');
    expect((await inspect(fixture({ escapeArtifact: '/opt/homebrew/opt/postgresql@17/bin/postgres' }))).incompatible).toContain('binary-provenance:postgres');
    expect((await inspect(fixture({ nonRegular: '/opt/homebrew/opt/postgresql@17/bin/postgres' }))).incompatible).toContain('binary-provenance:postgres');
    const mixed = (await inspect(fixture({ mixedUtility: 'pg_dump' }))).incompatible;
    expect(mixed).toContain('binary-version:pg_dump');
    expect(mixed).toContain('mixed-postgresql-majors');
    expect((await inspect(fixture({ wrongArch: '/opt/homebrew/opt/pgvector/lib/vector.dylib' }))).incompatible).toContain('vector-library-architecture');
    expect((await inspect(fixture({ binaryVersion: '17.5 incidental 17' }))).incompatible).toContain('binary-version:postgres');
    expect((await inspect(fixture({ versionOutputs: { postgres: 'postgres (PostgreSQL) 17.11 (Vendor)' } }))).incompatible).toContain('binary-version:postgres');
    expect((await inspect(fixture({ versionOutputs: { postgres: 'postgres (PostgreSQL) 17.11 (Homebrew) extra' } }))).incompatible).toContain('binary-version:postgres');
  });
  it('requires a supported macOS and native architecture', async () => {
    expect((await inspectPackages({ brew: null, executable: () => false })).missing).toContain('homebrew');
    const f = fixture();
    expect((await inspectPackages({ runner: f.runner, brew: '/brew/brew', executable: () => true, fileExists: f.fileExists, listFiles: () => ['vector.sql'], lstat: f.lstat, realpath: f.realpath, platform: 'linux', arch: 'arm64' })).incompatible).toContain('platform');
  });
  it('fingerprints normalized dry-run actions including exact executable/argv and reports missing versions honestly', async () => {
    const f = fixture({ installed: false }), report = await inspect(f), args: string[][] = [];
    const runner: ProcessRunner = async (_file, argv, options) => {
      args.push(argv);
      expect(options?.env).toMatchObject(HOMEBREW_SAFE_ENV);
      return { code: 0, stdout: Buffer.from('==> Would install 2 formulae:\npostgresql@17  17.11\npgvector       0.8.7\n==> Would install 1 dependency for postgresql@17:\nkrb5\n==> Would upgrade 1 dependency for postgresql@17:\nopenssl@3 3.4.0\n'), stderr: Buffer.alloc(0), timedOut: false, truncated: false };
    };
    const impact = await planPackageImpact(report, runner);
    expect(impact.known).toBe(true);
    expect(impact.formulaInstalls).toEqual(['pgvector', 'postgresql@17']);
    expect(impact.dependencyInstalls).toEqual(['krb5']);
    expect(impact.lines).toContain('Install dependency for postgresql@17: krb5 (version not reported)');
    expect(impact.lines).toContain('Upgrade dependency for postgresql@17: openssl@3 3.4.0');
    expect(impact.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(args).toEqual([['install', '--dry-run', 'postgresql@17', 'pgvector']]);
  });
  it('binds the normalized frozen safety environment into the package-plan fingerprint', async () => {
    const report = await inspect(fixture({ installed: false }));
    const runner: ProcessRunner = async () => ({ code: 0, stdout: Buffer.from('==> Would install 2 formulae:\npostgresql@17 17.11\npgvector 0.8.7\n'), stderr: Buffer.alloc(0), timedOut: false, truncated: false });
    const impact = await planPackageImpact(report, runner);
    const normalized = {
      executable: '/brew/brew',
      argv: ['install', '--dry-run', 'postgresql@17', 'pgvector'],
      safetyEnv: Object.entries(HOMEBREW_SAFE_ENV).sort(([a], [b]) => a.localeCompare(b)),
      formulaInstalls: [{ name: 'pgvector', version: '0.8.7' }, { name: 'postgresql@17', version: '17.11' }],
      dependencyInstalls: [], upgrades: [], reinstalls: [],
    };
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    expect(impact.fingerprint).toBe(hash(normalized));
    const { safetyEnv: _safetyEnv, ...withoutSafetyEnv } = normalized;
    expect(impact.fingerprint).not.toBe(hash(withoutSafetyEnv));
  });
  it('propagates process cancellation from package inspection and impact planning', async () => {
    const cancelled: ProcessRunner = async () => { throw new ProcessCancelledError(); };
    await expect(inspectPackages({ runner: cancelled, brew: '/brew/brew', executable: () => true })).rejects.toBeInstanceOf(ProcessCancelledError);
    const report = await inspect(fixture({ installed: false }));
    await expect(planPackageImpact(report, cancelled)).rejects.toBeInstanceOf(ProcessCancelledError);
  });
  it('fails closed on unknown or malformed Homebrew output', async () => {
    const report = await inspect(fixture({ installed: false }));
    for (const text of ['==> Updating Homebrew...\n', '==> Would install 3 formulae:\npostgresql@17 17.11\npgvector 0.8.7\n', '==> Would install 2 formulae:\npostgresql@17 17.11\npgvector 0.8.7\n==> Would remove 1 dependency:\nkrb5\n', '==> Would install 1 formula:\npostgresql@17 17.11\n', '==> Would install 2 formulae:\npostgresql@17;touch 17.11\npgvector 0.8.7\n']) {
      const impact = await planPackageImpact(report, async () => ({ code: 0, stdout: Buffer.from(text), stderr: Buffer.alloc(0), timedOut: false, truncated: false }));
      expect(impact.known).toBe(false);
    }
  });
  it('exports the immutable safe Homebrew environment required by actual-install callers', () => {
    expect(HOMEBREW_SAFE_ENV).toEqual({ HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: '1' });
    expect(Object.isFrozen(HOMEBREW_SAFE_ENV)).toBe(true);
  });
});
