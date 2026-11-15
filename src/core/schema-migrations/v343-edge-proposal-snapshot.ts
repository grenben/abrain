import type { Migration } from './types.ts';

export const v343: Migration = {
  version: 343,
  name: 'edge_proposal_snapshot',
  idempotent: true,
  sql: `ALTER TABLE link_edge_proposals ADD COLUMN IF NOT EXISTS judge_snapshot_hash TEXT;`,
};
