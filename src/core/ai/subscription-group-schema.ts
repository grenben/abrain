/** One-level child allowances share the root's attempts, accepted turns and repair bound. */
export const SUBSCRIPTION_GROUP_SCHEMA_SQL = `
ALTER TABLE codex_subscription_runs ADD COLUMN IF NOT EXISTS parent_run_id TEXT
  REFERENCES codex_subscription_runs(run_id);
CREATE INDEX IF NOT EXISTS codex_subscription_parent ON codex_subscription_runs(parent_run_id);

CREATE OR REPLACE FUNCTION gbrain_codex_subscription_group_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  parent codex_subscription_runs%ROWTYPE;
  attempts_delta INTEGER;
  turns_delta INTEGER;
  repairs_delta INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.parent_run_id IS DISTINCT FROM OLD.parent_run_id OR
      (NEW.parent_run_id IS NOT NULL AND NEW.run_id <> OLD.run_id)) THEN
    RAISE EXCEPTION 'subscription_identity_conflict';
  END IF;
  IF NEW.parent_run_id IS NULL THEN
    IF TG_OP = 'UPDATE' AND
       (NEW.run_id <> OLD.run_id OR NEW.account_lane <> OLD.account_lane OR NEW.deadline <> OLD.deadline OR
        NEW.max_attempts <> OLD.max_attempts OR NEW.max_turns <> OLD.max_turns) AND
       EXISTS (SELECT 1 FROM codex_subscription_runs WHERE parent_run_id=OLD.run_id) THEN
      RAISE EXCEPTION 'subscription_identity_conflict';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO parent FROM codex_subscription_runs WHERE run_id=NEW.parent_run_id FOR UPDATE;
  IF NOT FOUND OR parent.parent_run_id IS NOT NULL OR NEW.run_id=NEW.parent_run_id OR
     NEW.account_lane<>parent.account_lane OR NEW.deadline>parent.deadline OR
     NEW.max_attempts>parent.max_attempts OR NEW.max_turns>parent.max_turns THEN
    RAISE EXCEPTION 'subscription_identity_conflict';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.attempts<>0 OR NEW.accepted_turns<>0 OR NEW.repairs<>0 THEN
      RAISE EXCEPTION 'subscription_invalid';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.account_lane<>OLD.account_lane OR NEW.deadline<>OLD.deadline OR
     NEW.max_attempts<>OLD.max_attempts OR NEW.max_turns<>OLD.max_turns THEN
    RAISE EXCEPTION 'subscription_identity_conflict';
  END IF;
  attempts_delta := NEW.attempts-OLD.attempts;
  turns_delta := NEW.accepted_turns-OLD.accepted_turns;
  repairs_delta := NEW.repairs-OLD.repairs;
  IF attempts_delta<0 OR turns_delta<0 OR repairs_delta<0 OR
     NEW.attempts>NEW.max_attempts OR NEW.accepted_turns>NEW.max_turns OR
     NEW.accepted_turns>NEW.attempts OR NEW.repairs>NEW.attempts THEN
    RAISE EXCEPTION 'subscription_invalid';
  END IF;
  IF attempts_delta+turns_delta+repairs_delta=0 THEN RETURN NEW; END IF;
  UPDATE codex_subscription_runs SET attempts=attempts+attempts_delta,
    accepted_turns=accepted_turns+turns_delta, repairs=repairs+repairs_delta
    WHERE run_id=parent.run_id AND attempts+attempts_delta<=max_attempts
      AND accepted_turns+turns_delta<=max_turns AND repairs+repairs_delta<=1
      AND (attempts_delta=0 OR (accepted_turns<max_turns AND deadline>now()));
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_exhausted'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS codex_subscription_group_guard ON codex_subscription_runs;
CREATE TRIGGER codex_subscription_group_guard BEFORE INSERT OR UPDATE ON codex_subscription_runs
  FOR EACH ROW EXECUTE FUNCTION gbrain_codex_subscription_group_guard();
`;
