import { describe } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { codexPublicationContract } from '../helpers/codex-publication-contract.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('native PostgreSQL Codex publication contract', () => {
  codexPublicationContract(async () => {
    assertSafeE2eDatabaseUrl(url!);
    const database = `gbrain_test_codex_publication_${randomUUID().replace(/-/g, '')}`;
    const admin = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
    let created = false;
    const cleanup = async () => {
      try { if (created) await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`); }
      finally { await admin.end({ timeout: 5 }); }
    };
    const engine = new PostgresEngine();
    try {
      await admin.unsafe(`CREATE DATABASE ${database}`); created = true;
      const target = new URL(url!); target.pathname = `/${database}`;
      await engine.connect({ database_url: target.toString(), poolSize: 2 });
      return { engine, cleanup };
    } catch (error) { await engine.disconnect(); await cleanup(); throw error; }
  });
});
