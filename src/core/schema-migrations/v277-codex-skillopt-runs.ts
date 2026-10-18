import type { Migration } from './types.ts';
import { CODEX_SKILLOPT_RUN_SCHEMA_SQL } from '../skillopt/codex-run-schema.ts';
export const v277: Migration = { version: 277, name: 'codex_skillopt_runs', idempotent: true, sql: CODEX_SKILLOPT_RUN_SCHEMA_SQL };
