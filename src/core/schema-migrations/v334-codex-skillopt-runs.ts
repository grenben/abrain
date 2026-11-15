import type { Migration } from './types.ts';
import { CODEX_SKILLOPT_RUN_SCHEMA_SQL } from '../skillopt/codex-run-schema.ts';
export const v334: Migration = { version: 334, name: 'codex_skillopt_runs', idempotent: true, sql: CODEX_SKILLOPT_RUN_SCHEMA_SQL };
