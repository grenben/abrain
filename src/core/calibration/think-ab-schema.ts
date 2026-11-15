export const THINK_AB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_think_ab_trials (
  trial_id UUID PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES codex_subscription_runs(run_id),
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_incarnation UUID NOT NULL REFERENCES sources(incarnation) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  binding JSONB NOT NULL,
  baseline JSONB,
  calibrated JSONB,
  result_id BIGINT UNIQUE REFERENCES think_ab_results(id),
  state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted','ready','rated')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (state='accepted' OR baseline IS NOT NULL AND calibrated IS NOT NULL),
  CHECK ((state='rated')=(result_id IS NOT NULL))
);
ALTER TABLE codex_think_ab_trials ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS codex_think_ab_source ON codex_think_ab_trials(source_id,created_at DESC);
`;
