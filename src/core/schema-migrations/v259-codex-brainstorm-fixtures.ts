import type { Migration } from './types.ts';
import { CODEX_BRAINSTORM_FIXTURE_SCHEMA_SQL } from '../brainstorm/codex-fixture-schema.ts';
export const v259: Migration = {version:259,name:'codex_brainstorm_fixtures',idempotent:true,sql:CODEX_BRAINSTORM_FIXTURE_SCHEMA_SQL};
