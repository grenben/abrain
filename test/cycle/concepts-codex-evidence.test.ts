import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { bindPrivateConceptEvidence, PRIVATE_CONCEPT_FENCE_FAILURE } from '../../src/core/cycle/concepts-codex.ts';

describe('private concept evidence bindings', () => {
  test('keeps queued groups independent when an earlier group changes before flush', async () => {
    const current = new Map([
      ['atoms/first', { revision: 'r1', page: { frontmatter: {} } }],
      ['atoms/second', { revision: 'r2', page: { frontmatter: {} } }],
    ]);
    const engine = {
      readPageSnapshot: async (slug: string) => current.get(slug) ?? null,
      lockPageKeys: async () => undefined,
    } as unknown as BrainEngine;
    const first = bindPrivateConceptEvidence(engine, 'source-a', [{ slug: 'atoms/first', revision: 'r1' }], 'policy-a', {});
    const second = bindPrivateConceptEvidence(engine, 'source-a', [{ slug: 'atoms/second', revision: 'r2' }], 'policy-a', {});

    current.set('atoms/first', { revision: 'r3', page: { frontmatter: {} } });
    await expect(first.checkAuthorityInTransaction(engine)).rejects.toThrow();
    await expect(second.checkAuthorityInTransaction(engine)).resolves.toBeUndefined();
    expect(first.pages).toEqual([{ slug: 'atoms/first', revision: 'r1' }]);
    expect(second.pages).toEqual([{ slug: 'atoms/second', revision: 'r2' }]);
  });

  test('rechecks authority for both admission and provenance transactions', async () => {
    let active = true;
    let pageLocks = 0;
    const checkAuthority = async () => { if (!active) throw new Error('authority revoked'); };
    const engine = {
      readPageSnapshot: async () => ({ revision: 'r1', page: { frontmatter: {} } }),
      lockPageKeys: async () => { pageLocks++; },
    } as unknown as BrainEngine;
    const evidence = bindPrivateConceptEvidence(engine, 'source-a', [{ slug: 'atoms/first', revision: 'r1' }], 'policy-a', {
      checkAuthority, checkAuthorityInTransaction: checkAuthority,
    });

    await evidence.checkAuthorityForAdmission(engine);
    expect(pageLocks).toBe(0);
    await evidence.checkAuthorityInTransaction(engine);
    expect(pageLocks).toBe(1);
    active = false;
    await expect(evidence.checkAuthorityInTransaction(engine)).rejects.toMatchObject({
      code: PRIVATE_CONCEPT_FENCE_FAILURE,
      cause: expect.objectContaining({ message: 'authority revoked' }),
    });
    expect(pageLocks).toBe(1);
    await expect(evidence.checkAuthority()).rejects.toThrow('authority revoked');
  });

  test('preserves PostgreSQL SQLSTATE errors for transaction retry handling', async () => {
    const deadlock = Object.assign(new Error('database detail must not be exposed'), { code: '40P01' });
    const engine = {
      readPageSnapshot: async () => ({ revision: 'r1', page: { frontmatter: {} } }),
      lockPageKeys: async () => undefined,
    } as unknown as BrainEngine;
    const evidence = bindPrivateConceptEvidence(engine, 'source-a', [{ slug: 'atoms/first', revision: 'r1' }], 'policy-a', {
      checkAuthorityInTransaction: async () => { throw deadlock; },
    });

    await expect(evidence.checkAuthorityForAdmission(engine)).rejects.toMatchObject({
      code: '40P01', message: 'Database transaction failed while validating private concept evidence.', cause: deadlock,
    });
    await expect(evidence.checkAuthorityInTransaction(engine)).rejects.toMatchObject({
      code: '40P01', message: 'Database transaction failed while validating private concept evidence.', cause: deadlock,
    });
  });
});
