/** Permanent batch request to queued worker identity; migration 279. */
export const CODEX_SKILLOPT_BATCH_JOB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_skillopt_batch_submissions (
  request_id UUID PRIMARY KEY,
  protocol INTEGER NOT NULL CHECK (protocol=1),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  data_hash TEXT NOT NULL CHECK (data_hash ~ '^[a-f0-9]{64}$'),
  job_id BIGINT NOT NULL UNIQUE REFERENCES minion_jobs(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE codex_skillopt_batch_submissions ENABLE ROW LEVEL SECURITY;
`;
