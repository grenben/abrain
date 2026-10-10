import type { Migration } from './types.ts';

export const v251: Migration = {
  version: 251, name: 'codex_calibration_evidence', idempotent: true,
  sql: `ALTER TABLE calibration_profiles ADD COLUMN IF NOT EXISTS codex_evidence JSONB;
    CREATE UNIQUE INDEX IF NOT EXISTS calibration_profiles_codex_request
    ON calibration_profiles(source_id,holder,(codex_evidence->>'subscription_run_id')) WHERE codex_evidence IS NOT NULL;`,
};
