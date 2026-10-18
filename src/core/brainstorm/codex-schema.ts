import { SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS } from '../shared-skills/persistence-schema.ts';
const guard=SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS.find(s=>s.startsWith('CREATE OR REPLACE FUNCTION gbrain_guard_request_protocol()'))!;
/** Durable native brainstorm selection, results and publication, migration v258. */
export const CODEX_BRAINSTORM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_brainstorm_runs (
  run_id TEXT PRIMARY KEY REFERENCES codex_subscription_runs(run_id),
  protocol INTEGER NOT NULL CHECK (protocol=1),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  owner_token UUID,
  lease_until TIMESTAMPTZ,
  state TEXT NOT NULL CHECK (state IN ('idle','running','complete','needs_reconciliation')),
  selection JSONB,
  selection_hash TEXT,
  result JSONB,
  result_hash TEXT,
  publication JSONB,
  publication_hash TEXT,
  publication_admitted BOOLEAN NOT NULL DEFAULT false,
  publication_complete BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((owner_token IS NULL) = (lease_until IS NULL)),
  CHECK ((selection IS NULL) = (selection_hash IS NULL)),
  CHECK (selection IS NULL OR (jsonb_typeof(selection)='object' AND octet_length(selection::text)<=2097152 AND selection_hash ~ '^[a-f0-9]{64}$')),
  CHECK ((result IS NULL) = (result_hash IS NULL)),
  CHECK (result IS NULL OR (selection IS NOT NULL AND jsonb_typeof(result)='object' AND octet_length(result::text)<=2097152 AND result_hash ~ '^[a-f0-9]{64}$')),
  CHECK ((publication IS NULL) = (publication_hash IS NULL)),
  CHECK (publication IS NULL OR (result IS NOT NULL AND jsonb_typeof(publication)='object' AND octet_length(publication::text)<=2097152 AND publication_hash ~ '^[a-f0-9]{64}$')),
  CHECK (NOT publication_admitted OR publication IS NOT NULL),
  CHECK (NOT publication_complete OR publication_admitted),
  CHECK (state<>'complete' OR result IS NOT NULL)
);
ALTER TABLE codex_brainstorm_runs ENABLE ROW LEVEL SECURITY;
DO $codex_protocol$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='persistence_requests'::regclass
    AND c.conname='persistence_requests_protocol_version_check'
    AND pg_get_constraintdef(c.oid) ~ '(^|[^0-9])5([^0-9]|$)') THEN
    ALTER TABLE persistence_requests DROP CONSTRAINT IF EXISTS persistence_requests_protocol_version_check;
    ALTER TABLE persistence_requests ADD CONSTRAINT persistence_requests_protocol_version_check CHECK (protocol_version IN (1,2,3,4,5));
  END IF;
END $codex_protocol$;
${guard.replace('ELSIF version<>1 THEN', "ELSIF version NOT IN (1,3,4,5) OR (version IN (3,5) AND NEW.operation<>'put_page') OR (version=4 AND NEW.operation NOT IN ('put_page','takes_add')) THEN")};
`;
