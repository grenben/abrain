import type { Migration } from './types.ts';
import { CODEX_SKILLOPT_BATCH_JOB_SCHEMA_SQL } from '../skillopt/codex-batch-job-schema.ts';
export const v284: Migration = { version: 284, name: 'codex_skillopt_batch_submissions', idempotent: true, sql: CODEX_SKILLOPT_BATCH_JOB_SCHEMA_SQL };
