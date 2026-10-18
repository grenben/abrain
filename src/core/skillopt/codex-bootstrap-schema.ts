/** Durable standalone benchmark generation; migration 260. */
export const CODEX_BOOTSTRAP_RUN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_skillopt_bootstraps (
  run_id TEXT PRIMARY KEY REFERENCES codex_subscription_runs(run_id),
  protocol INTEGER NOT NULL CHECK (protocol=1),
  input JSONB NOT NULL CHECK (jsonb_typeof(input)='object' AND octet_length(input::text)<=2097152),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  owner_token UUID,
  lease_until TIMESTAMPTZ,
  result JSONB CHECK (jsonb_typeof(result)='object' AND octet_length(result::text)<=1048576),
  result_hash TEXT CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  completed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((owner_token IS NULL)=(lease_until IS NULL)),
  CHECK ((result IS NULL)=(result_hash IS NULL)),
  CHECK (NOT completed OR result IS NOT NULL)
);
ALTER TABLE codex_skillopt_bootstraps ENABLE ROW LEVEL SECURITY;
`;
