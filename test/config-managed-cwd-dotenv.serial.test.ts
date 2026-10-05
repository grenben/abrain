import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

describe('managed config with cwd dotenv quarantine', () => {
  test('keeps a valid managed reference when DATABASE_URL came from cwd .env', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-managed-dotenv-'));
    const priorCwd = process.cwd();
    const url = 'postgresql://app.invalid/app';
    const reference = { manager_id: 'gbrain-managed-postgres', cluster_id: '01234567-89ab-cdef-0123-456789abcdef' } as const;
    try {
      const project = join(root, 'project');
      const home = join(root, 'home');
      mkdirSync(project);
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(project, '.env'), `DATABASE_URL=${url}\n`);
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', managed_postgres: reference }));
      process.chdir(project);
      await withEnv({ GBRAIN_HOME: home, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: url }, () => {
        const config = loadConfig();
        expect(config?.managed_postgres).toEqual(reference);
        expect(config?.database_url).toBeUndefined();
      });
    } finally {
      process.chdir(priorCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
