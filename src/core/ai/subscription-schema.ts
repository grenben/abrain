/** Shared by both storage engines through migration v261; no production application here. */
export const SUBSCRIPTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_subscription_runs (
  run_id TEXT PRIMARY KEY,
  account_lane TEXT NOT NULL,
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 1000),
  max_turns INTEGER NOT NULL CHECK (max_turns BETWEEN 1 AND 1000),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  accepted_turns INTEGER NOT NULL DEFAULT 0 CHECK (accepted_turns >= 0),
  repairs INTEGER NOT NULL DEFAULT 0 CHECK (repairs BETWEEN 0 AND 1),
  deadline TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS codex_subscription_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES codex_subscription_runs(run_id),
  account_lane TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','unresolved','succeeded','failed')),
  input_tokens BIGINT CHECK (input_tokens >= 0),
  cached_input_tokens BIGINT CHECK (cached_input_tokens >= 0),
  output_tokens BIGINT CHECK (output_tokens >= 0),
  accepted BOOLEAN NOT NULL DEFAULT false,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS codex_subscription_account_active
  ON codex_subscription_attempts(account_lane) WHERE state IN ('active','unresolved');
`;
