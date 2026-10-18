import type { Migration } from './types.ts';

export const v265: Migration = {
  version: 265, name: 'codex_take_proposal_evidence', idempotent: true,
  sql: 'ALTER TABLE take_proposals ADD COLUMN IF NOT EXISTS codex_evidence JSONB;',
};
