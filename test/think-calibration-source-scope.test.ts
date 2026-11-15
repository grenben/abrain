import { expect, test } from 'bun:test';
import { getLatestProfile } from '../src/commands/calibration.ts';
import type { BrainEngine } from '../src/core/engine.ts';

test('think calibration lookup keeps its source scope and remote publication filter', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const engine = {
    executeRaw: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return [];
    },
  } as unknown as BrainEngine;

  await getLatestProfile(engine, {
    holder: 'self',
    sourceId: 'tenant-a',
    publishedOnly: true,
  });
  expect(calls[0]!.sql).toContain('source_id = $2');
  expect(calls[0]!.sql).toContain('published = TRUE');
  expect(calls[0]!.params).toEqual(['self', 'tenant-a']);

  await getLatestProfile(engine, {
    holder: 'self',
    sourceIds: ['tenant-a', 'tenant-b'],
    publishedOnly: true,
  });
  expect(calls[1]!.sql).toContain('source_id = ANY($2::text[])');
  expect(calls[1]!.sql).toContain('published = TRUE');
  expect(calls[1]!.params).toEqual(['self', ['tenant-a', 'tenant-b']]);
});

test('an explicitly empty calibration source scope cannot become an unscoped lookup', async () => {
  let sql = '';
  const engine = {
    executeRaw: async (query: string) => { sql = query; return []; },
  } as unknown as BrainEngine;

  await getLatestProfile(engine, { holder: 'self', sourceIds: [] });
  expect(sql).toContain('AND FALSE');
  expect(sql).not.toContain('source_id = ANY');
});
