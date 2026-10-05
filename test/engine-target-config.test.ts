import { afterEach, describe, expect, test } from 'bun:test';
import { fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';
import {
  ConfigPublicationUncertainError,
  loadConfig,
  loadConfigFileOnly,
  saveConfig,
  toEngineConfig,
} from '../src/core/config.ts';

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
      saveConfig({ engine: 'postgres', managed_postgres: managed, backup: { check_enabled: true } });
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
            const fault = Object.assign(new Error(`injected ${code}`), { code });
            let syncCalls = 0;
            const injected = {
              ...(phase === 'open' ? {
                openSync: ((file: string | Buffer, flags: number, mode?: number) => {
                  if (String(file) === join(root, '.gbrain')) throw fault;
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
});
