/** Durable parking fences older workers and ordinary resume/cancel paths too. */
export const CODEX_JOB_UPGRADE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_parked_jobs (
  job_id INTEGER PRIMARY KEY REFERENCES minion_jobs(id),
  receipt_id UUID NOT NULL REFERENCES codex_upgrade_receipts(id),
  previous_status TEXT NOT NULL,
  replacement_job_id INTEGER REFERENCES minion_jobs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE codex_parked_jobs ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION enforce_codex_job_parking() RETURNS trigger SET search_path = pg_catalog, public AS $parking$
BEGIN
  IF TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM codex_parked_jobs WHERE job_id=OLD.id) THEN
    RAISE EXCEPTION 'codex_job_parked: explicit upgrade disposition required' USING ERRCODE='42501';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.parent_job_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM codex_parked_jobs WHERE job_id=NEW.parent_job_id) THEN
    RAISE EXCEPTION 'codex_parent_parked: explicit upgrade disposition required' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$parking$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS codex_job_parking ON minion_jobs;
CREATE TRIGGER codex_job_parking BEFORE INSERT OR UPDATE OR DELETE ON minion_jobs
  FOR EACH ROW EXECUTE FUNCTION enforce_codex_job_parking();
`;
