import { describe, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { verifyCrashRecovery } from '../helpers/codex-actions-process-crash-runner.ts';
import { verifyOptimizerCrashRecovery, type OptimizerCrashPoint } from '../helpers/codex-optimizer-process-crash-runner.ts';

const url = process.env.DATABASE_URL;
type Scenario = 'read' | 'write-before' | 'write-after';

async function verifyPostgresCrashRecovery(scenario: Scenario | OptimizerCrashPoint): Promise<void> {
  assertSafeE2eDatabaseUrl(url!);
  const database = `gbrain_test_codex_kill_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE ${database}`);
    created = true;
    const target = new URL(url!);
    target.pathname = `/${database}`;
    if (scenario === 'read' || scenario === 'write-before' || scenario === 'write-after') await verifyCrashRecovery(scenario, target.toString());
    else await verifyOptimizerCrashRecovery(scenario, target.toString());
  } finally {
    try { if (created) await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`); }
    finally { await admin.end({ timeout: 5 }); }
  }
}

describe.skipIf(!url)('PostgreSQL private Codex action process-kill recovery', () => {
  test('a killed worker resumes the same pending read', () => verifyPostgresCrashRecovery('read'), 180_000);
  test('a killed worker resumes a write before admission', () => verifyPostgresCrashRecovery('write-before'), 180_000);
  test('a killed worker reconciles one committed write', () => verifyPostgresCrashRecovery('write-after'), 180_000);
  for (const point of ['checkpoint', 'result', 'file'] as const) {
    test(`a killed optimizer resumes after ${point} without duplicate effects`, () => verifyPostgresCrashRecovery(point), 240_000);
  }
  for (const point of ['shared-result', 'shared-committed', 'cycle-file', 'cycle-complete'] as const) {
    test(`a killed worker resumes ${point} with the original receipts`, () => verifyPostgresCrashRecovery(point), 600_000);
  }
});
