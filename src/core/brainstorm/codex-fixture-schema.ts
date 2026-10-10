/** Separate durable fixture identity from its single shared native allowance (v259). */
export const CODEX_BRAINSTORM_FIXTURE_SCHEMA_SQL = `
ALTER TABLE codex_brainstorm_runs ADD COLUMN IF NOT EXISTS subscription_run_id TEXT;
UPDATE codex_brainstorm_runs SET subscription_run_id=run_id WHERE subscription_run_id IS NULL;
ALTER TABLE codex_brainstorm_runs ALTER COLUMN subscription_run_id SET NOT NULL;
ALTER TABLE codex_brainstorm_runs DROP CONSTRAINT IF EXISTS codex_brainstorm_runs_run_id_fkey;
ALTER TABLE codex_brainstorm_runs DROP CONSTRAINT IF EXISTS codex_brainstorm_runs_subscription_run_id_fkey;
ALTER TABLE codex_brainstorm_runs ADD CONSTRAINT codex_brainstorm_runs_subscription_run_id_fkey
  FOREIGN KEY(subscription_run_id) REFERENCES codex_subscription_runs(run_id);
ALTER TABLE codex_brainstorm_runs DROP CONSTRAINT IF EXISTS codex_brainstorm_runs_protocol_check;
ALTER TABLE codex_brainstorm_runs ADD CONSTRAINT codex_brainstorm_runs_protocol_check
  CHECK ((protocol=1 AND run_id=subscription_run_id) OR protocol=2);
CREATE INDEX IF NOT EXISTS codex_brainstorm_runs_subscription_run ON codex_brainstorm_runs(subscription_run_id);
`;
