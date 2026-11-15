import type { Migration } from './types.ts';
import { AUTO_THINK_SCHEMA_SQL } from '../cycle/auto-think-schema.ts';
export const v325: Migration = { version: 325, name: 'codex_auto_think_runs', idempotent: true, sql: AUTO_THINK_SCHEMA_SQL };
