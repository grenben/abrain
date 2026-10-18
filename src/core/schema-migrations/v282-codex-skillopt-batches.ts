import type { Migration } from './types.ts';
import { CODEX_SKILLOPT_BATCH_SCHEMA_SQL } from '../skillopt/codex-batch-schema.ts';
export const v282: Migration = { version: 282, name: 'codex_skillopt_batches', idempotent: true, sql: CODEX_SKILLOPT_BATCH_SCHEMA_SQL };
