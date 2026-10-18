/** Source-scoped scheduled optimizer selection and completion; migration 248. */
export const CODEX_SKILLOPT_CYCLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_skillopt_cycles (
  run_id TEXT PRIMARY KEY REFERENCES codex_subscription_runs(run_id),
  protocol INTEGER NOT NULL CHECK (protocol=1),
  source_id TEXT NOT NULL,
  source_incarnation UUID NOT NULL,
  binding JSONB NOT NULL CHECK (jsonb_typeof(binding)='object' AND octet_length(binding::text)<=65536),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  selection JSONB NOT NULL CHECK (jsonb_typeof(selection)='array' AND jsonb_array_length(selection)<=20),
  selection_hash TEXT NOT NULL CHECK (selection_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('pending','complete','failed')),
  result_hash TEXT CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  CHECK ((state='pending')=(settled_at IS NULL)),
  CHECK ((state='complete')=(result_hash IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS codex_skillopt_cycles_pending_source
  ON codex_skillopt_cycles(source_id,source_incarnation) WHERE state='pending';
CREATE INDEX IF NOT EXISTS codex_skillopt_cycles_cooldown
  ON codex_skillopt_cycles(source_id,source_incarnation,settled_at DESC);
ALTER TABLE codex_skillopt_cycles ENABLE ROW LEVEL SECURITY;
`;
