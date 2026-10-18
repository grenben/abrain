/** Native target regression for Codex admission state; avoids the unrelated halfvec fixture. */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyTable } from '../src/core/persistence/graduation-copy.ts';
import type { TriggerBypass } from '../src/core/persistence/engine-graduation.types.ts';
import { digestMismatches, inventoryEntry } from './helpers/graduation-copy-harness.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)('PGLite -> PostgreSQL Codex state copy', () => {
  for (const bypass of ['session_replication_role', 'disable_trigger'] as TriggerBypass[]) {
    test(`${bypass} carries parent/child runs and unresolved attempts`, async () => {
      const source = await isolatedSharedSkillsEngine();
      let target: Awaited<ReturnType<typeof isolatedSharedSkillsEngine>> | undefined;
      try {
        target = await isolatedSharedSkillsEngine(requirePostgresTestDatabase());
        await source.engine.executeRaw(`INSERT INTO codex_subscription_runs(run_id,account_lane,max_attempts,max_turns,deadline,parent_run_id)
          VALUES ('z-parent','lane',3,3,now() + interval '1 hour',NULL),
                 ('a-child','lane',1,1,now() + interval '1 hour','z-parent')`);
        await source.engine.executeRaw(`INSERT INTO codex_subscription_attempts(attempt_id,run_id,account_lane,request_hash,owner_id,state)
          VALUES ('a-attempt','a-child','lane','hash','owner','unresolved')`);
        const entries = ['codex_subscription_runs', 'codex_subscription_attempts'].map(relation => inventoryEntry(relation));
        for (const entry of entries) await copyTable({ source: source.engine, target: target.engine }, entry,
          { bypass, runId: randomUUID(), batchBytes: 64 });
        expect(await digestMismatches({ source: source.engine, target: target.engine }, entries)).toEqual([]);
        expect(await target.engine.executeRaw("SELECT parent_run_id FROM codex_subscription_runs WHERE run_id='a-child'"))
          .toEqual([{ parent_run_id: 'z-parent' }]);
        expect(await target.engine.executeRaw("SELECT state FROM codex_subscription_attempts WHERE attempt_id='a-attempt'"))
          .toEqual([{ state: 'unresolved' }]);
      } finally {
        await target?.close();
        await source.close();
      }
    }, 180_000);
  }
});
