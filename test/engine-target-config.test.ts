import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';
import {
  ConfigPublicationUncertainError,
  ConfigPublicationCommittedCleanupError,
  ConfigPublicationFailedError,
  ConfigPublicationRefusedError,
  loadConfig,
  loadConfigFileOnly,
  publishManagedInitConfig,
  saveConfig,
  toEngineConfig,
} from '../src/core/config.ts';
import { publishManagedInitConfigFile } from '../src/core/config-managed-publication.ts';
import { withConfigPublicationLock } from '../src/core/config-publication.ts';

const uuid = '01234567-89ab-cdef-0123-456789abcdef';
const managed = { manager_id: 'gbrain-managed-postgres', cluster_id: uuid } as const;
const homes: string[] = [];
function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'gbrain-managed-config-'));
  homes.push(path);
  return path;
}
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('managed target config loading and publication', () => {
  test('publication lock callback is statically synchronous-only', () => {
    if (false) {
      // @ts-expect-error async callbacks must never outlive the exclusive lock
      withConfigPublicationLock('/unreachable', async () => undefined);
    }
    expect(true).toBe(true);
  });

  test('file-only validates conflicts and toEngineConfig carries only the file reference', async () => {
    const root = home();
    const dir = join(root, '.gbrain');
    mkdirSync(dir);
    await withEnv({ GBRAIN_HOME: root, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, async () => {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ engine: 'postgres', managed_postgres: managed }));
      expect(loadConfigFileOnly()?.managed_postgres).toEqual(managed);
      expect(toEngineConfig(loadConfigFileOnly()!)).toEqual({ engine: 'postgres', database_url: undefined,
        database_path: undefined, managed_postgres: managed });
      for (const conflict of [
        { engine: 'postgres', managed_postgres: managed, database_url: 'postgresql://x.invalid/db' },
        { engine: 'postgres', managed_postgres: managed, database_path: '/private/db' },
        { engine: 'postgres', managed_postgres: managed, remote_mcp: {} },
        { engine: 'pglite', managed_postgres: managed },
        { engine: 'postgres', managed_postgres: { ...managed, password: 'secret-value' } },
      ]) {
        writeFileSync(path, JSON.stringify(conflict));
        expect(() => loadConfigFileOnly()).toThrow();
        expect(() => loadConfig()).toThrow();
        try { loadConfigFileOnly(); } catch (error) {
          expect((error as Error).message).not.toContain('secret-value');
        }
      }
    });
  });

  test('runtime URL override clears managed/path and leaves malformed file bytes unchanged', async () => {
    const root = home();
    const dir = join(root, '.gbrain');
    mkdirSync(dir);
    const path = join(dir, 'config.json');
    const bytes = '{"engine":"postgres","managed_postgres":{"manager_id":"bad","cluster_id":"secret-value"},"database_path":"/private/db"}\n';
    writeFileSync(path, bytes);
    await withEnv({ GBRAIN_HOME: root, GBRAIN_DATABASE_URL: 'postgresql://override.invalid/db', DATABASE_URL: undefined }, async () => {
      const config = loadConfig()!;
      expect(config.engine).toBe('postgres');
      expect(config.database_url).toBe('postgresql://override.invalid/db');
      expect(config.database_path).toBeUndefined();
      expect(config.managed_postgres).toBeUndefined();
      expect(readFileSync(path, 'utf8')).toBe(bytes);
    });
  });

  test('DB-plane values cannot inject or replace the file reference', async () => {
    const { loadConfigWithEngine, KNOWN_CONFIG_KEYS } = await import('../src/core/config.ts');
    const base = { engine: 'postgres', managed_postgres: managed } as const;
    const merged = await loadConfigWithEngine({ getConfig: async (key: string) =>
      key === 'managed_postgres' ? JSON.stringify({ manager_id: 'other', cluster_id: uuid }) : null,
    }, base);
    expect(merged?.managed_postgres).toEqual(managed);
    expect(KNOWN_CONFIG_KEYS).not.toContain('managed_postgres');
  });

  test('save validates first, publishes mode 0600 and preserves old bytes on pre-rename failure', async () => {
    const root = home();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const path = join(root, '.gbrain', 'config.json');
      saveConfig({ engine: 'postgres', backup: { check_enabled: true } });
      writeFileSync(path, JSON.stringify({ backup: { check_enabled: true } }));
      publishManagedInitConfig(managed);
      const published = readFileSync(path, 'utf8');
      expect(JSON.parse(published).managed_postgres).toEqual(managed);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(() => saveConfig({ engine: 'postgres', managed_postgres: managed, database_path: '/private/db' })).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(published);
      expect(() => saveConfig({ engine: 'postgres', managed_postgres: managed }, {
        writeSync: () => { throw new Error('injected write failure'); },
      })).toThrow('injected write failure');
      expect(readFileSync(path, 'utf8')).toBe(published);
      expect(() => saveConfig({ engine: 'postgres', managed_postgres: managed }, {
        fsyncSync: () => { throw new Error('injected file fsync failure'); },
      })).toThrow('injected file fsync failure');
      expect(readFileSync(path, 'utf8')).toBe(published);
      expect(() => saveConfig({ engine: 'postgres', managed_postgres: managed }, {
        renameSync: () => { throw new Error('injected rename failure'); },
      })).toThrow('injected rename failure');
      expect(readFileSync(path, 'utf8')).toBe(published);
      expect(readdirSync(join(root, '.gbrain')).filter((name) => name.includes('.tmp-'))).toEqual([]);

      const linkedTemp = `${path}.tmp-${'00'.repeat(16)}`;
      symlinkSync(path, linkedTemp);
      expect(() => saveConfig({ engine: 'postgres', managed_postgres: managed }, {
        randomBytes: () => new Uint8Array(16),
      })).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(published);
      expect(lstatSync(linkedTemp).isSymbolicLink()).toBe(true);
    });
  });

  test('directory fsync failure reports uncertain publication after rename', async () => {
    const root = home();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const path = join(root, '.gbrain', 'config.json');
      saveConfig({ engine: 'postgres' });
      rmSync(path);
      publishManagedInitConfig(managed);
      let syncCalls = 0;
      expect(() => saveConfig({ engine: 'postgres', managed_postgres: managed }, {
        fsyncSync: (fd) => {
          syncCalls++;
          if (syncCalls === 2) throw new Error('directory sync fault');
          return fsyncSync(fd);
        },
      })).toThrow(ConfigPublicationUncertainError);
      expect(JSON.parse(readFileSync(path, 'utf8')).managed_postgres).toEqual(managed);
    });
  });

  test('only ordinary targets downgrade recognized unsupported directory durability errors', async () => {
    const codes = ['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM'];
    for (const phase of ['open', 'fsync'] as const) {
      for (const code of codes) {
        for (const target of ['ordinary', 'managed'] as const) {
          const root = home();
          await withEnv({ GBRAIN_HOME: root }, async () => {
            const path = join(root, '.gbrain', 'config.json');
            saveConfig({ engine: 'postgres' });
            if (target === 'managed') { rmSync(path); publishManagedInitConfig(managed); }
            const fault = Object.assign(new Error(`injected ${code}`), { code });
            let syncCalls = 0;
            const injected = {
              ...(phase === 'open' ? {
                openSync: ((file: string | Buffer, flags: number, mode?: number) => {
                  if (String(file).endsWith('/.gbrain')) throw fault;
                  return openSync(file, flags, mode);
                }) as typeof openSync,
              } : {}),
              ...(phase === 'fsync' ? {
                fsyncSync: (fd: number) => {
                  syncCalls++;
                  if (syncCalls === 2) throw fault;
                  return fsyncSync(fd);
                },
              } : {}),
            };
            const config = target === 'managed' ? { engine: 'postgres' as const, managed_postgres: managed } : { engine: 'postgres' as const };
            if (target === 'ordinary') {
              expect(() => saveConfig(config, injected)).not.toThrow();
            } else {
              expect(() => saveConfig(config, injected)).toThrow(ConfigPublicationUncertainError);
            }
            expect(JSON.parse(readFileSync(path, 'utf8')).managed_postgres).toEqual(target === 'managed' ? managed : undefined);
            expect(readdirSync(join(root, '.gbrain')).filter((name) => name.includes('.tmp-'))).toEqual([]);
          });
        }
      }
    }
  });

  test('post-rename EIO and unknown errors remain uncertain for every target', async () => {
    for (const code of ['EIO', 'EUNKNOWN']) {
      for (const target of ['ordinary', 'managed'] as const) {
        const root = home();
        await withEnv({ GBRAIN_HOME: root }, async () => {
          const path = join(root, '.gbrain', 'config.json');
          saveConfig({ engine: 'postgres' });
          if (target === 'managed') { rmSync(path); publishManagedInitConfig(managed); }
          let syncCalls = 0;
          const error = Object.assign(new Error(code), { code });
          const config = target === 'managed' ? { engine: 'postgres' as const, managed_postgres: managed } : { engine: 'postgres' as const };
          expect(() => saveConfig(config, { fsyncSync: (fd) => {
            syncCalls++;
            if (syncCalls === 2) throw error;
            return fsyncSync(fd);
          } })).toThrow(ConfigPublicationUncertainError);
          expect(JSON.parse(readFileSync(path, 'utf8')).managed_postgres).toEqual(target === 'managed' ? managed : undefined);
          expect(readdirSync(join(root, '.gbrain')).filter((name) => name.includes('.tmp-'))).toEqual([]);
        });
      }
    }
  });

  test('recognized unsupported codes before rename remain ordinary failures', async () => {
    for (const phase of ['open', 'write', 'fsync', 'rename'] as const) {
      for (const code of ['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM']) {
        for (const target of ['ordinary', 'managed'] as const) {
          const root = home();
          await withEnv({ GBRAIN_HOME: root }, async () => {
            const path = join(root, '.gbrain', 'config.json');
            saveConfig({ engine: 'postgres' });
            if (target === 'managed') { rmSync(path); publishManagedInitConfig(managed); }
            const oldBytes = readFileSync(path, 'utf8');
            const error = Object.assign(new Error(`injected ${code}`), { code });
            const config = target === 'managed' ? { engine: 'postgres' as const, managed_postgres: managed } : { engine: 'postgres' as const };
            const dependencies = phase === 'open'
              ? { openSync: ((file: string | Buffer, flags: number, mode?: number) => {
                if (String(file).includes('.tmp-')) throw error;
                return openSync(file, flags, mode);
              }) as typeof openSync }
              : phase === 'write'
                ? { writeSync: () => { throw error; } }
                : phase === 'fsync'
              ? { fsyncSync: () => { throw error; } }
              : { renameSync: () => { throw error; } };
            expect(() => saveConfig(config, dependencies)).toThrow(error);
            expect(readFileSync(path, 'utf8')).toBe(oldBytes);
            expect(readdirSync(join(root, '.gbrain')).filter((name) => name.includes('.tmp-'))).toEqual([]);
          });
        }
      }
    }
  });

  test('consecutive publications use unique temps and preserve unrelated fields', async () => {
    const root = home();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      saveConfig({ engine: 'pglite', database_path: '/tmp/x', backup: { check_enabled: true } });
      saveConfig({ engine: 'pglite', database_path: '/tmp/x', backup: { check_enabled: true, check_interval_days: 14 } });
      const path = join(root, '.gbrain', 'config.json');
      expect(JSON.parse(readFileSync(path, 'utf8')).backup).toEqual({ check_enabled: true, check_interval_days: 14 });
      expect(readdirSync(join(root, '.gbrain')).filter((name) => name.includes('.tmp-'))).toEqual([]);
    });
  });

  test('publication lock refuses existing artifacts and releases after success and failure', async () => {
    const root = home();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const dir = join(root, '.gbrain');
      mkdirSync(dir);
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, '{"engine":"postgres"}\n');
      const lock = join(dir, '.config-publication.lock');
      writeFileSync(lock, 'held');
      expect(() => saveConfig({ engine: 'postgres', backup: { check_enabled: true } })).toThrow('Config publication refused');
      expect(readFileSync(configPath, 'utf8')).toBe('{"engine":"postgres"}\n');
      expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
      rmSync(lock);

      saveConfig({ engine: 'postgres' });
      writeFileSync(configPath, JSON.stringify({ backup: { check_enabled: true } }));
      expect(() => publishManagedInitConfig(managed)).not.toThrow();
      expect(readdirSync(dir)).not.toContain('.config-publication.lock');
      const before = readFileSync(configPath, 'utf8');
      expect(() => saveConfig({ engine: 'postgres', managed_postgres: managed }, { writeSync: () => { throw new Error('before rename'); } })).toThrow('before rename');
      expect(readFileSync(configPath, 'utf8')).toBe(before);
      expect(readdirSync(dir)).not.toContain('.config-publication.lock');
      let syncCalls = 0;
      expect(() => saveConfig({ engine: 'postgres', managed_postgres: managed }, { fsyncSync: (fd) => {
        syncCalls++;
        if (syncCalls === 2) throw new Error('post rename uncertainty');
        return fsyncSync(fd);
      } })).toThrow(ConfigPublicationUncertainError);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).managed_postgres).toEqual(managed);
      expect(readdirSync(dir)).not.toContain('.config-publication.lock');
    });
  });

  test('publication lock excludes an independent process until release', async () => {
    const root = home();
    const dir = join(root, '.gbrain'); mkdirSync(dir);
    const path = join(dir, 'config.json');
    const original = '{"backup":{"preserve":true}}\n';
    writeFileSync(path, original);
    const helper = join(import.meta.dir, 'helpers/config-publication-process.ts');
    const args = (mode: string) => ['run', helper, mode, dir, path];
    const holder = spawn(process.execPath, args('hold'), { stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      holder.once('exit', (code, signal) => resolve({ code, signal }));
      holder.once('error', (error) => resolve({ code: null, signal: null, error }));
    });
    let output = '';
    holder.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    let ready = false;
    let releaseSent = false;
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('holder readiness timed out')), 5000);
      const onData = () => { if (output.includes('locked\n')) { ready = true; finish(); } };
      const onExit = (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
        if (!ready) finish(result.error ?? new Error(`holder exited before readiness (${result.code ?? result.signal})`));
      };
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        holder.stdout.off('data', onData);
        error ? reject(error) : resolve();
      };
      holder.stdout.on('data', onData);
      void exit.then(onExit);
    });
    const waitForExit = async (timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timed = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('holder exit timed out')), timeoutMs); });
      try { return await Promise.race([exit, timed]); }
      finally { if (timer) clearTimeout(timer); }
    };
    try {
      await readyPromise;
      const refused = spawnSync(process.execPath, args('publish'), { encoding: 'utf8', timeout: 5000 });
      expect(refused.error).toBeUndefined();
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain('refused');
      expect(readFileSync(path, 'utf8')).toBe(original);
      expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
      holder.stdin.end('\n');
      releaseSent = true;
      const holderResult = await waitForExit(5000);
      expect(holderResult.error).toBeUndefined();
      expect(holderResult.code).toBe(0);
      expect(output).toContain('released');
      const later = spawnSync(process.execPath, args('publish'), { encoding: 'utf8', timeout: 5000 });
      expect(later.error).toBeUndefined();
      expect(later.status).toBe(0);
      expect(later.stdout).toContain('published');
      expect(JSON.parse(readFileSync(path, 'utf8')).managed_postgres).toEqual(managed);
    } finally {
      if (!releaseSent && ready && holder.exitCode === null && holder.signalCode === null) {
        holder.stdin.end('\n');
        releaseSent = true;
      }
      if (!releaseSent && holder.exitCode === null && holder.signalCode === null) holder.kill('SIGTERM');
      if (holder.exitCode === null && holder.signalCode === null) {
        try { await waitForExit(5000); }
        catch { holder.kill('SIGKILL'); await waitForExit(5000).catch(() => undefined); }
      }
    }
  });

  test('lock symlink and malformed artifacts refuse without touching destination', async () => {
    const root = home();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const dir = join(root, '.gbrain');
      mkdirSync(dir);
      const path = join(dir, 'config.json');
      const original = '{"engine":"postgres"}\n';
      writeFileSync(path, original);
      const lock = join(dir, '.config-publication.lock');
      symlinkSync(path, lock);
      expect(() => saveConfig({ engine: 'postgres' })).toThrow('Config publication refused');
      expect(readFileSync(path, 'utf8')).toBe(original);
      expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
      rmSync(lock);
      writeFileSync(lock, '{malformed');
      expect(() => saveConfig({ engine: 'postgres' })).toThrow('Config publication refused');
      expect(readFileSync(path, 'utf8')).toBe(original);
      expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
    });
  });

  test('managed publication preserves concurrent metadata and refuses incompatible targets', async () => {
    const root = home();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const path = join(root, '.gbrain', 'config.json');
      saveConfig({ engine: 'postgres', backup: { check_enabled: true } });
      writeFileSync(path, JSON.stringify({ backup: { check_enabled: true } }));
      publishManagedInitConfig(managed);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ engine: 'postgres', managed_postgres: managed,
        backup: { check_enabled: true } });
      saveConfig({ engine: 'postgres', managed_postgres: managed, backup: { check_enabled: false } });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ managed_postgres: managed, backup: { check_enabled: false } });
      const compatible = [
        { backup: { check_enabled: true } },
        { engine: 'postgres', managed_postgres: managed, backup: { check_enabled: true } },
      ];
      for (const config of compatible) {
        writeFileSync(path, JSON.stringify(config));
        publishManagedInitConfig(managed);
      }
      for (const config of [
        { engine: 'pglite', database_path: '/private/db' },
        { engine: 'postgres', database_url: 'postgresql://private/db' },
        { engine: 'postgres', remote_mcp: { issuer_url: 'https://remote.invalid' } },
        { engine: 'postgres', thin_client: true },
        { engine: 'postgres' },
        { engine: 'pglite' },
        { engine: 'postgres', managed_postgres: { ...managed, cluster_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } },
        { engine: 'postgres', managed_postgres: { ...managed, password: 'secret' } },
      ]) {
        writeFileSync(path, JSON.stringify(config));
        const before = readFileSync(path, 'utf8');
        expect(() => publishManagedInitConfig(managed)).toThrow('Config publication refused');
        expect(readFileSync(path, 'utf8')).toBe(before);
        expect(readdirSync(join(root, '.gbrain')).filter((name) => name.includes('.tmp-'))).toEqual([]);
      }
    });
  });

  test('ordinary stale save cannot erase managed target; exact-reference save can update metadata', async () => {
    const root = home();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const path = join(root, '.gbrain', 'config.json');
      saveConfig({ engine: 'postgres', backup: { check_enabled: true } });
      writeFileSync(path, JSON.stringify({ backup: { check_enabled: true } }));
      const stale = { engine: 'postgres' as const, backup: { check_enabled: false } };
      publishManagedInitConfig(managed);
      const before = readFileSync(path, 'utf8');
      expect(() => saveConfig(stale)).toThrow('Config publication refused');
      expect(readFileSync(path, 'utf8')).toBe(before);
      saveConfig({ engine: 'postgres', managed_postgres: managed, backup: { check_enabled: false } });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ managed_postgres: managed,
        backup: { check_enabled: false } });
    });
  });

  test('strict reread refuses unsafe, non-object, and non-regular config files', async () => {
    const root = home();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const dir = join(root, '.gbrain');
      mkdirSync(dir);
      const path = join(dir, 'config.json');
      for (const bytes of ['null', '[]', 'false', '"text"', '{broken']) {
        writeFileSync(path, bytes);
        const before = readFileSync(path, 'utf8');
        expect(() => publishManagedInitConfig(managed)).toThrow(ConfigPublicationRefusedError);
        expect(readFileSync(path, 'utf8')).toBe(before);
        expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
      }
      rmSync(path);
      symlinkSync(join(dir, 'missing-target'), path);
      expect(() => publishManagedInitConfig(managed)).toThrow(ConfigPublicationRefusedError);
      rmSync(path);
      const targetFile = join(root, 'target-config.json');
      writeFileSync(targetFile, JSON.stringify({ engine: 'pglite' }));
      symlinkSync(targetFile, path);
      expect(() => publishManagedInitConfig(managed)).toThrow(ConfigPublicationRefusedError);
      rmSync(path);
      mkdirSync(path);
      expect(() => publishManagedInitConfig(managed)).toThrow(ConfigPublicationRefusedError);
      rmSync(path, { recursive: true });
      writeFileSync(path, 'x'.repeat(1024 * 1024 + 1));
      expect(() => publishManagedInitConfig(managed)).toThrow(ConfigPublicationRefusedError);
      rmSync(path);
      rmSync(dir, { recursive: true });
      const outside = join(root, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, dir);
      expect(() => publishManagedInitConfig(managed)).toThrow(ConfigPublicationRefusedError);
    });
  });

  test('descriptor snapshot refuses a destination replaced after open', async () => {
    const root = home();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const dir = join(root, '.gbrain');
      mkdirSync(dir);
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ backup: { check_enabled: true } }));
      let configLstats = 0;
      const deps = {
        file: {
          lstatSync: ((file: string | Buffer) => {
            if (String(file).endsWith('/config.json') && ++configLstats === 2) {
              unlinkSync(path);
              writeFileSync(path, '{"backup":{"check_enabled":false}}');
            }
            return lstatSync(file);
          }) as typeof lstatSync,
        },
      };
      expect(() => publishManagedInitConfigFile(managed, dir, path, deps)).toThrow(ConfigPublicationRefusedError);
      expect(readFileSync(path, 'utf8')).toBe('{"backup":{"check_enabled":false}}');
      expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
    });
  });

  test('managed publication refuses requested ancestor symlinks without touching target', async () => {
    const root = home();
    const actualParent = join(root, 'actual-parent');
    const alias = join(root, 'parent-alias');
    const dir = join(actualParent, '.gbrain');
    mkdirSync(dir, { recursive: true });
    const destination = join(dir, 'config.json');
    const original = '{"backup":{"check_enabled":true}}\n';
    writeFileSync(destination, original);
    symlinkSync(actualParent, alias);
    await withEnv({ GBRAIN_HOME: alias }, async () => {
      expect(() => publishManagedInitConfig(managed)).toThrow(ConfigPublicationRefusedError);
      expect(readFileSync(destination, 'utf8')).toBe(original);
      expect(readdirSync(dir).filter((name) => name.includes('.tmp-') || name.includes('.lock'))).toEqual([]);
    });
  });

  test('managed publication refuses foreign-owned ancestors and unsafe writable modes', async () => {
    for (const unsafe of ['foreign-intermediate-owner', 'foreign-final-owner', 'world-writable'] as const) {
      const root = home();
      const dir = join(root, '.gbrain');
      mkdirSync(dir);
      const destination = join(dir, 'config.json');
      const original = '{"backup":{"check_enabled":true}}\n';
      writeFileSync(destination, original);
      const injectedLstat = ((path: string | Buffer) => {
        const stat = lstatSync(path);
        const alteredPath = unsafe === 'foreign-final-owner' ? realpathSync(dir) : realpathSync(root);
        if (String(path) !== alteredPath) return stat;
        const spoof = Object.create(stat);
        Object.defineProperty(spoof, unsafe === 'world-writable' ? 'mode' : 'uid', {
          value: unsafe === 'world-writable' ? stat.mode | 0o002 : 987654,
        });
        return spoof;
      }) as typeof lstatSync;
      expect(() => publishManagedInitConfigFile(managed, dir, destination, {
        file: { lstatSync: injectedLstat },
      })).toThrow(ConfigPublicationRefusedError);
      expect(readFileSync(destination, 'utf8')).toBe(original);
      expect(readdirSync(dir).filter((name) => name.includes('.tmp-') || name.includes('.lock'))).toEqual([]);
    }
  });

  test('managed publication permits a protected root-owned sticky writable ancestor', async () => {
    const root = home();
    const dir = join(root, '.gbrain'); mkdirSync(dir);
    const path = join(dir, 'config.json'); writeFileSync(path, '{"backup":{}}');
    const injectedLstat = ((target: string | Buffer) => {
      const stat = lstatSync(target);
      if (String(target) !== '/') return stat;
      const spoof = Object.create(stat);
      Object.defineProperties(spoof, {
        uid: { value: 0 },
        mode: { value: stat.mode | 0o1022 },
      });
      return spoof;
    }) as typeof lstatSync;
    expect(() => publishManagedInitConfigFile(managed, dir, path, { file: { lstatSync: injectedLstat } })).not.toThrow();
    expect(JSON.parse(readFileSync(path, 'utf8')).managed_postgres).toEqual(managed);
  });

  test('managed publication accepts only the verified macOS /var alias', () => {
    if (realpathSync('/var') !== '/private/var') return;
    const root = mkdtempSync('/var/tmp/gbrain-managed-var-'); homes.push(root);
    const dir = join(root, '.gbrain'); mkdirSync(dir);
    const path = join(dir, 'config.json'); writeFileSync(path, '{"backup":{}}');
    const aliasDir = dir.replace('/private/var', '/var');
    const aliasPath = join(aliasDir, 'config.json');
    expect(() => publishManagedInitConfigFile(managed, aliasDir, aliasPath)).not.toThrow();
    expect(JSON.parse(readFileSync(path, 'utf8')).managed_postgres).toEqual(managed);
  });

  test('managed publication rejects topology on establishment and matching-reference republish', async () => {
    const root = home();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const dir = join(root, '.gbrain'); mkdirSync(dir);
      const path = join(dir, 'config.json');
      for (const config of [
        { backup: {}, topology: { mode: 'local' } },
        { engine: 'postgres', managed_postgres: managed, topology: { mode: 'local' } },
      ]) {
        const before = JSON.stringify(config);
        writeFileSync(path, before);
        expect(() => publishManagedInitConfig(managed)).toThrow(ConfigPublicationRefusedError);
        expect(readFileSync(path, 'utf8')).toBe(before);
        expect(readdirSync(dir).filter((name) => name.includes('.tmp-') || name.includes('.lock'))).toEqual([]);
      }
    });
  });

  test('strict config snapshot refuses invalid UTF-8 and group/world-writable modes', async () => {
    const root = home();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const dir = join(root, '.gbrain'); mkdirSync(dir);
      const path = join(dir, 'config.json');
      writeFileSync(path, Buffer.from([0xc3, 0x28]));
      expect(() => publishManagedInitConfig(managed)).toThrow(ConfigPublicationRefusedError);
      writeFileSync(path, '{"backup":{}}');
      const mode = lstatSync(path).mode & 0o777;
      chmodSync(path, mode | 0o002);
      expect(() => publishManagedInitConfig(managed)).toThrow(ConfigPublicationRefusedError);
      expect(readdirSync(dir).filter((name) => name.includes('.tmp-') || name.includes('.lock'))).toEqual([]);
    });
  });

  test('managed publication does not create a missing config directory, including below symlink ancestry', async () => {
    const root = home();
    const missing = join(root, 'missing', '.gbrain');
    const alias = join(root, 'alias');
    symlinkSync(root, alias);
    await withEnv({ GBRAIN_HOME: missing }, async () => {
      expect(() => publishManagedInitConfig(managed)).toThrow(ConfigPublicationRefusedError);
      expect(() => lstatSync(missing)).toThrow();
    });
    await withEnv({ GBRAIN_HOME: join(alias, 'also-missing', '.gbrain') }, async () => {
      expect(() => publishManagedInitConfig(managed)).toThrow(ConfigPublicationRefusedError);
      expect(() => lstatSync(join(root, 'also-missing'))).toThrow();
    });
  });

  test('managed publisher exposes fixed outcomes and keeps installed bytes on uncertainty', async () => {
    const root = home();
    await withEnv({ GBRAIN_HOME: root }, async () => {
      const dir = join(root, '.gbrain');
      mkdirSync(dir);
      const path = join(dir, 'config.json');
      const old = '{"backup":{"check_enabled":true}}\n';
      writeFileSync(path, old);
      const rawFault = new Error(`/private/secret/path ${'z'.repeat(80)}`);
      expect(() => publishManagedInitConfigFile(managed, dir, path, {
        publication: { writeSync: () => { throw rawFault; } },
      })).toThrow(ConfigPublicationFailedError);
      expect(readFileSync(path, 'utf8')).toBe(old);
      let calls = 0;
      expect(() => publishManagedInitConfigFile(managed, dir, path, {
        publication: { fsyncSync: (fd) => {
          calls++;
          if (calls === 2) throw rawFault;
          return fsyncSync(fd);
        } },
      })).toThrow(ConfigPublicationUncertainError);
      expect(JSON.parse(readFileSync(path, 'utf8')).managed_postgres).toEqual(managed);
      expect((rawFault as Error).message).not.toContain('Config publication');
    });
  });

  test('lock identity replacement and cleanup failures report committed outcomes without stealing', async () => {
    const root = home();
    const dir = join(root, '.gbrain');
    mkdirSync(dir);
    const lock = join(dir, '.config-publication.lock');
    expect(() => withConfigPublicationLock(dir, () => {
      unlinkSync(lock);
      writeFileSync(lock, 'replacement');
    })).toThrow(ConfigPublicationCommittedCleanupError);
    expect(readFileSync(lock, 'utf8')).toBe('replacement');
    rmSync(lock);
    expect(() => withConfigPublicationLock(dir, () => withConfigPublicationLock(dir, () => undefined)))
      .toThrow(ConfigPublicationRefusedError);

    await withEnv({ GBRAIN_HOME: root }, async () => {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ backup: { check_enabled: true } }));
      expect(() => publishManagedInitConfigFile(managed, dir, path, {
        lock: { unlinkSync: () => { throw new Error('/private/secret/lock'); } },
      })).toThrow(ConfigPublicationCommittedCleanupError);
      expect(JSON.parse(readFileSync(path, 'utf8')).managed_postgres).toEqual(managed);
      rmSync(lock);
      let calls = 0;
      expect(() => publishManagedInitConfigFile(managed, dir, path, {
        lock: { unlinkSync: () => { throw new Error('/private/secret/lock'); } },
        publication: { fsyncSync: (fd) => {
          const next = fsyncSync;
          calls++;
          if (calls === 2) throw new Error('uncertain');
          return next(fd);
        } },
      })).toThrow(ConfigPublicationUncertainError);
    });
  });

  test('managed legacy migration warning stays redacted', async () => {
    const root = home();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withEnv({ GBRAIN_HOME: root }, async () => {
        const dir = join(root, '.gbrain');
        mkdirSync(dir);
        const path = join(dir, 'config.json');
        writeFileSync(path, JSON.stringify({ provider: 'private-provider', model: 'private-model' }));
        expect(() => publishManagedInitConfig(managed)).not.toThrow();
        expect(warn.mock.calls.flat().join(' ')).not.toContain('private-provider');
        expect(warn.mock.calls.flat().join(' ')).not.toContain('private-model');
      });
    } finally { warn.mockRestore(); }
  });
});
