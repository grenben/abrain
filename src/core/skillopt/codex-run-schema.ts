/** Durable optimizer progress and accepted publication plans; migration 277. */
export const CODEX_SKILLOPT_RUN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_skillopt_runs (
  run_id TEXT PRIMARY KEY REFERENCES codex_subscription_runs(run_id),
  protocol INTEGER NOT NULL CHECK (protocol=1),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  input JSONB NOT NULL CHECK (jsonb_typeof(input)='object' AND octet_length(input::text)<=2097152),
  checkpoint JSONB NOT NULL CHECK (jsonb_typeof(checkpoint)='object' AND octet_length(checkpoint::text)<=524288),
  checkpoint_hash TEXT NOT NULL CHECK (checkpoint_hash ~ '^[a-f0-9]{64}$'),
  result JSONB CHECK (jsonb_typeof(result)='object' AND octet_length(result::text)<=524288),
  result_hash TEXT CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  owner_token UUID,
  lease_until TIMESTAMPTZ,
  deadline TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('idle','running','computed','complete','needs_reconciliation')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((owner_token IS NULL)=(lease_until IS NULL)),
  CHECK ((result IS NULL)=(result_hash IS NULL))
);
ALTER TABLE codex_skillopt_runs ENABLE ROW LEVEL SECURITY;
`;
