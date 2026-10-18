import type { Migration } from './types.ts';
import { CODEX_ACTION_WRITE_SCHEMA_SQL } from '../persistence/codex-action-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
export const v262: Migration = {
  version: 262,
  name: 'codex_action_write_bindings',
  // Re-running must be safe: CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
  idempotent: true,
  sql: CODEX_ACTION_WRITE_SCHEMA_SQL,
};
