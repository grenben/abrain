/** Retained host batch manifest and canonical optimizer memberships; migration 282. */
export const CODEX_SKILLOPT_BATCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_skillopt_batches (
  run_id TEXT PRIMARY KEY REFERENCES codex_subscription_runs(run_id),
  protocol INTEGER NOT NULL CHECK (protocol=1),
  input JSONB NOT NULL CHECK (jsonb_typeof(input)='object' AND octet_length(input::text)<=8388608),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  owner_token UUID,
  lease_until TIMESTAMPTZ,
  state TEXT NOT NULL CHECK (state IN ('idle','running','complete','needs_reconciliation')),
  result JSONB CHECK (jsonb_typeof(result)='object' AND octet_length(result::text)<=2097152),
  result_hash TEXT CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((owner_token IS NULL)=(lease_until IS NULL)),
  CHECK ((result IS NULL)=(result_hash IS NULL)),
  CHECK (state<>'complete' OR result IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS codex_skillopt_batch_members (
  batch_run_id TEXT NOT NULL REFERENCES codex_skillopt_batches(run_id),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 19),
  run_id TEXT NOT NULL UNIQUE REFERENCES codex_subscription_runs(run_id),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(batch_run_id,ordinal)
);
ALTER TABLE codex_skillopt_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE codex_skillopt_batch_members ENABLE ROW LEVEL SECURITY;
`;
