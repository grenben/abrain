import type { Migration } from './types.ts';
import { CODEX_BOOTSTRAP_RUN_SCHEMA_SQL } from '../skillopt/codex-bootstrap-schema.ts';
export const v280: Migration = { version: 280, name: 'codex_bootstrap_runs', idempotent: true, sql: CODEX_BOOTSTRAP_RUN_SCHEMA_SQL };
