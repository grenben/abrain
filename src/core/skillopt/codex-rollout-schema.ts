/** Permanent evaluation-to-job bindings; pruning a queue row must not erase replay identity. */
export const CODEX_SKILLOPT_ROLLOUT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_skillopt_rollouts (
  run_id TEXT NOT NULL REFERENCES codex_subscription_runs(run_id),
  invocation_id TEXT NOT NULL CHECK (invocation_id ~ '^[A-Za-z0-9._:-]{1,160}$'),
  protocol INTEGER NOT NULL CHECK (protocol=1),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  job_id BIGINT NOT NULL UNIQUE REFERENCES minion_jobs(id),
  trajectory JSONB CHECK (jsonb_typeof(trajectory)='object' AND octet_length(trajectory::text)<=262144),
  trajectory_hash TEXT CHECK (trajectory_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,invocation_id),
  CHECK ((trajectory IS NULL)=(trajectory_hash IS NULL))
);
ALTER TABLE codex_skillopt_rollouts ENABLE ROW LEVEL SECURITY;
`;
