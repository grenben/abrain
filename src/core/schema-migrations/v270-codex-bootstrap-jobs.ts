import type { Migration } from './types.ts';
import { CODEX_BOOTSTRAP_JOB_SCHEMA_SQL } from '../skillopt/codex-bootstrap-job-schema.ts';
export const v270: Migration = { version: 270, name: 'codex_bootstrap_jobs', idempotent: true, sql: CODEX_BOOTSTRAP_JOB_SCHEMA_SQL };
