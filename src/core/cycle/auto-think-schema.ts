export const AUTO_THINK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_auto_think_runs (
  run_id TEXT NOT NULL REFERENCES codex_subscription_runs(run_id),
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_incarnation UUID NOT NULL REFERENCES sources(incarnation) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  binding JSONB NOT NULL,
  results JSONB NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted','complete')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY(run_id,source_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS codex_auto_think_pending ON codex_auto_think_runs(source_id) WHERE state='accepted';
ALTER TABLE codex_auto_think_runs ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS codex_auto_think_cooldown ON codex_auto_think_runs(source_id,completed_at DESC) WHERE state='complete';
`;
