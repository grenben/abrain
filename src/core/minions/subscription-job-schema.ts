/** Per-claim protocol fence; older workers cannot execute subscription-bound jobs. */
export const SUBSCRIPTION_JOB_SCHEMA_SQL = `
ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS codex_claim_token BIGINT;
CREATE OR REPLACE FUNCTION enforce_codex_job_protocol() RETURNS trigger SET search_path = pg_catalog, public AS $protocol$
BEGIN
  IF NEW.status = 'active' AND (OLD.status <> 'active' OR NEW.lock_token IS DISTINCT FROM OLD.lock_token)
     AND EXISTS (SELECT 1 FROM codex_subscription_runs WHERE run_id LIKE 'codex-job:' || NEW.id::text || ':%')
     AND NEW.codex_claim_token IS DISTINCT FROM NEW.claim_generation THEN
    RAISE EXCEPTION 'Codex subscription job protocol 1 required: upgrade this worker before claiming subscription jobs';
  END IF;
  RETURN NEW;
END;
$protocol$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS codex_job_protocol ON minion_jobs;
CREATE TRIGGER codex_job_protocol BEFORE UPDATE ON minion_jobs
  FOR EACH ROW EXECUTE FUNCTION enforce_codex_job_protocol();
`;
