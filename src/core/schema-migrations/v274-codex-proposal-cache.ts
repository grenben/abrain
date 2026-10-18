import type { Migration } from './types.ts';
import { CODEX_PROPOSAL_CACHE_SCHEMA_SQL } from '../ai/codex-proposal-cache-schema.ts';
export const v274: Migration = {
  version: 274, name: 'codex_proposal_cache', idempotent: true, sql: CODEX_PROPOSAL_CACHE_SCHEMA_SQL,
};
