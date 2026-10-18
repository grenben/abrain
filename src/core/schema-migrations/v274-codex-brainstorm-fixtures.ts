import type { Migration } from './types.ts';
import { CODEX_BRAINSTORM_FIXTURE_SCHEMA_SQL } from '../brainstorm/codex-fixture-schema.ts';
export const v274: Migration = {version:274,name:'codex_brainstorm_fixtures',idempotent:true,sql:CODEX_BRAINSTORM_FIXTURE_SCHEMA_SQL};
