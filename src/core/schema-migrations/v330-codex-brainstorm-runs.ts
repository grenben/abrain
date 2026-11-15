import type { Migration } from './types.ts';
import { CODEX_BRAINSTORM_SCHEMA_SQL } from '../brainstorm/codex-schema.ts';
export const v330: Migration = { version: 330,name:'codex_brainstorm_runs',idempotent:true,sql:CODEX_BRAINSTORM_SCHEMA_SQL };
