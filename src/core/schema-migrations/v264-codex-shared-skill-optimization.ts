import type { Migration } from './types.ts';
import { CODEX_SHARED_OPTIMIZER_SCHEMA_SQL } from '../shared-skills/codex-optimizer-schema.ts';
export const v264: Migration = { version: 264, name: 'codex_shared_skill_optimization', idempotent: true, sql: CODEX_SHARED_OPTIMIZER_SCHEMA_SQL };
