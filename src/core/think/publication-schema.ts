import { SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS } from '../shared-skills/persistence-schema.ts';
const guard = SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS.find(s => s.startsWith('CREATE OR REPLACE FUNCTION gbrain_guard_request_protocol()'))!;
export const THINK_PUBLICATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_think_publications (
  plan_id UUID PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES codex_subscription_runs(run_id),
  request_key TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_incarnation UUID NOT NULL REFERENCES sources(incarnation) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  admitted INTEGER[] NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted','complete')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(run_id,request_key)
);
ALTER TABLE codex_think_publications ENABLE ROW LEVEL SECURITY;
DO $codex_protocol$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='persistence_requests'::regclass
    AND c.conname='persistence_requests_protocol_version_check'
    AND pg_get_constraintdef(c.oid) ~ '(^|[^0-9])4([^0-9]|$)') THEN
    ALTER TABLE persistence_requests DROP CONSTRAINT IF EXISTS persistence_requests_protocol_version_check;
    ALTER TABLE persistence_requests ADD CONSTRAINT persistence_requests_protocol_version_check CHECK (protocol_version IN (1,2,3,4));
  END IF;
END $codex_protocol$;
${guard.replace('ELSIF version<>1 THEN', "ELSIF version NOT IN (1,3,4) OR (version=3 AND NEW.operation<>'put_page') OR (version=4 AND NEW.operation NOT IN ('put_page','takes_add')) THEN")};
`;
