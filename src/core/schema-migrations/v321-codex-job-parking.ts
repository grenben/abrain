import type { Migration } from './types.ts';
import { CODEX_JOB_UPGRADE_SCHEMA_SQL } from '../minions/codex-upgrade-schema.ts';

export const v321: Migration = {
  version: 321, name: 'codex_job_parking', idempotent: true,
  sql: CODEX_JOB_UPGRADE_SCHEMA_SQL,
};
