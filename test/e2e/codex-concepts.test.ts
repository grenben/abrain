import { describe } from 'bun:test';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { codexConceptsContract } from '../helpers/codex-concepts-contract.ts';
const url = process.env.DATABASE_URL;
describe.skipIf(!url)('native PostgreSQL Codex concepts contract', () => {
  codexConceptsContract(async () => {
    const db = await isolatedPersistencePostgres(url!);
    return { engine: db.engine, cleanup: db.close };
  });
});
