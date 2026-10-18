import type { Migration } from './types.ts';
import { CODEX_SKILLOPT_JOB_SCHEMA_SQL } from '../skillopt/codex-job-schema.ts';
export const v278: Migration = { version: 278, name: 'codex_skillopt_submissions', idempotent: true, sql: CODEX_SKILLOPT_JOB_SCHEMA_SQL };
