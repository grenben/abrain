import { SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS } from '../shared-skills/persistence-schema.ts';

// Preserve the historical migration's protocol-1/2 guard; extend its current
// definition for a page protocol that old consumers cannot execute.
const guard = SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS.find(s => s.startsWith('CREATE OR REPLACE FUNCTION gbrain_guard_request_protocol()'))!;
export const CODEX_ACTION_WRITE_SCHEMA_SQL = `
ALTER TABLE subagent_tool_executions ADD COLUMN IF NOT EXISTS host_binding JSONB;
DO $codex_protocol$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='persistence_requests'::regclass
    AND c.conname='persistence_requests_protocol_version_check'
    AND pg_get_constraintdef(c.oid) ~ '(^|[^0-9])3([^0-9]|$)') THEN
    ALTER TABLE persistence_requests DROP CONSTRAINT IF EXISTS persistence_requests_protocol_version_check;
    ALTER TABLE persistence_requests ADD CONSTRAINT persistence_requests_protocol_version_check CHECK (protocol_version IN (1,2,3));
  END IF;
END $codex_protocol$;
${guard.replace('ELSIF version<>1 THEN', 'ELSIF version NOT IN (1,3) OR (version=3 AND NEW.operation<>\'put_page\') THEN')};
`;

// Existing subagent_tool_executions receives host_binding in migration v265,
// after the published migrations add started_at and ended_at.
export const CODEX_ACTION_WRITE_BOOTSTRAP_SQL = CODEX_ACTION_WRITE_SCHEMA_SQL.replace(
  'ALTER TABLE subagent_tool_executions ADD COLUMN IF NOT EXISTS host_binding JSONB;\n', '',
);
