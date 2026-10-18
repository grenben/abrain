import type { Migration } from './types.ts';
import { CODEX_EVAL_SCHEMA_SQL } from '../ai/codex-eval-schema.ts';
export const v275: Migration = {
  version: 275, name: 'codex_eval_results', idempotent: true, sql: CODEX_EVAL_SCHEMA_SQL,
};
