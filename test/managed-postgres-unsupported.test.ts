import { describe, expect, test } from 'bun:test';
import { EngineTargetError } from '../src/core/engine-target.ts';
import {
  assertNoManagedPostgresTarget,
  MANAGED_POSTGRES_UNSUPPORTED_CODE,
  MANAGED_POSTGRES_UNSUPPORTED_MESSAGE,
  MANAGED_POSTGRES_UNSUPPORTED_OPERATIONS,
  ManagedPostgresUnsupportedError,
  type ManagedPostgresTargetLike,
} from '../src/core/managed-postgres-unsupported.ts';

const managedConfig = {
  engine: 'postgres',
  managed_postgres: {
    manager_id: 'gbrain-managed-postgres',
    cluster_id: '01234567-89ab-cdef-0123-456789abcdef',
  },
} satisfies ManagedPostgresTargetLike;

describe('managed PostgreSQL unsupported workflow contract', () => {
  test('every closed operation has the same fixed public message and code', () => {
    for (const operation of MANAGED_POSTGRES_UNSUPPORTED_OPERATIONS) {
      try {
        assertNoManagedPostgresTarget(managedConfig, operation);
        throw new Error('expected managed target refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(ManagedPostgresUnsupportedError);
        const refusal = error as ManagedPostgresUnsupportedError;
        expect(refusal.code).toBe(MANAGED_POSTGRES_UNSUPPORTED_CODE);
        expect(refusal.operation).toBe(operation);
        expect(refusal.message).toBe(MANAGED_POSTGRES_UNSUPPORTED_MESSAGE);
      }
    }
    expect(() => new ManagedPostgresUnsupportedError('attacker-controlled' as never)).toThrow(TypeError);
  });

  test('ordinary URL and PGLite targets pass unchanged', () => {
    expect(() => assertNoManagedPostgresTarget({
      engine: 'postgres', database_url: 'postgresql://u:p@example.invalid/db',
    }, 'db-repair')).not.toThrow();
    expect(() => assertNoManagedPostgresTarget({
      engine: 'pglite', database_path: '/private/brain',
    }, 'backup')).not.toThrow();
  });

  test('does not consult environment or filesystem state', () => {
    const original = process.env.GBRAIN_DATABASE_URL;
    try {
      process.env.GBRAIN_DATABASE_URL = 'postgresql://hostile.invalid/override';
      const config = {
        engine: 'postgres',
        database_url: 'postgresql://ordinary.invalid/target',
        get filesystem_path(): never { throw new Error('filesystem access is forbidden'); },
      } as unknown as ManagedPostgresTargetLike;
      expect(() => assertNoManagedPostgresTarget(config, 'mount')).not.toThrow();
    } finally {
      if (original === undefined) delete process.env.GBRAIN_DATABASE_URL;
      else process.env.GBRAIN_DATABASE_URL = original;
    }
  });

  test('contradictory and malformed managed targets retain EngineTargetError', () => {
    const uuid = '01234567-89ab-cdef-0123-456789abcdef';
    for (const config of [
      { ...managedConfig, database_url: `postgresql://user:secret@host.invalid/${uuid}` },
      { ...managedConfig, managed_postgres: { ...managedConfig.managed_postgres, cluster_id: `secret-${uuid}` } },
    ]) {
      try {
        assertNoManagedPostgresTarget(config, 'migration-target');
        throw new Error('expected malformed target refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(EngineTargetError);
        expect((error as Error).message).not.toContain('secret');
        expect((error as Error).message).not.toContain(uuid);
        expect((error as Error).message).not.toContain('/private');
      }
    }
  });
});
