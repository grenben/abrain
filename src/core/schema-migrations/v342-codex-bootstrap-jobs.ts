import type { Migration } from './types.ts';
import { CODEX_BOOTSTRAP_JOB_SCHEMA_SQL } from '../skillopt/codex-bootstrap-job-schema.ts';
export const v342: Migration = { version: 342, name: 'codex_bootstrap_jobs', idempotent: true, sql: CODEX_BOOTSTRAP_JOB_SCHEMA_SQL };
