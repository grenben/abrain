import { describe, test, expect } from 'bun:test';
import { createEngine } from '../src/core/engine-factory.ts';
import { EngineTargetError } from '../src/core/engine-target.ts';

describe('createEngine', () => {
  test('returns PGLiteEngine for pglite', async () => {
    const engine = await createEngine({ engine: 'pglite' });
    expect(engine.constructor.name).toBe('PGLiteEngine');
  });

  test('returns PostgresEngine for postgres', async () => {
    const engine = await createEngine({ engine: 'postgres' });
    expect(engine.constructor.name).toBe('PostgresEngine');
  });

  test('valid URL target selects PostgresEngine', async () => {
    const engine = await createEngine({ engine: 'postgres', database_url: 'postgresql://example.invalid/db' });
    expect(engine.constructor.name).toBe('PostgresEngine');
    await engine.disconnect();
  });

  test('valid managed target selects PostgresEngine', async () => {
    const engine = await createEngine({
      engine: 'postgres',
      managed_postgres: { manager_id: 'gbrain-managed-postgres', cluster_id: '01234567-89ab-cdef-0123-456789abcdef' },
    });
    expect(engine.constructor.name).toBe('PostgresEngine');
    await engine.disconnect();
  });

  test('rejects contradictory targets before selecting an engine', async () => {
    const cluster = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    for (const config of [
      { engine: 'pglite', database_path: '/private/path', managed_postgres: { manager_id: 'gbrain-managed-postgres', cluster_id: cluster } },
      { engine: 'postgres', database_path: '/private/path', managed_postgres: { manager_id: 'gbrain-managed-postgres', cluster_id: cluster } },
      { engine: 'pglite', database_url: 'postgresql://user:secret@host/db' },
      { engine: 'postgres', database_path: '/private/path', database_url: 'postgresql://user:secret@host/db' },
      { engine: 'postgres', managed_postgres: { manager_id: 'gbrain-managed-postgres', cluster_id: 'attacker-uuid' } },
    ]) {
      await expect(createEngine(config as any)).rejects.toBeInstanceOf(EngineTargetError);
      await expect(createEngine(config as any)).rejects.not.toThrow(/private\/path|secret|attacker-uuid/);
    }
  });

  test('defaults to PostgresEngine when engine is undefined', async () => {
    const engine = await createEngine({});
    expect(engine.constructor.name).toBe('PostgresEngine');
  });

  test('throws for sqlite with helpful message', async () => {
    await expect(createEngine({ engine: 'sqlite' as any })).rejects.toThrow('pglite');
  });

  test('throws for unknown engine', async () => {
    await expect(createEngine({ engine: 'mysql' as any })).rejects.toThrow('Unknown engine');
  });
});
