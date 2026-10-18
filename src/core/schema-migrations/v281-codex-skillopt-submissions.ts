import type { Migration } from './types.ts';
import { CODEX_SKILLOPT_JOB_SCHEMA_SQL } from '../skillopt/codex-job-schema.ts';
export const v281: Migration = { version: 281, name: 'codex_skillopt_submissions', idempotent: true, sql: CODEX_SKILLOPT_JOB_SCHEMA_SQL };
