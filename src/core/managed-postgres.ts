import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { configDir as defaultConfigDir } from './config.ts';
import { acquireLifecycleLock, assertPrivateFile, atomicWriteOwnedFile, canonicalPath, captureInitializationReceipt, createOwner, ensurePrivateDir, managedPaths, matchesInitializationOrManaged, readCredentials, readInitializationReceipt, readOwner, validateExistingManagedAncestry, validateManagedDirectories, writeInitializationReceipt, writeOwner, type InitializationReceipt, type ManagedPaths, type OwnerMetadata } from './managed-postgres/ownership.ts';
import { HOMEBREW_SAFE_ENV, inspectPackages, planPackageImpact, REQUIRED_FORMULAE, type PackageDeps, type PackageImpact, type PackageReport } from './managed-postgres/packages.ts';
import { ProcessCancelledError, ProcessTerminationUnconfirmedError, runProcess, type ProcessResult, type ProcessRunner } from './managed-postgres/process.ts';
import { MANAGED_IDENTITY_QUERY, renderManagedPostgresConfig, verifyManagedPostgresLiveIdentity, type LiveIdentity } from './managed-postgres/identity.ts';
import { validateManagedPostgresReference } from './engine-target.ts';
import type { ManagedPostgresReference } from './types.ts';

export type ManagedClassification = 'absent' | 'packages_missing' | 'packages_incompatible' | 'allocated' | 'partial' | 'ownership_unknown' | 'stopped' | 'port_collision' | 'startup_failure' | 'auth_failure' | 'wrong_server' | 'missing_extension' | 'schema_incomplete' | 'ready';
export interface ManagedContext {
  configDir?: string; root?: string; uid?: number; platform?: NodeJS.Platform; arch?: string; rosetta?: boolean;
  runner?: ProcessRunner; packageDeps?: Omit<PackageDeps, 'runner' | 'platform' | 'arch' | 'rosetta'>;
  allocatePort?: () => number | Promise<number>; portInUse?: (port: number) => boolean | Promise<boolean>; runtimeSocketRoot?: string; clusterId?: () => string; signal?: AbortSignal;
}
export interface PrerequisiteReport { supported: boolean; reason?: string; packages: PackageReport; root: string; }
export interface ProvisionPlan { ready: boolean; root: string; packages: PackageReport; installPackages: boolean; packageImpact?: PackageImpact; packagePlanFingerprint?: string; commands: Array<{ executable: string; argv: string[] }>; refusal?: string; }
export interface ManagedTarget { host: '127.0.0.1'; port: number; database: string; role: string; socketPath: string; controller: 'manual'; }
export interface ManagedStatus { classification: ManagedClassification; phase?: OwnerMetadata['phase']; target?: ManagedTarget; detail?: string; }
export interface ManagedCredentials { password: string; }

const SOCKET_PATH_MAX = 103;
const CAPABILITIES = ['pg_trgm', 'pgcrypto', 'vector'];
function getPaths(ctx: ManagedContext): ManagedPaths { return managedPaths(ctx.configDir ?? defaultConfigDir(), ctx.root); }
function checkSignal(ctx: ManagedContext): void {
  if (ctx.signal?.aborted) throw new ProcessCancelledError();
}
function runtime(ctx: ManagedContext) {
  const original = ctx.runner ?? runProcess;
  const runner: ProcessRunner = async (file, args, options = {}) => {
    checkSignal(ctx);
    let result: ProcessResult;
    try { result = await original(file, args, { ...options, signal: ctx.signal }); }
    catch (error) {
      if (error instanceof ProcessTerminationUnconfirmedError) throw error;
      checkSignal(ctx);
      throw error;
    }
    checkSignal(ctx);
    return result;
  };
  return { uid: ctx.uid ?? process.getuid?.() ?? -1, platform: ctx.platform ?? process.platform, arch: ctx.arch ?? process.arch, runner };
}
function durable<T>(ctx: ManagedContext, action: () => T): T { checkSignal(ctx); const result = action(); checkSignal(ctx); return result; }
function target(owner: OwnerMetadata): ManagedTarget { return { host: '127.0.0.1', port: owner.port, database: owner.database, role: owner.role, socketPath: owner.socketPath, controller: 'manual' }; }
function canonicalClusterReference(clusterId: string): Readonly<ManagedPostgresReference> {
  const reference = validateManagedPostgresReference({ manager_id: 'gbrain-managed-postgres', cluster_id: clusterId });
  return Object.freeze(reference);
}
function platformRefusal(ctx: ManagedContext): string | undefined {
  const r = runtime(ctx);
  if (r.platform !== 'darwin') return 'Only macOS is supported.';
  if (!['arm64', 'x64'].includes(r.arch)) return 'Only native macOS arm64 and x64 are supported.';
  if (r.uid === 0) return 'Managed PostgreSQL refuses to run as root.';
  if (ctx.rosetta) return 'Rosetta-translated processes are not supported.';
}
async function packageReport(ctx: ManagedContext): Promise<PackageReport> {
  const r = runtime(ctx);
  return inspectPackages({ ...ctx.packageDeps, runner: r.runner, path: ctx.packageDeps?.path ?? process.env.PATH, platform: r.platform, arch: r.arch, rosetta: ctx.rosetta });
}
export async function inspectPrerequisites(context: ManagedContext = {}): Promise<PrerequisiteReport> {
  checkSignal(context);
  const paths = getPaths(context), reason = platformRefusal(context);
  const packages = reason ? await inspectPackages({ brew: null, platform: runtime(context).platform, arch: runtime(context).arch }) : await packageReport(context);
  return { supported: !reason && packages.ready, ...(reason ? { reason } : {}), packages, root: paths.root };
}
export async function planProvision(context: ManagedContext = {}): Promise<ProvisionPlan> {
  checkSignal(context);
  const report = await inspectPrerequisites(context), packages = report.packages;
  const reason = report.reason ?? (packages.missing.includes('homebrew') ? 'Homebrew is required and will not be installed automatically.' : packages.incompatible.length ? 'Installed PostgreSQL packages or architecture are incompatible; upgrades and replacement are refused.' : undefined);
  const packageImpact = !reason && packages.missing.length ? await planPackageImpact(packages, runtime(context).runner) : undefined;
  const impactRefusal = packageImpact && !packageImpact.known ? 'Homebrew dry-run impact could not be parsed safely; package installation is refused.' : undefined;
  const commands = !reason && !impactRefusal && packages.missing.length ? [{ executable: packages.brew!, argv: [...packages.installArgv] }] : [];
  return { ready: !reason && packages.ready, root: report.root, packages, installPackages: !reason && !impactRefusal && packages.missing.length > 0, ...(packageImpact ? { packageImpact, ...(packageImpact.fingerprint ? { packagePlanFingerprint: packageImpact.fingerprint } : {}) } : {}), commands, ...((reason ?? impactRefusal) ? { refusal: reason ?? impactRefusal } : {}) };
}
function ok(r: ProcessResult): boolean { return r.code === 0 && !r.timedOut && !r.truncated; }
function requireOk(r: ProcessResult, action: string): void { if (!ok(r)) throw new Error(`Managed PostgreSQL ${action} failed; diagnostic output was suppressed.`); }
function writeSecret(path: string, data: string): void {
  if (existsSync(path)) throw new Error('Managed PostgreSQL secret file already exists; it will not be overwritten.');
  writeFileSync(path, data, { mode: 0o600, flag: 'wx' }); chmodSync(path, 0o600);
}
function ensurePrivateLog(ctx: ManagedContext, path: string, uid: number): void {
  if (existsSync(path)) assertPrivateFile(path, uid); else durable(ctx, () => writeSecret(path, ''));
}
function startupLogPath(paths: ManagedPaths): string { return join(paths.log, 'startup.log'); }
function parseSystemIdentifier(text: string): string | null { return text.match(/Database system identifier:\s*(\d+)/)?.[1] ?? null; }
function pathExists(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
function portOccupied(port: number): Promise<boolean> {
  return new Promise(resolve => { const server = createServer(); server.once('error', () => resolve(true)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(false))); });
}
async function portInUse(ctx: ManagedContext, port: number): Promise<boolean> { return ctx.portInUse ? ctx.portInUse(port) : portOccupied(port); }
async function allocatePort(ctx: ManagedContext): Promise<number> {
  if (ctx.allocatePort) return ctx.allocatePort();
  for (const port of [55432, 55433, 55435, 55436, 55437, 55438]) if (!(await portInUse(ctx, port))) return port;
  throw new Error('No available managed PostgreSQL port was found.');
}
function writeRuntimeSocketMarker(ctx: ManagedContext, socket: string, owner: OwnerMetadata, uid: number): void {
  if (socket === owner.rootPath + '/socket') { durable(ctx, () => ensurePrivateDir(socket, uid)); return; }
  durable(ctx, () => ensurePrivateDir(socket, uid));
  const marker = join(socket, '.gbrain-managed-owner');
  if (existsSync(marker)) {
    const st = lstatSync(marker);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0 || readFileSync(marker, 'utf8') !== `${owner.managerId}:${owner.clusterId}:${uid}`) throw new Error('Managed PostgreSQL runtime socket path belongs to unknown state.');
  } else durable(ctx, () => writeSecret(marker, `${owner.managerId}:${owner.clusterId}:${uid}`));
}
function clusterConfigText(owner: OwnerMetadata, paths: ManagedPaths): { config: string; hba: string } {
  return renderManagedPostgresConfig(owner, paths);
}
function validateAllocatedConfigState(paths: ManagedPaths, receipt: InitializationReceipt, managed: { config: string; hba: string }, uid: number): void {
  if (!matchesInitializationOrManaged(join(paths.data, 'postgresql.conf'), uid, receipt.sha256.postgresqlConf, managed.config) ||
      !matchesInitializationOrManaged(join(paths.data, 'pg_hba.conf'), uid, receipt.sha256.pgHbaConf, managed.hba) ||
      !matchesInitializationOrManaged(join(paths.data, 'postgresql.auto.conf'), uid, receipt.sha256.postgresqlAutoConf, '')) throw new Error('Managed PostgreSQL bootstrap configuration changed; retained without repair.');
}
function configFiles(owner: OwnerMetadata, paths: ManagedPaths): Array<[string, string]> {
  const expected = clusterConfigText(owner, paths);
  return [[join(paths.data, 'postgresql.conf'), expected.config], [join(paths.data, 'pg_hba.conf'), expected.hba], [join(paths.data, 'postgresql.auto.conf'), '']];
}
function writeClusterConfig(ctx: ManagedContext, owner: OwnerMetadata, paths: ManagedPaths, uid: number, receipt: InitializationReceipt): void {
  if (owner.phase !== 'allocated') { assertClusterConfig(owner, paths, uid); return; }
  const managed = clusterConfigText(owner, paths);
  validateAllocatedConfigState(paths, receipt, managed, uid);
  const files: Array<[string, string, string]> = [
    [join(paths.data, 'postgresql.conf'), managed.config, receipt.sha256.postgresqlConf],
    [join(paths.data, 'pg_hba.conf'), managed.hba, receipt.sha256.pgHbaConf],
    [join(paths.data, 'postgresql.auto.conf'), '', receipt.sha256.postgresqlAutoConf],
  ];
  for (const [file, content, nativeHash] of files) durable(ctx, () => atomicWriteOwnedFile(file, content, uid, existing => existing === content || createHash('sha256').update(existing).digest('hex') === nativeHash));
  assertClusterConfig(owner, paths, uid);
}
function assertClusterConfig(owner: OwnerMetadata, paths: ManagedPaths, uid: number): void {
  for (const [file, content] of configFiles(owner, paths)) assertPrivateFile(file, uid, content);
}
function commandEnv(ctx: ManagedContext, passfile?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME };
  if (passfile) { env.PGPASSFILE = passfile; env.PGREQUIREAUTH = 'scram-sha-256'; }
  return env;
}
function psqlArgs(owner: OwnerMetadata, database: string, sql: string): string[] {
  return ['--no-psqlrc', '--no-align', '--tuples-only', `--host=${owner.socketPath}`, `--port=${owner.port}`, `--username=${owner.role}`, `--dbname=${database}`, '--set=ON_ERROR_STOP=1', '--command', sql];
}
async function sql(ctx: ManagedContext, owner: OwnerMetadata, paths: ManagedPaths, database: string, statement: string): Promise<ProcessResult> {
  return runtime(ctx).runner(join(owner.binaryPrefix, 'bin', 'psql'), psqlArgs(owner, database, statement), { timeoutMs: 8_000, outputLimit: 64 * 1024, env: commandEnv(ctx, join(paths.root, 'pgpass')) });
}
const EXTENSIONS_QUERY = `SELECT COALESCE(json_agg(extname ORDER BY extname),'[]'::json)::text FROM pg_extension WHERE extname IN ('pg_trgm','pgcrypto','vector')`;
const VECTOR_OPERATION = `SELECT '[1,2,3]'::vector <-> '[1,2,3]'::vector`;
function classifyIdentity(result: ProcessResult, owner: OwnerMetadata, paths: ManagedPaths): ManagedClassification | LiveIdentity {
  if (!ok(result)) {
    const detail = result.stderr.toString('utf8');
    if (/password authentication failed|no password supplied|authentication failed/i.test(detail)) return 'auth_failure';
    if (/could not connect|connection refused|no such file or directory/i.test(detail)) return 'startup_failure';
    return 'wrong_server';
  }
  let value: unknown;
  try { value = JSON.parse(result.stdout.toString('utf8').trim()); } catch { return 'wrong_server'; }
  return verifyManagedPostgresLiveIdentity(value, owner, paths, 'postgres') ?? 'wrong_server';
}
async function liveProof(ctx: ManagedContext, owner: OwnerMetadata, paths: ManagedPaths, requireCapabilities = true): Promise<ManagedClassification> {
  const identity = classifyIdentity(await sql(ctx, owner, paths, 'postgres', MANAGED_IDENTITY_QUERY), owner, paths);
  if (typeof identity === 'string') return identity;
  if (!requireCapabilities) return 'ready';
  const extensionResult = await sql(ctx, owner, paths, owner.database, EXTENSIONS_QUERY);
  if (!ok(extensionResult)) return 'schema_incomplete';
  let extensions: unknown;
  try { extensions = JSON.parse(extensionResult.stdout.toString('utf8').trim()); } catch { return 'schema_incomplete'; }
  if (!Array.isArray(extensions) || !CAPABILITIES.every(ext => extensions.includes(ext))) return 'missing_extension';
  const vectorResult = await sql(ctx, owner, paths, owner.database, VECTOR_OPERATION);
  const vectorText = vectorResult.stdout.toString('utf8').trim();
  if (!ok(vectorResult) || !vectorText || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(vectorText) || !Number.isFinite(Number(vectorText)) || Number(vectorText) !== 0) return 'schema_incomplete';
  return 'ready';
}
async function pgCtlStatus(ctx: ManagedContext, owner: OwnerMetadata, paths: ManagedPaths): Promise<'running' | 'stopped' | 'unknown'> {
  const result = await runtime(ctx).runner(join(owner.binaryPrefix, 'bin', 'pg_ctl'), ['-D', paths.data, 'status'], { timeoutMs: 8_000, outputLimit: 4096, env: commandEnv(ctx) });
  if (result.code === 0 && !result.timedOut) return 'running';
  if (/no server running|not running/i.test(`${result.stderr.toString('utf8')}\n${result.stdout.toString('utf8')}`)) return 'stopped';
  return 'unknown';
}
function ownerStatus(owner: OwnerMetadata): ManagedStatus { return { classification: owner.lastFailure ?? (owner.phase === 'provisioned' ? 'partial' : owner.phase === 'allocated' ? 'allocated' : 'partial'), phase: owner.phase, target: target(owner) }; }
function checkPgVersion(data: string, uid: number): boolean { try { const p = join(data, 'PG_VERSION'), st = lstatSync(p); return st.isFile() && !st.isSymbolicLink() && st.uid === uid && readFileSync(p, 'utf8') === '17\n'; } catch { return false; } }
function proveClusterFiles(paths: ManagedPaths, uid: number): void {
  const global = join(paths.data, 'global'), globalStat = lstatSync(global);
  if (!globalStat.isDirectory() || globalStat.isSymbolicLink() || globalStat.uid !== uid || (globalStat.mode & 0o777) !== 0o700) throw new Error('Managed PostgreSQL global directory is unsafe.');
  for (const file of [join(paths.data, 'PG_VERSION'), join(global, 'pg_control')]) {
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid) throw new Error('Managed PostgreSQL control files are unsafe.');
  }
  for (const dir of ['pg_wal', 'pg_tblspc']) {
    const p = join(paths.data, dir), st = lstatSync(p);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o777) !== 0o700) throw new Error(`Managed PostgreSQL ${dir} directory is unsafe.`);
    if (dir === 'pg_tblspc' && readdirSync(p).length) throw new Error('Managed PostgreSQL user tablespaces are unsupported.');
  }
}
async function offlineProof(ctx: ManagedContext, paths: ManagedPaths, packages: PackageReport): Promise<{ owner: OwnerMetadata; credentials: ManagedCredentials } | ManagedClassification> {
  const r = runtime(ctx);
  let owner: OwnerMetadata;
  try { owner = readOwner(paths, r.uid); } catch { return 'ownership_unknown'; }
  if (!packages.ready) return packages.missing.length ? 'packages_missing' : 'packages_incompatible';
  if (owner.binaryPrefix !== packages.formulaPrefix || owner.binaryVersion !== packages.formulaVersion || owner.pgvectorVersion !== packages.pgvectorVersion) return 'packages_incompatible';
  if (owner.phase === 'allocated' && !existsSync(join(paths.data, 'PG_VERSION'))) {
    try { lstatSync(paths.receipt); return 'ownership_unknown'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'ownership_unknown'; }
    try { return { owner, credentials: readCredentials(paths, r.uid) }; } catch { return 'ownership_unknown'; }
  }
  if (!checkPgVersion(paths.data, r.uid)) return 'ownership_unknown';
  let credentials: ManagedCredentials;
  try { credentials = readCredentials(paths, r.uid); } catch { return 'ownership_unknown'; }
  let receipt: InitializationReceipt;
  try { receipt = readInitializationReceipt(paths, owner, r.uid); } catch { return 'ownership_unknown'; }
  try { proveClusterFiles(paths, r.uid); } catch { return 'ownership_unknown'; }
  if (owner.phase === 'allocated') {
    try { validateAllocatedConfigState(paths, receipt, clusterConfigText(owner, paths), r.uid); } catch { return 'ownership_unknown'; }
  } else {
    try { assertClusterConfig(owner, paths, r.uid); } catch { return 'ownership_unknown'; }
  }
  const control = await r.runner(join(owner.binaryPrefix, 'bin', 'pg_controldata'), [paths.data], { timeoutMs: 8_000, outputLimit: 32 * 1024, env: commandEnv(ctx) });
  const id = control.stdout.toString('utf8');
  const systemId = parseSystemIdentifier(id);
  if (!ok(control) || !systemId || systemId !== receipt.systemIdentifier || (owner.systemIdentifier !== null && systemId !== owner.systemIdentifier)) return 'ownership_unknown';
  if (owner.phase !== 'allocated') {
    const passfile = join(paths.root, 'pgpass');
    try { assertPrivateFile(passfile, r.uid, `${owner.socketPath}:${owner.port}:*:${owner.role}:${credentials.password}\n`); }
    catch { return 'ownership_unknown'; }
    const pwfile = join(paths.root, 'pwfile');
    if (existsSync(pwfile)) { try { assertPrivateFile(pwfile, r.uid, `${credentials.password}\n`); } catch { return 'ownership_unknown'; } }
    for (const log of [join(paths.log, 'postgresql.log'), startupLogPath(paths)]) if (existsSync(log)) { try { assertPrivateFile(log, r.uid); } catch { return 'ownership_unknown'; } }
  }
  return { owner, credentials };
}
function report(classification: ManagedClassification, owner?: OwnerMetadata): ManagedStatus { return { classification, ...(owner ? { phase: owner.phase, target: target(owner) } : {}) }; }
async function prepareOwned(ctx: ManagedContext, paths: ManagedPaths, packages: PackageReport, owner: OwnerMetadata, credentials: ManagedCredentials): Promise<OwnerMetadata> {
  const r = runtime(ctx), passfile = join(paths.root, 'pgpass'), pwfile = join(paths.root, 'pwfile');
  validateManagedDirectories(paths, owner.socketPath, r.uid, ctx.configDir ?? defaultConfigDir());
  const pass = `${owner.socketPath}:${owner.port}:*:${owner.role}:${credentials.password}\n`;
  if (!existsSync(passfile)) durable(ctx, () => writeSecret(passfile, pass)); else assertPrivateFile(passfile, r.uid, pass);
  if (owner.phase === 'allocated') {
    const entries = readdirSync(paths.data);
    let systemIdentifier: string;
    let receipt: InitializationReceipt;
    if (entries.length) {
      if (!checkPgVersion(paths.data, r.uid)) throw new Error('Allocated cluster has incomplete initdb state; retained without reset.');
      receipt = readInitializationReceipt(paths, owner, r.uid);
      proveClusterFiles(paths, r.uid);
      validateAllocatedConfigState(paths, receipt, clusterConfigText(owner, paths), r.uid);
      const control = await r.runner(join(owner.binaryPrefix, 'bin', 'pg_controldata'), [paths.data], { timeoutMs: 8_000, env: commandEnv(ctx) });
      const id = parseSystemIdentifier(control.stdout.toString('utf8'));
      if (!ok(control) || !id || id !== receipt.systemIdentifier || (owner.systemIdentifier !== null && owner.systemIdentifier !== id)) throw new Error('Allocated cluster identity cannot be proven; retained without reset.');
      systemIdentifier = id;
    } else {
      if (pathExists(paths.receipt)) throw new Error('Allocated cluster has an initialization receipt without a cluster; retained without reset.');
      if (!existsSync(pwfile)) durable(ctx, () => writeSecret(pwfile, `${credentials.password}\n`)); else assertPrivateFile(pwfile, r.uid, `${credentials.password}\n`);
      const result = await r.runner(packages.binaries.initdb, ['-D', paths.data, '--username', owner.role, '--pwfile', pwfile, '--auth-local=scram-sha-256', '--auth-host=scram-sha-256', '--encoding=UTF8', '--no-clean'], { timeoutMs: 120_000, outputLimit: 64 * 1024, env: commandEnv(ctx) });
      if (!ok(result)) throw new Error('Managed PostgreSQL initdb failed; output suppressed and state retained.');
      if (!checkPgVersion(paths.data, r.uid)) throw new Error('initdb did not produce a PostgreSQL 17 cluster; state retained.');
      proveClusterFiles(paths, r.uid);
      const control = await r.runner(packages.binaries.pg_controldata, [paths.data], { timeoutMs: 8_000, env: commandEnv(ctx) });
      const id = parseSystemIdentifier(control.stdout.toString('utf8'));
      if (!ok(control) || !id) throw new Error('initdb system identity could not be established; state retained.');
      systemIdentifier = id;
      receipt = captureInitializationReceipt(paths, owner, r.uid, id);
      durable(ctx, () => writeInitializationReceipt(paths, receipt));
    }
    writeClusterConfig(ctx, owner, paths, r.uid, receipt);
    owner.systemIdentifier = systemIdentifier;
    owner.phase = 'initialized';
    durable(ctx, () => writeOwner(paths, owner));
  } else {
    assertClusterConfig(owner, paths, r.uid);
  }
  return owner;
}
async function startOwned(ctx: ManagedContext, paths: ManagedPaths, packages: PackageReport, owner: OwnerMetadata): Promise<ManagedClassification> {
  validateManagedDirectories(paths, owner.socketPath, runtime(ctx).uid, ctx.configDir ?? defaultConfigDir());
  const r = runtime(ctx), state = await pgCtlStatus(ctx, owner, paths);
  if (state === 'unknown') return 'ownership_unknown';
  if (state === 'running') return liveProof(ctx, owner, paths, false);
  if (await portInUse(ctx, owner.port)) return 'port_collision';
  ensurePrivateLog(ctx, startupLogPath(paths), r.uid);
  const started = await r.runner(packages.binaries.pg_ctl, ['-D', paths.data, '-l', startupLogPath(paths), 'start', '-w', '-t', '60'], { timeoutMs: 70_000, outputLimit: 16 * 1024, env: commandEnv(ctx) });
  if (!ok(started)) return 'startup_failure';
  return liveProof(ctx, owner, paths, false);
}
async function provisionCapabilities(ctx: ManagedContext, paths: ManagedPaths, owner: OwnerMetadata): Promise<void> {
  const r = runtime(ctx), dbProbe = await sql(ctx, owner, paths, 'postgres', `SELECT 1 FROM pg_database WHERE datname='${owner.database}'`);
  if (!ok(dbProbe)) throw new Error('Managed PostgreSQL database probe failed; output suppressed.');
  if (dbProbe.stdout.toString('utf8').trim() !== '1') {
     const created = await r.runner(join(owner.binaryPrefix, 'bin', 'createdb'), [`--host=${owner.socketPath}`, `--port=${owner.port}`, `--username=${owner.role}`, owner.database], { timeoutMs: 15_000, outputLimit: 4096, env: commandEnv(ctx, join(paths.root, 'pgpass')) });
    if (!ok(created)) throw new Error('Managed PostgreSQL database creation failed; state retained.');
  }
  const ext = await sql(ctx, owner, paths, owner.database, 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  if (!ok(ext)) throw new Error('Managed PostgreSQL capability setup failed; state retained.');
}
export async function withProvisionedManagedCluster<T>(
  context: ManagedContext,
  callback: (cluster: Readonly<ManagedPostgresReference>) => T | Promise<T>,
  consent: { installPackages?: boolean; packagePlanFingerprint?: string } = {},
  options: { beforeMutation?: (state: Readonly<{ kind: 'fresh' | 'owned-resume'; reference: Readonly<ManagedPostgresReference> }>) => void | Promise<void> } = {},
): Promise<T> {
  checkSignal(context);
  const r = runtime(context), paths = getPaths(context);
  const unsupported = platformRefusal(context);
  if (unsupported) throw new Error(unsupported);
  validateExistingManagedAncestry(paths, r.uid, context.configDir ?? defaultConfigDir());
  if (pathExists(paths.lock)) throw new Error('Managed PostgreSQL lifecycle is locked or lock state is ambiguous; no action was taken.');
  const preOwnerExists = existsSync(paths.owner);
  let preOwnerClusterId: string | undefined;
  if (preOwnerExists) {
    const existing = readOwner(paths, r.uid);
    canonicalClusterReference(existing.clusterId);
    preOwnerClusterId = existing.clusterId;
  } else if (existsSync(paths.root) && readdirSync(paths.root).length) {
    throw new Error('Managed PostgreSQL root contains unknown state; it will not be adopted or overwritten.');
  }
  // Compatibility refusals and package consent happen before reserving a new
  // root/lock. Homebrew may update its metadata cache while planning, but no
  // package installation occurs before explicit exact-fingerprint consent.
  const preflight = await planProvision(context);
  checkSignal(context);
  if (preflight.refusal) throw new Error(preflight.refusal);
  if (!preflight.packages.ready) {
    if (preOwnerExists) throw new Error(preflight.packages.missing.length ? 'Managed PostgreSQL packages are missing; owned clusters are never repaired during resume.' : 'Installed PostgreSQL packages or architecture are incompatible; upgrades and replacement are refused.');
    if (!preflight.installPackages || consent.installPackages !== true || consent.packagePlanFingerprint !== preflight.packagePlanFingerprint) throw new Error('PostgreSQL packages are missing; exact install and package-plan fingerprint consent is required.');
  }
  const candidateReference = preOwnerExists ? undefined : canonicalClusterReference(context.clusterId?.() ?? randomUUID());
  // The lock lives beneath the managed root, so safely reserve that private
  // directory before the lock can be atomically acquired.
  durable(context, () => ensurePrivateDir(paths.root, r.uid));
  const release = acquireLifecycleLock(paths);
  let releaseAllowed = true;
  try {
    checkSignal(context);
    checkSignal(context);
    durable(context, () => ensurePrivateDir(paths.root, r.uid));
    validateExistingManagedAncestry(paths, r.uid, context.configDir ?? defaultConfigDir());
    const isNew = !existsSync(paths.owner);
    if (isNew && readdirSync(paths.root).some(entry => entry !== '.lifecycle.lock')) throw new Error('Managed PostgreSQL root contains unknown state; it will not be adopted or overwritten.');
    if (isNew === preOwnerExists) throw new Error('Managed PostgreSQL ownership changed while acquiring the lifecycle lock.');
    if (!isNew) {
      const lockedOwner = readOwner(paths, r.uid);
      canonicalClusterReference(lockedOwner.clusterId);
      if (lockedOwner.clusterId !== preOwnerClusterId) throw new Error('Managed PostgreSQL ownership changed while acquiring the lifecycle lock.');
    }
    let packages = await packageReport(context);
    let owner!: OwnerMetadata, creds!: ManagedCredentials;
    const beforeMutation = async (kind: 'fresh' | 'owned-resume', reference: Readonly<ManagedPostgresReference>) => {
      checkSignal(context);
      if (options.beforeMutation) await options.beforeMutation(Object.freeze({ kind, reference }));
      checkSignal(context);
    };
    if (!isNew) {
      // Existing state is proved before any possible package mutation. Owned resume
      // never installs or repairs its package set.
      const proof = await offlineProof(context, paths, packages);
      if (typeof proof === 'string') throw new Error(`Managed PostgreSQL ownership proof failed (${proof}); retained state was not changed.`);
      owner = proof.owner; creds = proof.credentials;
      const reference = canonicalClusterReference(owner.clusterId);
      await beforeMutation('owned-resume', reference);
    } else {
      await beforeMutation('fresh', candidateReference!);
    }
    if (isNew && !packages.ready) {
      if (packages.incompatible.length || packages.missing.includes('homebrew')) throw new Error(packages.incompatible.length ? 'Installed PostgreSQL packages or architecture are incompatible; upgrades and replacement are refused.' : 'Homebrew is required and will not be installed automatically.');
      const impact = await planPackageImpact(packages, r.runner);
      if (!impact.known || !impact.fingerprint || impact.fingerprint !== preflight.packagePlanFingerprint || consent.installPackages !== true || consent.packagePlanFingerprint !== impact.fingerprint) throw new Error('Homebrew package impact changed or is unknown under lock; install consent is stale or missing.');
      checkSignal(context);
      requireOk(await r.runner(packages.brew!, [...packages.installArgv], { timeoutMs: 10 * 60_000, outputLimit: 16 * 1024, env: { ...commandEnv(context), ...HOMEBREW_SAFE_ENV } }), 'package install');
      packages = await packageReport(context);
      if (!packages.ready) throw new Error('Installed package set failed compatibility verification; no automatic repair was attempted.');
    }
    if (isNew) {
      const port = await allocatePort(context);
      if ([5432, 5434, 6543].includes(port) || port < 1024 || port > 65535 || await portInUse(context, port)) throw new Error('Managed PostgreSQL port is unavailable or reserved.');
      const cluster = createOwner(paths, r.uid, packages.formulaPrefix!, packages.formulaVersion!, packages.pgvectorVersion!, port, candidateReference!.cluster_id);
      durable(context, () => { ensurePrivateDir(paths.data, r.uid); ensurePrivateDir(paths.log, r.uid); });
      const defaultSocket = paths.socket;
      const shortSocketRoot = context.runtimeSocketRoot ?? (process.platform === 'darwin' ? '/private/tmp' : tmpdir());
      const socket = Buffer.byteLength(join(defaultSocket, `.s.PGSQL.${port}`)) <= SOCKET_PATH_MAX ? defaultSocket : canonicalPath(join(shortSocketRoot, `gbp-${r.uid}-${cluster.clusterId.slice(0, 12)}`));
      if (socket !== defaultSocket && existsSync(socket)) throw new Error('Managed PostgreSQL runtime socket directory already exists; no state was adopted.');
      cluster.socketPath = socket;
       durable(context, () => ensurePrivateDir(socket, r.uid));
       durable(context, () => writeOwner(paths, cluster)); owner = cluster;
       try { creds = { password: randomBytes(32).toString('base64url') }; durable(context, () => writeSecret(paths.credentials, JSON.stringify(creds))); }
      catch { throw new Error('Managed PostgreSQL credentials could not be securely reserved; ownership reservation retained.'); }
       writeRuntimeSocketMarker(context, socket, owner, r.uid);
    } else {
      if (owner!.phase === 'provisioned') {
        const state = await pgCtlStatus(context, owner!, paths);
        if (state === 'unknown') throw new Error('Provisioned cluster status is ambiguous; no target was returned.');
        if (state === 'stopped') {
          const started = await startOwned(context, paths, packages, owner!);
          if (started !== 'ready') throw new Error(`Provisioned cluster resume failed (${started}); state retained.`);
        } else {
          const identity = await liveProof(context, owner!, paths, false);
          if (identity !== 'ready') throw new Error(`Provisioned cluster identity failed (${identity}); state retained.`);
        }
        const capability = await liveProof(context, owner!, paths);
        if (capability !== 'ready') throw new Error(`Provisioned cluster capability proof failed (${capability}); state retained.`);
        checkSignal(context);
        const reference = canonicalClusterReference(owner!.clusterId);
        return await callback(reference);
      }
      writeRuntimeSocketMarker(context, owner.socketPath, owner, r.uid);
    }
    if (isNew && readdirSync(paths.data).length) throw new Error('Managed PostgreSQL data directory is not empty; initdb refused.');
    owner = await prepareOwned(context, paths, packages, owner, creds);
    if (owner.phase !== 'initialized') throw new Error('Managed PostgreSQL cluster is not in a resumable owned phase.');
    const started = await startOwned(context, paths, packages, owner);
    if (started !== 'ready') {
      if (started === 'startup_failure') { owner.lastFailure = 'startup_failure'; durable(context, () => writeOwner(paths, owner)); }
      throw new Error(`Managed PostgreSQL startup identity/capability check failed (${started}); state retained.`);
    }
    await provisionCapabilities(context, paths, owner);
    const capability = await liveProof(context, owner, paths);
    if (capability !== 'ready') throw new Error(`Managed PostgreSQL capability proof failed (${capability}); state retained.`);
    owner.phase = 'provisioned'; delete owner.lastFailure; durable(context, () => writeOwner(paths, owner));
    checkSignal(context);
    const reference = canonicalClusterReference(owner.clusterId);
    return await callback(reference);
  } catch (error) {
    if (error instanceof ProcessTerminationUnconfirmedError) releaseAllowed = false;
    throw error;
  } finally { if (releaseAllowed) release(); }
}
export async function provision(context: ManagedContext = {}, consent: { installPackages?: boolean; packagePlanFingerprint?: string } = {}): Promise<ManagedTarget> {
  let result: ManagedTarget | undefined;
  await withProvisionedManagedCluster(context, reference => {
    const paths = getPaths(context), owner = readOwner(paths, runtime(context).uid);
    if (owner.clusterId !== reference.cluster_id) throw new Error('Managed PostgreSQL owner changed during provisioning.');
    result = target(owner);
  }, consent);
  if (!result) throw new Error('Managed PostgreSQL provisioning did not produce a target.');
  return result;
}
async function verifiedStatus(ctx: ManagedContext, paths: ManagedPaths, packages: PackageReport, owner: OwnerMetadata): Promise<ManagedStatus> {
  const proof = await offlineProof(ctx, paths, packages);
  if (typeof proof === 'string') return report(proof, owner);
  const state = await pgCtlStatus(ctx, owner, paths);
  if (state === 'unknown') return report('ownership_unknown', owner);
  if (state === 'stopped') return report(await portInUse(ctx, owner.port) ? 'port_collision' : owner.lastFailure ?? 'stopped', owner);
  return report(await liveProof(ctx, owner, paths), owner);
}
export async function status(context: ManagedContext = {}, options: { probe?: boolean } = {}): Promise<ManagedStatus> {
  checkSignal(context);
  const paths = getPaths(context), r = runtime(context);
  if (!existsSync(paths.root)) return { classification: 'absent' };
  let owner: OwnerMetadata;
  try { owner = readOwner(paths, r.uid); } catch { return { classification: 'ownership_unknown' }; }
  if (!options.probe) return ownerStatus(owner);
  const packages = await packageReport(context);
  if (!packages.ready) return report(packages.missing.length ? 'packages_missing' : 'packages_incompatible', owner);
  const offline = await offlineProof(context, paths, packages);
  if (typeof offline === 'string') return report(offline, owner);
  if (owner.phase === 'allocated') return report(checkPgVersion(paths.data, r.uid) || readdirSync(paths.data).length > 0 ? 'partial' : 'allocated', owner);
  return verifiedStatus(context, paths, packages, owner);
}
export async function start(context: ManagedContext = {}): Promise<ManagedStatus> { return mutate(context, 'start'); }
export async function stop(context: ManagedContext = {}): Promise<ManagedStatus> { return mutate(context, 'stop'); }
async function mutate(context: ManagedContext, action: 'start' | 'stop'): Promise<ManagedStatus> {
  checkSignal(context);
  const paths = getPaths(context), r = runtime(context);
  if (!existsSync(paths.owner)) return { classification: existsSync(paths.root) ? 'ownership_unknown' : 'absent' };
  const release = acquireLifecycleLock(paths);
  let releaseAllowed = true;
  try {
    checkSignal(context);
    const packages = await packageReport(context);
    let proof: Awaited<ReturnType<typeof offlineProof>>;
    try { proof = await offlineProof(context, paths, packages); }
    catch (error) {
      if (error instanceof ProcessCancelledError) throw error;
      return { classification: 'ownership_unknown' };
    }
    if (typeof proof === 'string') return report(proof);
    const { owner } = proof;
     if (owner.phase === 'allocated') return report('allocated', owner);
     try { assertClusterConfig(owner, paths, r.uid); } catch { return report('ownership_unknown', owner); }
    const state = await pgCtlStatus(context, owner, paths);
    if (state === 'unknown') return report('ownership_unknown', owner);
    if (state === 'stopped') {
      if (await portInUse(context, owner.port)) return report('port_collision', owner);
      if (action === 'stop') return report(owner.lastFailure ?? 'stopped', owner);
       ensurePrivateLog(context, startupLogPath(paths), r.uid);
      const started = await r.runner(packages.binaries.pg_ctl, ['-D', paths.data, '-l', startupLogPath(paths), 'start', '-w', '-t', '60'], { timeoutMs: 70_000, outputLimit: 16 * 1024, env: commandEnv(context) });
       if (!ok(started)) { owner.lastFailure = 'startup_failure'; durable(context, () => writeOwner(paths, owner)); return report('startup_failure', owner); }
       const live = await liveProof(context, owner, paths, false);
        if (live === 'ready') { delete owner.lastFailure; durable(context, () => writeOwner(paths, owner)); return report(await liveProof(context, owner, paths), owner); }
       return report(live, owner);
     }
     const identity = await liveProof(context, owner, paths, false);
     if (identity !== 'ready') return report(identity, owner);
     if (action === 'start') { if (owner.lastFailure) { delete owner.lastFailure; durable(context, () => writeOwner(paths, owner)); } return report(await liveProof(context, owner, paths), owner); }
    const stopped = await r.runner(packages.binaries.pg_ctl, ['-D', paths.data, 'stop', '-m', 'fast', '-w', '-t', '30'], { timeoutMs: 35_000, outputLimit: 4096, env: commandEnv(context) });
    if (!ok(stopped)) return report('startup_failure', owner);
    const stoppedCleanly = await pgCtlStatus(context, owner, paths) === 'stopped' && !(await portInUse(context, owner.port));
     if (stoppedCleanly && owner.lastFailure) { delete owner.lastFailure; durable(context, () => writeOwner(paths, owner)); }
    return report(stoppedCleanly ? 'stopped' : 'ownership_unknown', owner);
  } catch (error) {
    if (error instanceof ProcessTerminationUnconfirmedError) releaseAllowed = false;
    throw error;
  } finally { if (releaseAllowed) release(); }
}

export type { OwnerMetadata, ManagedPaths } from './managed-postgres/ownership.ts';
export type { PackageReport } from './managed-postgres/packages.ts';
export { REQUIRED_FORMULAE };
