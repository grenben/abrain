import type { Migration } from './types.ts';
import { CODEX_SHARED_OPTIMIZER_SCHEMA_SQL } from '../shared-skills/codex-optimizer-schema.ts';
export const v336: Migration = { version: 336, name: 'codex_shared_skill_optimization', idempotent: true, sql: CODEX_SHARED_OPTIMIZER_SCHEMA_SQL };
