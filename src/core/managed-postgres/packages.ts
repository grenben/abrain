import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ProcessCancelledError, type ProcessRunner } from './process.ts';
import { runProcess } from './process.ts';

export const REQUIRED_FORMULAE = ['postgresql@17', 'pgvector'] as const;
export const PG_BINARIES = ['postgres', 'initdb', 'pg_ctl', 'pg_config', 'pg_controldata', 'pg_isready', 'createdb', 'psql', 'pg_dump', 'pg_restore'] as const;
export const HOMEBREW_SAFE_ENV = Object.freeze({ HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: '1' });
export interface PackageReport {
  brew: string | null; prefix: string | null; formulaPrefix: string | null; formulaVersion: string | null;
  pgvectorPrefix: string | null; pgvectorVersion: string | null; sharedir: string | null; pkglibdir: string | null;
  missing: string[]; incompatible: string[]; binaries: Record<string, string>; installArgv: string[]; ready: boolean;
}
export interface PackageImpact {
  known: boolean;
  fingerprint: string | null;
  formulaInstalls: string[];
  dependencyInstalls: string[];
  upgrades: string[];
  reinstalls: string[];
  lines: string[];
}
export interface PackageDeps {
  runner?: ProcessRunner; path?: string; brew?: string | null; platform?: NodeJS.Platform; arch?: string; rosetta?: boolean;
  executable?: (path: string) => boolean; fileExists?: (path: string) => boolean;
  listFiles?: (path: string) => string[];
  lstat?: (path: string) => { isFile(): boolean; isSymbolicLink(): boolean };
  realpath?: (path: string) => string;
}
const exists = (p: string) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };
const fileExists = (p: string) => existsSync(p);
async function output(runner: ProcessRunner, exe: string, args: string[]): Promise<string | null> {
  try { const r = await runner(exe, args, { timeoutMs: 8_000 }); return r.code === 0 && !r.timedOut && !r.truncated ? r.stdout.toString('utf8').trim() || null : null; } catch (error) { if (isCancellation(error)) throw error; return null; }
}
function isCancellation(error: unknown): boolean {
  return error instanceof ProcessCancelledError || (typeof error === 'object' && error !== null && 'code' in error && error.code === 'PROCESS_CANCELLED');
}
export async function planPackageImpact(report: PackageReport, runner: ProcessRunner = runProcess): Promise<PackageImpact> {
  const empty = { known: false, fingerprint: null, formulaInstalls: [], dependencyInstalls: [], upgrades: [], reinstalls: [], lines: [] };
  if (!report.brew || report.missing.length === 0 || report.missing.includes('homebrew')) return empty;
  let result;
  try {
    result = await runner(report.brew, ['install', '--dry-run', ...report.installArgv.slice(1)], {
      timeoutMs: 120_000, outputLimit: 128 * 1024,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME, ...HOMEBREW_SAFE_ENV },
    });
  } catch (error) { if (isCancellation(error)) throw error; return empty; }
  if (result.code !== 0 || result.timedOut || result.truncated) return empty;
  const raw = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
  const text = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const sections: Array<{ action: 'install' | 'upgrade' | 'reinstall'; kind: 'formula' | 'dependency'; parent?: string; count: number; items: Array<{ name: string; version?: string }> }> = [];
  let current: (typeof sections)[number] | undefined;
  const requested = new Set(report.installArgv.slice(1));
  const missing = report.missing.filter(name => name !== 'homebrew');
  const seenNames = new Set<string>();
  const generatedLines: string[] = [];
  const fail = () => empty;
  const finish = (): boolean => !current || current.items.length === current.count;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^==> Downloading https:\/\/[^\s]+$/.test(line) || (/^Already downloaded: /.test(line) && isAbsolute(line.slice('Already downloaded: '.length)))) {
      if (!finish()) return fail();
      current = undefined;
      continue;
    }
    const header = line.match(/^==> Would (install|upgrade|reinstall) (\d+) (formula|formulae|dependency|dependencies)(?: for ([A-Za-z0-9@+_.-]+))?:$/);
    if (header) {
      if (!finish()) return fail();
      const action = header[1]!.toLowerCase() as 'install' | 'upgrade' | 'reinstall';
      const count = Number(header[2]);
      const label = header[3]!.toLowerCase();
      const kind = label.startsWith('formula') ? 'formula' : 'dependency';
      const parent = header[4];
      if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) return fail();
      if ((kind === 'formula' && (action !== 'install' || parent !== undefined)) || (kind === 'dependency' && !parent)) return fail();
      const plural = kind === 'formula' ? 'formulae' : 'dependencies';
      const singular = kind;
      if ((count === 1 && label !== singular) || (count !== 1 && label !== plural)) return fail();
      if (parent && !requested.has(parent)) return fail();
      current = { action, kind, ...(parent ? { parent } : {}), count, items: [] };
      sections.push(current);
      continue;
    }
    if (line.startsWith('==>')) return fail();
    if (!current || /[\x00-\x1f\x7f]/.test(line)) return fail();
    const item = line.match(/^([A-Za-z0-9@+_.-]+)(?:[ \t]+([0-9][A-Za-z0-9.+_-]*))?$/);
    if (!item) return fail();
    const name = item[1]!;
    if (seenNames.has(name)) return fail();
    seenNames.add(name);
    if (current.kind === 'formula' && current.action === 'install' && !requested.has(name)) return fail();
    const parsed = { name, ...(item[2] ? { version: item[2] } : {}) };
    current.items.push(parsed);
    if (current.items.length > current.count) return fail();
    generatedLines.push(`${current.action === 'upgrade' ? 'Upgrade' : current.action === 'reinstall' ? 'Reinstall' : 'Install'} ${current.kind}${current.parent ? ` for ${current.parent}` : ''}: ${name}${parsed.version ? ` ${parsed.version}` : ' (version not reported)'}`);
  }
  if (!finish()) return fail();
  const formulaRows = sections.filter(s => s.kind === 'formula' && s.action === 'install').flatMap(s => s.items);
  if (!missing.every(name => formulaRows.filter(item => item.name === name).length === 1)) return fail();
  const byAction = (action: 'install' | 'upgrade' | 'reinstall', kind: 'formula' | 'dependency') => sections.filter(s => s.action === action && s.kind === kind).flatMap(s => s.items).sort((a, b) => a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? ''));
  const formulaInstalls = byAction('install', 'formula').map(item => item.name);
  const dependencyInstalls = byAction('install', 'dependency').map(item => item.name);
  const upgrades = byAction('upgrade', 'dependency').map(item => item.name);
  const reinstalls = sections.filter(s => s.action === 'reinstall').flatMap(s => s.items).map(item => item.name).sort();
  const normalized = {
    executable: report.brew,
    argv: ['install', '--dry-run', ...report.installArgv.slice(1)],
    safetyEnv: Object.entries(HOMEBREW_SAFE_ENV).sort(([a], [b]) => a.localeCompare(b)),
    formulaInstalls: byAction('install', 'formula'),
    dependencyInstalls: sections.filter(s => s.action === 'install' && s.kind === 'dependency').flatMap(s => s.items.map(item => ({ ...item, parent: s.parent }))).sort((a, b) => a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? '') || (a.parent ?? '').localeCompare(b.parent ?? '')),
    upgrades: sections.filter(s => s.action === 'upgrade' && s.kind === 'dependency').flatMap(s => s.items.map(item => ({ ...item, parent: s.parent }))).sort((a, b) => a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? '') || (a.parent ?? '').localeCompare(b.parent ?? '')),
    reinstalls: sections.filter(s => s.action === 'reinstall').flatMap(s => s.items.map(item => ({ ...item, parent: s.parent }))).sort((a, b) => a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? '') || (a.parent ?? '').localeCompare(b.parent ?? '')),
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return { known: true, fingerprint, formulaInstalls, dependencyInstalls, upgrades, reinstalls, lines: generatedLines.sort() };
}
function within(path: string, base: string): boolean { const r = relative(base, path); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..'); }
function listVersion(value: string | null, formula: string, major?: number): string | null {
  if (!value) return null;
  const fields = value.split(/\s+/), index = fields.indexOf(formula), version = index >= 0 ? fields.slice(index + 1).at(-1) ?? null : null;
  if (!version || (major !== undefined && Number(version.split('.')[0]) !== major)) return null;
  return version;
}
export async function inspectPackages(deps: PackageDeps = {}): Promise<PackageReport> {
  const runner = deps.runner ?? runProcess, pathEnv = deps.path ?? process.env.PATH ?? '';
  const executable = deps.executable ?? exists, hasFile = deps.fileExists ?? fileExists, listFiles = deps.listFiles ?? ((p: string) => { try { return readdirSync(p); } catch { return []; } });
  const lstat = deps.lstat ?? ((p: string) => lstatSync(p)), realpath = deps.realpath ?? ((p: string) => realpathSync(p));
  const brew = deps.brew !== undefined ? deps.brew : pathEnv.split(':').map(p => join(p, 'brew')).find(executable) ?? null;
  const report: PackageReport = { brew, prefix: null, formulaPrefix: null, formulaVersion: null, pgvectorPrefix: null, pgvectorVersion: null, sharedir: null, pkglibdir: null, missing: [], incompatible: [], binaries: {}, installArgv: ['install', 'postgresql@17', 'pgvector'], ready: false };
  if (!brew || !executable(brew)) { report.missing.push('homebrew'); return report; }
  report.prefix = await output(runner, brew, ['--prefix']);
  if (!report.prefix) report.incompatible.push('homebrew-prefix-unavailable');
  const [pgVersionRaw, vectorVersionRaw, pgPrefix, vectorPrefix] = await Promise.all([
    output(runner, brew, ['list', '--versions', 'postgresql@17']), output(runner, brew, ['list', '--versions', 'pgvector']),
    output(runner, brew, ['--prefix', 'postgresql@17']), output(runner, brew, ['--prefix', 'pgvector']),
  ]);
  report.formulaVersion = listVersion(pgVersionRaw, 'postgresql@17', 17);
  report.pgvectorVersion = listVersion(vectorVersionRaw, 'pgvector');
  if (!report.formulaVersion) report.missing.push('postgresql@17');
  if (!report.pgvectorVersion) report.missing.push('pgvector');
  report.formulaPrefix = report.formulaVersion ? pgPrefix : null;
  report.pgvectorPrefix = report.pgvectorVersion ? vectorPrefix : null;
  if (deps.platform && deps.platform !== 'darwin') report.incompatible.push('platform');
  if (deps.arch && !['arm64', 'x64'].includes(deps.arch)) report.incompatible.push('architecture');
  const translated = deps.rosetta ?? (deps.platform === 'darwin' ? (await output(runner, '/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'])) === '1' : false);
  if (translated) report.incompatible.push('rosetta');
  const expected = deps.arch === 'arm64' ? '/opt/homebrew' : deps.arch === 'x64' ? '/usr/local' : null;
  if (expected && report.prefix !== expected) report.incompatible.push('homebrew-prefix-architecture');
  if (report.formulaVersion && (!report.prefix || !report.formulaPrefix || !within(report.formulaPrefix, report.prefix))) report.incompatible.push('formula-prefix');
  if (report.pgvectorVersion && (!report.prefix || !report.pgvectorPrefix || !within(report.pgvectorPrefix, report.prefix))) report.incompatible.push('formula-prefix');
  const artifactInside = (artifact: string, formulaRoot: string): boolean => {
    try {
      const root = realpath(formulaRoot), resolved = realpath(artifact), st = lstat(resolved);
      return st.isFile() && !st.isSymbolicLink() && within(resolved, root);
    } catch { return false; }
  };
  const architecture = deps.arch === 'x64' ? 'x86_64' : deps.arch === 'arm64' ? 'arm64' : null;
  const inspectArch = async (artifact: string): Promise<boolean> => {
    if (!architecture) return false;
    const arches = await output(runner, '/usr/bin/lipo', ['-archs', artifact]);
    return !!arches && arches.split(/\s+/).includes(architecture);
  };
  const majors = new Set<number>();
  if (report.formulaPrefix) {
    const utilityVersion = (name: string, text: string | null): string | null => {
      if (!text) return null;
      const utility = name === 'pg_config' ? '(?:pg_config \\(PostgreSQL\\) )?PostgreSQL' : `${name} \\(PostgreSQL\\)`;
       const match = text.match(new RegExp(`^${utility} (\\d+\\.\\d+(?:\\.\\d+)?)(?: \\(Homebrew\\))?$`));
      if (!match) return null;
      const major = Number(match[1]!.split('.')[0]);
      majors.add(major);
      if (major !== 17) return null;
      return match[1]!;
    };
    for (const name of PG_BINARIES) {
      const path = join(report.formulaPrefix, 'bin', name);
      if (!executable(path)) { report.incompatible.push(`missing-binary:${name}`); continue; }
      if (!artifactInside(path, report.formulaPrefix)) { report.incompatible.push(`binary-provenance:${name}`); continue; }
      report.binaries[name] = path;
      const versionText = await output(runner, path, ['--version']);
      if (!utilityVersion(name, versionText)) report.incompatible.push(`binary-version:${name}`);
      if (!(await inspectArch(path))) report.incompatible.push(`binary-architecture:${name}`);
    }
    if (majors.size > 1) report.incompatible.push('mixed-postgresql-majors');
    const pgConfig = report.binaries.pg_config;
    if (pgConfig) {
      report.sharedir = await output(runner, pgConfig, ['--sharedir']);
      report.pkglibdir = await output(runner, pgConfig, ['--pkglibdir']);
    }
  }
  if (report.formulaVersion && report.pgvectorVersion && report.sharedir && report.pkglibdir) {
    for (const ext of ['vector', 'pg_trgm', 'pgcrypto']) if (!hasFile(join(report.sharedir, 'extension', `${ext}.control`))) report.incompatible.push(`missing-extension-control:${ext}`);
    const extDir = join(report.sharedir, 'extension');
    if (!listFiles(extDir).some(f => f === 'vector.sql' || /^vector--[^/]+\.sql$/.test(f))) report.incompatible.push('missing-vector-sql');
    const vectorLibrary = join(report.pkglibdir, 'vector.dylib');
    if (!hasFile(vectorLibrary)) report.incompatible.push('missing-vector-library');
    else {
      if (!report.pgvectorPrefix || !artifactInside(vectorLibrary, report.pgvectorPrefix)) report.incompatible.push('vector-library-provenance');
      else if (!(await inspectArch(vectorLibrary))) report.incompatible.push('vector-library-architecture');
    }
  } else if (report.formulaVersion && report.pgvectorVersion) report.incompatible.push('pg-config-paths');
  report.ready = report.missing.length === 0 && report.incompatible.length === 0 && Object.keys(report.binaries).length === PG_BINARIES.length;
  return report;
}
