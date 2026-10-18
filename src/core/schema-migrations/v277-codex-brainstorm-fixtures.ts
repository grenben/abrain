import type { Migration } from './types.ts';
import { CODEX_BRAINSTORM_FIXTURE_SCHEMA_SQL } from '../brainstorm/codex-fixture-schema.ts';
export const v277: Migration = {version: 277,name:'codex_brainstorm_fixtures',idempotent:true,sql:CODEX_BRAINSTORM_FIXTURE_SCHEMA_SQL};
