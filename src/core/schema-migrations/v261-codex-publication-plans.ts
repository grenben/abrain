import type { Migration } from './types.ts';

export const v261: Migration = {
  version: 261, name: 'codex_publication_plans', idempotent: true,
  sql: `CREATE TABLE IF NOT EXISTS codex_publication_plans (
    plan_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    source_incarnation UUID NOT NULL REFERENCES sources(incarnation) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('patterns','synthesis')),
    protocol_version INTEGER NOT NULL CHECK (protocol_version=1),
    payload JSONB NOT NULL,
    payload_hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted','complete')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS codex_publication_pending
    ON codex_publication_plans(source_id,source_incarnation,kind) WHERE state='accepted';`,
};
