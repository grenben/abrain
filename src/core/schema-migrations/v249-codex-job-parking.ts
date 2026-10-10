import type { Migration } from './types.ts';
import { CODEX_JOB_UPGRADE_SCHEMA_SQL } from '../minions/codex-upgrade-schema.ts';

export const v249: Migration = {
  version: 249, name: 'codex_job_parking', idempotent: true,
  sql: CODEX_JOB_UPGRADE_SCHEMA_SQL,
};
