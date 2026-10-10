import type { Migration } from './types.ts';
import { AUTO_THINK_SCHEMA_SQL } from '../cycle/auto-think-schema.ts';
export const v253: Migration = { version: 253, name: 'codex_auto_think_runs', idempotent: true, sql: AUTO_THINK_SCHEMA_SQL };
