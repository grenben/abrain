/** Submission identity for background standalone benchmark generation; migration 288. */
export const CODEX_BOOTSTRAP_JOB_SCHEMA_SQL = `
ALTER TABLE codex_skillopt_bootstraps ADD COLUMN IF NOT EXISTS request_id UUID;
ALTER TABLE codex_skillopt_bootstraps ADD COLUMN IF NOT EXISTS job_id BIGINT REFERENCES minion_jobs(id) ON DELETE RESTRICT;
DO $bootstrap_job_binding$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codex_skillopt_bootstraps_job_binding' AND conrelid = 'codex_skillopt_bootstraps'::regclass) THEN
    ALTER TABLE codex_skillopt_bootstraps ADD CONSTRAINT codex_skillopt_bootstraps_job_binding CHECK ((request_id IS NULL) = (job_id IS NULL));
  END IF;
END $bootstrap_job_binding$;
CREATE UNIQUE INDEX IF NOT EXISTS codex_skillopt_bootstraps_request ON codex_skillopt_bootstraps(request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS codex_skillopt_bootstraps_job ON codex_skillopt_bootstraps(job_id) WHERE job_id IS NOT NULL;
`;
