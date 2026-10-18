import type { Migration } from './types.ts';
import { CODEX_SKILLOPT_CYCLE_SCHEMA_SQL } from '../skillopt/codex-cycle-schema.ts';
export const v268: Migration = { version: 268, name: 'codex_skillopt_cycles', idempotent: true, sql: CODEX_SKILLOPT_CYCLE_SCHEMA_SQL };
