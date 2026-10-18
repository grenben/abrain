import type { Migration } from './types.ts';
import { CODEX_SHARED_OPTIMIZER_SCHEMA_SQL } from '../shared-skills/codex-optimizer-schema.ts';
export const v279: Migration = { version: 279, name: 'codex_shared_skill_optimization', idempotent: true, sql: CODEX_SHARED_OPTIMIZER_SCHEMA_SQL };
