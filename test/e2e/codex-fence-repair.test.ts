import { describe } from 'bun:test';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { codexFenceRepairContract } from '../helpers/codex-fence-repair-contract.ts';
const url = process.env.DATABASE_URL;
describe.skipIf(!url)('native PostgreSQL Codex fence-repair contract', () => {
  codexFenceRepairContract(async () => {
    const db = await isolatedPersistencePostgres(url!);
    return { engine: db.engine, cleanup: db.close };
  });
});
