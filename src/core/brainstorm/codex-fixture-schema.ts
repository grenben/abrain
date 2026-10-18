/** Separate durable fixture identity from its single shared native allowance (v277). */
export const CODEX_BRAINSTORM_FIXTURE_SCHEMA_SQL = `
ALTER TABLE codex_brainstorm_runs ADD COLUMN IF NOT EXISTS subscription_run_id TEXT;
UPDATE codex_brainstorm_runs SET subscription_run_id=run_id WHERE subscription_run_id IS NULL;
ALTER TABLE codex_brainstorm_runs ALTER COLUMN subscription_run_id SET NOT NULL;
ALTER TABLE codex_brainstorm_runs DROP CONSTRAINT IF EXISTS codex_brainstorm_runs_run_id_fkey;
DO $codex_fixture_fk$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='codex_brainstorm_runs'::regclass AND conname='codex_brainstorm_runs_subscription_run_id_fkey') THEN
    ALTER TABLE codex_brainstorm_runs DROP CONSTRAINT IF EXISTS codex_brainstorm_runs_subscription_run_id_fkey;
    ALTER TABLE codex_brainstorm_runs ADD CONSTRAINT codex_brainstorm_runs_subscription_run_id_fkey
      FOREIGN KEY(subscription_run_id) REFERENCES codex_subscription_runs(run_id);
  END IF;
END $codex_fixture_fk$;
DO $codex_fixture_check$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='codex_brainstorm_runs'::regclass AND conname='codex_brainstorm_runs_protocol_check'
    AND pg_get_constraintdef(oid) LIKE '%protocol = 2%') THEN
    ALTER TABLE codex_brainstorm_runs DROP CONSTRAINT IF EXISTS codex_brainstorm_runs_protocol_check;
    ALTER TABLE codex_brainstorm_runs ADD CONSTRAINT codex_brainstorm_runs_protocol_check
      CHECK ((protocol=1 AND run_id=subscription_run_id) OR protocol=2);
  END IF;
END $codex_fixture_check$;
CREATE INDEX IF NOT EXISTS codex_brainstorm_runs_subscription_run ON codex_brainstorm_runs(subscription_run_id);
`;
