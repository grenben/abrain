/**
 * test/resolve-ipc-engine-uniform.test.ts — #4245 (TODOS "engine-uniform
 * IPC listener").
 *
 * Postgres brains have no PGLite data dir, so their serve IPC socket +
 * turn_context secret key off hash12(database_url) under ~/.gbrain/run
 * (0700). PGLite brains keep the data-dir socket unchanged (old serves and
 * hooks keep pairing). A postgres config carrying a LEFTOVER database_path
 * must never key off the path (the v0.45.7 gate, preserved).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureIpcSecretForConfig,
  ipcRunDir,
  ipcSecretPath,
  ipcSecretPathForConfig,
  readIpcSecretForConfig,
  resolveSocketPath,
  resolveSocketPathForConfig,
  startResolveIpcServer,
  resolveViaIpc,
  IPC_UNAVAILABLE,
} from '../src/core/context/resolve-ipc.ts';
import { withEnv } from './helpers/with-env.ts';
import { EngineTargetError } from '../src/core/engine-target.ts';
import { localIpcSocketPath } from '../src/core/context/ipc-path.ts';

const URL_A = 'postgresql://user:hunter2@db.example.com:5432/brain_a';
const URL_B = 'postgresql://user:hunter2@db.example.com:5432/brain_b';
const MANAGED_A = { manager_id: 'gbrain-managed-postgres', cluster_id: '123e4567-e89b-42d3-a456-426614174000' };
const MANAGED_B = { manager_id: 'gbrain-managed-postgres', cluster_id: '123e4567-e89b-42d3-a456-426614174001' };
const hash12 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-ipc-uniform-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Every assertion runs with GBRAIN_HOME pointed at this test's sandbox dir. */
const inSandboxHome = <T>(fn: () => T | Promise<T>) => withEnv({ GBRAIN_HOME: tmp }, fn);

describe('resolveSocketPathForConfig (#4245)', () => {
  it('returns null when there is no keying material', async () => {
    await inSandboxHome(() => {
      expect(resolveSocketPathForConfig(null)).toBeNull();
      expect(resolveSocketPathForConfig(undefined)).toBeNull();
      expect(resolveSocketPathForConfig({ engine: 'postgres' })).toBeNull();
      expect(resolveSocketPathForConfig({ engine: 'pglite' })).toBeNull();
    });
  });

  it('pglite keeps the data-dir socket (wire location unchanged)', async () => {
    await inSandboxHome(() => {
      const dataDir = join(tmp, 'db');
      expect(resolveSocketPathForConfig({ engine: 'pglite', database_path: dataDir })).toBe(
        resolveSocketPath(dataDir),
      );
    });
  });

  it('postgres keys a run-dir socket off hash12(database_url), no credentials in the path', async () => {
    await inSandboxHome(() => {
      const p = resolveSocketPathForConfig({ engine: 'postgres', database_url: URL_A });
      expect(p).not.toBeNull();
      const legacySocket = join(ipcRunDir(), `resolve-${hash12(URL_A)}.sock`);
      expect(p).toBe(localIpcSocketPath(legacySocket));
      expect(legacySocket).toMatch(/\/resolve-[0-9a-f]{12}\.sock$/);
      expect(p!).not.toContain('hunter2');
      // Deterministic: both ends (serve + hook) derive the identical path.
      expect(resolveSocketPathForConfig({ engine: 'postgres', database_url: URL_A })).toBe(p!);
      // Two brains on one machine never share a socket.
      expect(resolveSocketPathForConfig({ engine: 'postgres', database_url: URL_B })).not.toBe(p!);
    });
  });

  it('a postgres config with a LEFTOVER database_path never keys off the path (v0.45.7 gate)', async () => {
    await inSandboxHome(() => {
      const leftover = join(tmp, 'stale-pglite-dir');
      expect(
        resolveSocketPathForConfig({ engine: 'postgres', database_path: leftover }),
      ).toBeNull();
      // With a URL present, the URL wins — the leftover path is ignored.
      const p = resolveSocketPathForConfig({
        engine: 'postgres',
        database_path: leftover,
        database_url: URL_A,
      });
      expect(p).toBe(localIpcSocketPath(join(ipcRunDir(), `resolve-${hash12(URL_A)}.sock`)));
      expect(p!).not.toContain(leftover);
    });
  });

  it('managed targets use canonical identity hashes for both private addresses', async () => {
    await inSandboxHome(() => {
      const cfg = { engine: 'postgres' as const, managed_postgres: MANAGED_A };
      const socket = resolveSocketPathForConfig(cfg)!;
      const secret = ipcSecretPathForConfig(cfg)!;
      const identity = `postgres-managed:v1:${MANAGED_A.manager_id}:${MANAGED_A.cluster_id}`;
      const legacySocket = join(ipcRunDir(), `resolve-${hash12(identity)}.sock`);
      expect(socket).toBe(localIpcSocketPath(legacySocket));
      expect(secret).toBe(join(ipcRunDir(), `secret-${hash12(identity)}`));
      expect(legacySocket).toMatch(/\/resolve-[0-9a-f]{12}\.sock$/);
      expect(secret).toMatch(/\/secret-[0-9a-f]{12}$/);
      expect(resolveSocketPathForConfig(cfg)).toBe(socket);
      expect(ipcSecretPathForConfig(cfg)).toBe(secret);
      expect(socket).not.toContain(MANAGED_A.cluster_id);
      expect(secret).not.toContain(MANAGED_A.cluster_id);
      expect(resolveSocketPathForConfig({ engine: 'postgres', managed_postgres: MANAGED_B })).not.toBe(socket);
      expect(ipcSecretPathForConfig({ engine: 'postgres', managed_postgres: MANAGED_B })).not.toBe(secret);
      // Pure address derivation creates no run directory or secret file.
      expect(() => statSync(ipcRunDir())).toThrow();
    });
  });

  it('rejects invalid or contradictory managed targets before deriving an address', async () => {
    await inSandboxHome(() => {
      const invalid = () => resolveSocketPathForConfig({ engine: 'postgres', managed_postgres: { manager_id: 'bad', cluster_id: 'secret' } });
      expect(invalid).toThrow(EngineTargetError);
      let invalidError: unknown;
      try { invalid(); } catch (error) { invalidError = error; }
      expect(invalidError).toBeInstanceOf(EngineTargetError);
      expect((invalidError as Error).message).not.toContain('secret');
      expect((invalidError as Error).message).not.toContain('bad');

      let contradictoryError: unknown;
      try { ipcSecretPathForConfig({ engine: 'postgres', database_url: URL_A, managed_postgres: MANAGED_A }); }
      catch (error) { contradictoryError = error; }
      expect(contradictoryError).toBeInstanceOf(EngineTargetError);
      expect((contradictoryError as Error).message).not.toContain(URL_A);
      expect((contradictoryError as Error).message).not.toContain(MANAGED_A.cluster_id);
      expect(() => statSync(ipcRunDir())).toThrow();
    });
  });
});

describe('ipcSecretPathForConfig + ensure/read (#4245)', () => {
  it('pglite keeps the data-dir secret path', async () => {
    await inSandboxHome(() => {
      const dataDir = join(tmp, 'db');
      expect(ipcSecretPathForConfig({ engine: 'pglite', database_path: dataDir })).toBe(
        ipcSecretPath(dataDir),
      );
    });
  });

  it('postgres provisions a hash-keyed secret under the 0700 run dir, mode 0600', async () => {
    await inSandboxHome(() => {
      const cfg = { engine: 'postgres' as const, database_url: URL_A };
      expect(readIpcSecretForConfig(cfg)).toBeNull(); // absent until a serve provisions it
      const secret = ensureIpcSecretForConfig(cfg);
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      expect(readIpcSecretForConfig(cfg)).toBe(secret!);
      // Idempotent: a second serve reads the same secret back.
      expect(ensureIpcSecretForConfig(cfg)).toBe(secret!);
      const secretFile = ipcSecretPathForConfig(cfg)!;
      expect(secretFile.startsWith(ipcRunDir())).toBe(true);
      expect(statSync(secretFile).mode & 0o777).toBe(0o600);
      expect(statSync(ipcRunDir()).mode & 0o777).toBe(0o700);
      // Different brain → different secret file.
      expect(ipcSecretPathForConfig({ engine: 'postgres', database_url: URL_B })).not.toBe(secretFile);
    });
  });

  it('returns null with no keying material (never throws, never guesses)', async () => {
    await inSandboxHome(() => {
      expect(ensureIpcSecretForConfig(null)).toBeNull();
      expect(ensureIpcSecretForConfig({ engine: 'postgres' })).toBeNull();
      expect(readIpcSecretForConfig({ engine: 'postgres' })).toBeNull();
    });
  });
});

describe('postgres run-dir socket is servable end to end (#4245)', () => {
  it('a server bound at the config-keyed path answers a resolve round-trip', async () => {
    await inSandboxHome(async () => {
      const cfg = { engine: 'postgres' as const, database_url: URL_A };
      const sock = resolveSocketPathForConfig(cfg)!;
      const server = await startResolveIpcServer(sock, async () => ({
        text: 'pointer-block',
        pointers: [],
      }) as never);
      expect(server).not.toBeNull();
      try {
        const res = await resolveViaIpc(sock, { candidates: [] });
        expect(res).not.toBe(IPC_UNAVAILABLE);
        expect((res as { text: string }).text).toBe('pointer-block');
      } finally {
        server?.close();
      }
    });
  });
});
