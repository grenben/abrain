/** Bounded host workflow tree: root -> child -> grandchild. Historical v240 stays unchanged. */
export const SUBSCRIPTION_TREE_SCHEMA_SQL = `
-- All admission/acceptance paths lock ancestors before descendants. A maximum of
-- two edges is sufficient for batch -> optimizer -> rollout, never model delegation.
CREATE OR REPLACE FUNCTION gbrain_codex_subscription_lock_path(target_run_id TEXT) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE locked_run TEXT;
BEGIN
  FOR locked_run IN
    WITH RECURSIVE path AS (
      SELECT run_id,parent_run_id,0 AS depth FROM codex_subscription_runs WHERE run_id=target_run_id
      UNION ALL
      SELECT r.run_id,r.parent_run_id,path.depth+1 FROM codex_subscription_runs r
        JOIN path ON r.run_id=path.parent_run_id WHERE path.depth<2
    )
    SELECT r.run_id FROM codex_subscription_runs r JOIN path ON path.run_id=r.run_id
      ORDER BY path.depth DESC FOR UPDATE OF r
  LOOP
    NULL;
  END LOOP;
END;
$$;

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
  IF TG_OP = 'INSERT' THEN
    IF NEW.attempts<>0 OR NEW.accepted_turns<>0 OR NEW.repairs<>0 THEN
      RAISE EXCEPTION 'subscription_invalid';
    END IF;
  ELSE
    attempts_delta := NEW.attempts-OLD.attempts;
    turns_delta := NEW.accepted_turns-OLD.accepted_turns;
    repairs_delta := NEW.repairs-OLD.repairs;
    IF attempts_delta<0 OR turns_delta<0 OR repairs_delta<0 OR
       NEW.attempts>NEW.max_attempts OR NEW.accepted_turns>NEW.max_turns OR
       NEW.accepted_turns>NEW.attempts OR NEW.repairs>NEW.attempts THEN
      RAISE EXCEPTION 'subscription_invalid';
    END IF;
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
  PERFORM gbrain_codex_subscription_lock_path(NEW.parent_run_id);
  SELECT * INTO parent FROM codex_subscription_runs WHERE run_id=NEW.parent_run_id FOR UPDATE;
  IF NOT FOUND OR NEW.run_id=NEW.parent_run_id OR
     EXISTS (SELECT 1 FROM codex_subscription_runs
             WHERE run_id=parent.parent_run_id AND parent_run_id IS NOT NULL) OR
     NEW.account_lane<>parent.account_lane OR NEW.deadline>parent.deadline OR
     NEW.max_attempts>parent.max_attempts OR NEW.max_turns>parent.max_turns THEN
    RAISE EXCEPTION 'subscription_identity_conflict';
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.account_lane<>OLD.account_lane OR NEW.deadline<>OLD.deadline OR
     NEW.max_attempts<>OLD.max_attempts OR NEW.max_turns<>OLD.max_turns THEN
    RAISE EXCEPTION 'subscription_identity_conflict';
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
`;
