import type { Migration } from './types.ts';
import { CODEX_BOOTSTRAP_JOB_SCHEMA_SQL } from '../skillopt/codex-bootstrap-job-schema.ts';
export const v285: Migration = { version: 285, name: 'codex_bootstrap_jobs', idempotent: true, sql: CODEX_BOOTSTRAP_JOB_SCHEMA_SQL };
