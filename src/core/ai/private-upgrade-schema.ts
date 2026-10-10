/** Durable upgrade receipts contain only selected routing metadata, never prompts or credentials. */
export const CODEX_UPGRADE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_upgrade_receipts (
  sequence BIGSERIAL UNIQUE NOT NULL,
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('pins','jobs')),
  plan_hash TEXT NOT NULL,
  plan JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('applied','rolled_back')),
  receipt JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS codex_upgrade_plan_hash ON codex_upgrade_receipts(kind,plan_hash);
ALTER TABLE codex_upgrade_receipts ENABLE ROW LEVEL SECURITY;
`;
