import type { Migration } from './types.ts';
import { CODEX_PROPOSAL_CACHE_SCHEMA_SQL } from '../ai/codex-proposal-cache-schema.ts';
export const v271: Migration = {
  version: 271, name: 'codex_proposal_cache', idempotent: true, sql: CODEX_PROPOSAL_CACHE_SCHEMA_SQL,
};
