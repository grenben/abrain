/** Host-owned benchmark identities and accepted result receipts, migration v275. */
export const CODEX_EVAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_eval_runs (
  run_id TEXT PRIMARY KEY REFERENCES codex_subscription_runs(run_id),
  protocol INTEGER NOT NULL CHECK (protocol=1),
  binding_hash TEXT NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  question_count INTEGER NOT NULL CHECK (question_count BETWEEN 1 AND 1000),
  required_stage TEXT NOT NULL CHECK (required_stage IN ('answer','judged')),
  owner_token UUID,
  lease_until TIMESTAMPTZ,
  state TEXT NOT NULL CHECK (state IN ('idle','running','complete','needs_reconciliation')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((owner_token IS NULL) = (lease_until IS NULL))
);
CREATE TABLE IF NOT EXISTS codex_eval_results (
  run_id TEXT NOT NULL REFERENCES codex_eval_runs(run_id),
  question_key TEXT NOT NULL CHECK (question_key ~ '^[a-f0-9]{64}$'),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  stage TEXT NOT NULL CHECK (stage IN ('answer','judged')),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=524288),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,question_key,stage)
);
ALTER TABLE codex_eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE codex_eval_results ENABLE ROW LEVEL SECURITY;
`;
