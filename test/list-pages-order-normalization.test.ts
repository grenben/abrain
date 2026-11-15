import { describe, expect, test } from 'bun:test';
import { listPageOrder } from '../src/core/ops/list-pages-pagination.ts';

const ctx = { remote: true, transport: 'stdio' } as any;

describe('list_pages order normalization', () => {
  test('whitelists sort values and keeps a bare updated_after cursor', () => {
    expect(listPageOrder(ctx, { sort: 'bogus', updated_after: '2026-08-11T00:00:00Z' })).toEqual({
      sort: undefined,
      updatedAfter: '2026-08-11T00:00:00Z',
      updatedAfterKeyset: undefined,
    });
    expect(listPageOrder(ctx, { sort: 'created_desc' })).toMatchObject({ sort: 'created_desc' });
  });

  test('keyset cursor forces updated_asc and rejects a slug without its timestamp', () => {
    expect(listPageOrder(ctx, {
      sort: 'updated_desc',
      updated_after: '2026-08-11T00:00:00Z',
      updated_after_slug: 'notes/alpha-example',
    })).toEqual({
      sort: 'updated_asc',
      updatedAfter: '2026-08-11T00:00:00Z',
      updatedAfterKeyset: { updatedAt: '2026-08-11T00:00:00Z', slug: 'notes/alpha-example' },
    });
    expect(() => listPageOrder(ctx, { updated_after_slug: 'notes/alpha-example' }))
      .toThrow(/requires updated_after/);
  });
});
