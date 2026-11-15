import type { Migration } from './types.ts';
import { CODEX_UPGRADE_SCHEMA_SQL } from '../ai/private-upgrade-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
export const v320: Migration = {
  version: 320,
  name: 'codex_upgrade_receipts',
  // Re-running must be safe: CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
  idempotent: true,
  sql: CODEX_UPGRADE_SCHEMA_SQL,
};
