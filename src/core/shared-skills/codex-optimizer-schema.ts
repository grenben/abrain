import { SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS } from './persistence-schema.ts';
const guard = SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS.find(s => s.startsWith('CREATE OR REPLACE FUNCTION gbrain_guard_request_protocol()'))!;
/** Retained native optimizer staging and canonical publication; migration 282. */
export const CODEX_SHARED_OPTIMIZER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_shared_skill_optimizations (
  run_id TEXT PRIMARY KEY REFERENCES codex_subscription_runs(run_id),
  request_id UUID NOT NULL UNIQUE,
  protocol INTEGER NOT NULL CHECK (protocol=1),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  input JSONB NOT NULL CHECK (jsonb_typeof(input)='object' AND octet_length(input::text)<=2097152),
  owner_token UUID,
  lease_until TIMESTAMPTZ,
  publication_fence JSONB,
  result JSONB,
  result_hash TEXT,
  admission JSONB,
  admission_hash TEXT,
  response JSONB,
  response_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((owner_token IS NULL)=(lease_until IS NULL)),
  CHECK ((result IS NULL)=(result_hash IS NULL)),
  CHECK ((admission IS NULL)=(admission_hash IS NULL)),
  CHECK ((response IS NULL)=(response_hash IS NULL)),
  CHECK (result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=524288 AND result_hash ~ '^[a-f0-9]{64}$')),
  CHECK (admission IS NULL OR (result IS NOT NULL AND jsonb_typeof(admission)='object' AND octet_length(admission::text)<=2097152 AND admission_hash ~ '^[a-f0-9]{64}$')),
  CHECK (response IS NULL OR (result IS NOT NULL AND jsonb_typeof(response)='object' AND octet_length(response::text)<=524288 AND response_hash ~ '^[a-f0-9]{64}$'))
);
ALTER TABLE codex_shared_skill_optimizations ENABLE ROW LEVEL SECURITY;
DO $codex_protocol$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='persistence_requests'::regclass
    AND c.conname='persistence_requests_protocol_version_check'
    AND pg_get_constraintdef(c.oid) ~ '(^|[^0-9])6([^0-9]|$)') THEN
    ALTER TABLE persistence_requests DROP CONSTRAINT IF EXISTS persistence_requests_protocol_version_check;
    ALTER TABLE persistence_requests ADD CONSTRAINT persistence_requests_protocol_version_check CHECK (protocol_version IN (1,2,3,4,5,6));
  END IF;
END $codex_protocol$;
${guard.replace('IF version<>2 OR', "IF version NOT IN (2,6) OR (version=6 AND NEW.operation<>'put_skill') OR")
  .replace('ELSIF version<>1 THEN', "ELSIF version NOT IN (1,3,4,5) OR (version IN (3,5) AND NEW.operation<>'put_page') OR (version=4 AND NEW.operation NOT IN ('put_page','takes_add')) THEN")};
`;
