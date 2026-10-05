import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { EngineTargetError } from '../src/core/engine-target.ts';

describe('direct PGLite target validation', () => {
  test('rejects malformed and contradictory targets before filesystem or DB effects', async () => {
    const attackerPath = `/tmp/gbrain-target-rejection-${crypto.randomUUID()}`;
    const attackerUrl = `postgresql://user:secret-${crypto.randomUUID()}@example.invalid/db`;
    const engine = new PGLiteEngine();
    for (const config of [
      { engine: 'pglite', database_path: attackerPath, managed_postgres: { manager_id: 'gbrain-managed-postgres', cluster_id: '01234567-89ab-cdef-0123-456789abcdef' } },
      { engine: 'pglite', database_url: attackerUrl },
      { engine: 'pglite', database_path: attackerPath, database_url: attackerUrl },
      { engine: 'postgres', database_url: attackerUrl },
      { engine: 'postgres', managed_postgres: { manager_id: 'gbrain-managed-postgres', cluster_id: 'attacker-uuid' } },
    ]) {
      let failure: unknown;
      try { await engine.connect(config as any); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(EngineTargetError);
      expect((failure as Error).message).not.toContain(attackerPath);
      expect((failure as Error).message).not.toContain(attackerUrl);
      expect((failure as Error).message).not.toContain('attacker-uuid');
      expect((engine as any)._db).toBeNull();
      expect(existsSync(attackerPath)).toBe(false);
    }
  });

  test('valid in-memory target connects and disconnects', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    expect(engine.kind).toBe('pglite');
    await engine.disconnect();
  });
});
