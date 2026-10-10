import type { Migration } from './types.ts';
import { CODEX_EVAL_SCHEMA_SQL } from '../ai/codex-eval-schema.ts';
export const v257: Migration = {
  version: 257, name: 'codex_eval_results', idempotent: true, sql: CODEX_EVAL_SCHEMA_SQL,
};
