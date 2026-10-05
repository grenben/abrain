/**
 * Protects observable filesystem ownership refusal and lock exclusion.
 * A regression that accepts a mismatched config home or concurrent lock fails.
 * Existing docker ownership tests do not cover native-cluster metadata.
 * Uses temporary filesystem state, not a production seam solely for tests.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLifecycleLock, createOwner, ensurePrivateDir, managedPaths, MANAGER_ID, readOwner, writeOwner } from '../src/core/managed-postgres/ownership.ts';

const dirs: string[] = [];
const privateTmp = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
function fixture() { const base = mkdtempSync(join(tmpdir(), 'gbrain-pg-owner-')); dirs.push(base); const config = join(base, '.gbrain'); mkdirSync(config, { mode: 0o700 }); const paths = managedPaths(config); ensurePrivateDir(paths.root); ensurePrivateDir(paths.data); ensurePrivateDir(paths.log); ensurePrivateDir(paths.socket); return paths; }
function makeOwner(paths: ReturnType<typeof managedPaths>) { const owner = createOwner(paths, process.getuid?.() ?? -1, '/brew/opt/postgresql@17', '17.5', '0.8.0', 55432); const socketPath = join(privateTmp, `gbp-own-${process.pid}-${owner.clusterId.slice(0, 8)}`); dirs.push(socketPath); ensurePrivateDir(socketPath); owner.socketPath = socketPath; writeFileSync(join(socketPath, '.gbrain-managed-owner'), `${MANAGER_ID}:${owner.clusterId}:${owner.uid}`, { mode: 0o600, flag: 'wx' }); return owner; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('managed PostgreSQL ownership', () => {
  it('round trips canonical, phase-tagged ownership without credentials', () => {
    const paths = fixture(), owner = makeOwner(paths);
    writeOwner(paths, owner);
    expect(readOwner(paths, process.getuid?.() ?? -1)).toEqual(owner);
    expect(statSync(paths.owner).mode & 0o777).toBe(0o600);
    expect(readdirSync(paths.root).filter(name => name.startsWith('.owner.json.tmp-'))).toEqual([]);
    expect(JSON.stringify(owner)).not.toContain('password');
  });
  it('refuses config-home mismatch and malformed metadata', () => {
    const paths = fixture(), owner = makeOwner(paths);
    writeOwner(paths, owner);
    const otherConfig = join(paths.configDir, 'elsewhere'); mkdirSync(otherConfig, { mode: 0o700 });
    const other = managedPaths(otherConfig);
    expect(() => readOwner(other, process.getuid?.() ?? -1)).toThrow();
    writeFileSync(paths.owner, '{bad', { mode: 0o600 });
    expect(() => readOwner(paths, process.getuid?.() ?? -1)).toThrow(/malformed/);
  });
  it('fails closed for concurrent lifecycle mutation', () => {
    const paths = fixture(), release = acquireLifecycleLock(paths);
    expect(() => acquireLifecycleLock(paths)).toThrow(/locked/);
    release();
    const releaseAgain = acquireLifecycleLock(paths); releaseAgain();
  });
  it('rejects permissive metadata modes', () => {
    const paths = fixture(), owner = makeOwner(paths);
    writeOwner(paths, owner); chmodSync(paths.owner, 0o644);
    expect(() => readOwner(paths, process.getuid?.() ?? -1)).toThrow(/unsafe/);
  });
  it('rejects wrong UID proof and root symlink escapes', () => {
    const paths = fixture(), uid = process.getuid?.() ?? -1, owner = makeOwner(paths);
    writeOwner(paths, owner);
    expect(() => readOwner(paths, uid + 1)).toThrow();
    const outside = mkdtempSync(join(tmpdir(), 'gbrain-outside-')); dirs.push(outside);
    const escape = join(paths.configDir, 'outside'); symlinkSync(outside, escape);
    expect(() => managedPaths(paths.configDir, join(escape, 'managed'))).toThrow(/beneath/);
  });
  it('rejects insecure managed data-directory permissions', () => {
    const paths = fixture(), owner = makeOwner(paths);
    writeOwner(paths, owner); chmodSync(paths.data, 0o755);
    expect(() => readOwner(paths, process.getuid?.() ?? -1)).toThrow(/permissions/);
  });
  it('rejects writable configured ancestry and symlink substitution inside the home', () => {
    const paths = fixture(), owner = makeOwner(paths);
    writeOwner(paths, owner);
    chmodSync(paths.configDir, 0o722);
    expect(() => readOwner(paths, process.getuid?.() ?? -1)).toThrow(/ancestry/);
    chmodSync(paths.configDir, 0o700);
    const actual = join(paths.configDir, 'real-root'); mkdirSync(actual, { mode: 0o700 });
    const alias = join(paths.configDir, 'root-alias'); symlinkSync(actual, alias);
    expect(() => managedPaths(paths.configDir, join(alias, 'managed'))).toThrow(/symlink/);
  });
  it('refuses to atomically replace an unsafe ownership symlink', () => {
    const paths = fixture(), owner = makeOwner(paths), target = join(paths.configDir, 'foreign-owner');
    writeFileSync(target, 'foreign', { mode: 0o600 });
    symlinkSync(target, paths.owner);
    expect(() => writeOwner(paths, owner)).toThrow(/unsafe/);
    expect(readdirSync(paths.root).filter(name => name.startsWith('.owner.json.tmp-'))).toEqual([]);
  });
});
