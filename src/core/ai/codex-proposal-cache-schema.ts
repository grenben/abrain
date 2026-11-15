/** Raw accepted proposals only; no parsed legacy cache entries or failure results. */
export const CODEX_PROPOSAL_CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_proposal_cache (
  namespace TEXT NOT NULL CHECK (namespace ~ '^[a-zA-Z0-9._:-]{1,120}$'),
  binding_hash TEXT NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  run_id TEXT NOT NULL REFERENCES codex_subscription_runs(run_id),
  response_text TEXT NOT NULL CHECK (octet_length(response_text) BETWEEN 2 AND 262144),
  response_hash TEXT NOT NULL CHECK (response_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(namespace,binding_hash,request_hash)
);
ALTER TABLE codex_proposal_cache ENABLE ROW LEVEL SECURITY;
`;
