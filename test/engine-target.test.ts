import { describe, expect, test } from 'bun:test';
import {
  EngineTargetError,
  managedPostgresIdentity,
  normalizeEngineTarget,
  validateManagedPostgresIdentity,
  validateManagedPostgresReference,
} from '../src/core/engine-target.ts';

const cluster = '01234567-89ab-cdef-0123-456789abcdef';
const reference = { manager_id: 'gbrain-managed-postgres', cluster_id: cluster } as const;

describe('managed PostgreSQL engine target', () => {
  test('validates exact reference shape and canonical UUID', () => {
    expect(validateManagedPostgresReference(reference)).toEqual(reference);
    for (const invalid of [
      null,
      {},
      { ...reference, manager_id: 'other' },
      { ...reference, cluster_id: cluster.toUpperCase() },
      { ...reference, cluster_id: 'not-a-uuid' },
      { ...reference, credential: 'secret-value' },
      { ...reference, path: '/private/path' },
      { ...reference, override: 'secret-value' },
      { ...reference, extra: true },
    ]) {
      expect(() => validateManagedPostgresReference(invalid)).toThrow(EngineTargetError);
      try { validateManagedPostgresReference(invalid); } catch (error) {
        expect((error as Error).message).not.toContain('secret-value');
      }
    }
  });

  test('exports a stable identity and normalizes managed/url/PGLite targets', () => {
    const identity = managedPostgresIdentity(reference);
    expect(identity).toBe(`postgres-managed:v1:gbrain-managed-postgres:${cluster}`);
    expect(validateManagedPostgresIdentity(identity)).toBe(identity);
    expect(normalizeEngineTarget({ engine: 'postgres', managed_postgres: reference })).toEqual({
      kind: 'postgres-managed', managed_postgres: reference,
    });
    expect(normalizeEngineTarget({ engine: 'postgres', database_url: 'postgresql://example.invalid/db' })).toEqual({
      kind: 'postgres-url', database_url: 'postgresql://example.invalid/db',
    });
    expect(normalizeEngineTarget({ engine: 'pglite', database_path: '/tmp/brain' })).toEqual({
      kind: 'pglite', database_path: '/tmp/brain',
    });
  });

  test('managed identity validator rejects malformed, noncanonical, and unknown identities without reflection', () => {
    const secret = 'secret-value';
    for (const invalid of [
      null,
      `postgres-managed:v1:gbrain-managed-postgres:${cluster.toUpperCase()}`,
      `postgres-managed:v2:gbrain-managed-postgres:${cluster}`,
      `postgres-managed:v1:other:${cluster}`,
      `postgres-managed:v1:gbrain-managed-postgres:${secret}`,
      `postgres-managed:v1:gbrain-managed-postgres:${cluster}:extra`,
    ]) {
      try { validateManagedPostgresIdentity(invalid); throw new Error('expected identity refusal'); } catch (error) {
        expect(error).toBeInstanceOf(EngineTargetError);
        expect((error as Error).message).not.toContain(secret);
        expect((error as Error).message).not.toContain(String(invalid));
      }
    }
  });

  test('rejects managed target conflicts without reflecting target contents', () => {
    const secretUrl = 'postgresql://user:secret-value@example.invalid/db';
    for (const invalid of [
      { engine: 'pglite', managed_postgres: reference },
      { engine: 'postgres', database_url: secretUrl, managed_postgres: reference },
      { engine: 'postgres', database_path: '/private/path', managed_postgres: reference },
      { engine: 'postgres', remote_mcp: {}, managed_postgres: reference },
      { engine: 'postgres', thin_client: true, managed_postgres: reference },
    ]) {
      try { normalizeEngineTarget(invalid as Parameters<typeof normalizeEngineTarget>[0]); throw new Error('expected target refusal'); } catch (error) {
        expect(error).toBeInstanceOf(EngineTargetError);
        expect((error as Error).message).not.toContain(secretUrl);
        expect((error as Error).message).not.toContain('secret-value');
      }
    }
  });
});
