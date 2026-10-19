-- The Dashboard refreshed by the routines (D-258; rule 7 of D-248). A routine
-- may have the source `dashboard`: at its time it starts «Aggiorna» of the
-- tiles of the Dashboard, the same refresh as the page (a private hidden
-- conversation erased after, the local model only, Segreto never refreshed,
-- a tile at work skipped), and its report says how many tiles are being
-- refreshed. `dashboard_tiles` is the choice of the user: NULL is every
-- tile of the Dashboard at the time of the run, a list is those tiles only.
-- The list holds ids, never titles; a tile removed from the Dashboard is
-- simply not found (the core reads the list against dashboard_tiles), and
-- the next save of the routine writes the list again without it.
-- See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

ALTER TABLE routines DROP CONSTRAINT routines_sources_check;
ALTER TABLE routines ADD CONSTRAINT routines_sources_check CHECK (
  cardinality(sources) BETWEEN 1 AND 7
  AND sources <@ ARRAY['todo', 'waiting', 'cards', 'done-since', 'failed-since', 'notes', 'dashboard']::text[]
  AND array_position(sources, NULL) IS NULL);

ALTER TABLE routines ADD COLUMN dashboard_tiles uuid[];
-- A choice only with the source, at least one tile, never a NULL inside.
ALTER TABLE routines ADD CONSTRAINT routines_dashboard_tiles CHECK (
  dashboard_tiles IS NULL OR (
    'dashboard' = ANY (sources)
    AND cardinality(dashboard_tiles) BETWEEN 1 AND 200
    AND array_position(dashboard_tiles, NULL) IS NULL));

-- routines_guard of 0079 again, with the choice of tiles among what a routine removed keeps.
CREATE OR REPLACE FUNCTION routines_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  c conversations;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO c FROM conversations WHERE id = NEW.conversation_id;
    IF NOT FOUND OR c.purged_at IS NOT NULL OR c.archived_at IS NOT NULL OR c.mode <> 'private' OR c.clearance <> 'L2'
       OR c.origin <> 'user' OR c.agent IS NOT NULL OR c.incognito OR c.secretary OR c.trial_model IS NOT NULL
       OR c.side_of IS NOT NULL OR c.dashboard_of IS NOT NULL OR c.workspace IS NOT NULL THEN
      RAISE EXCEPTION 'routines: a routine lives in a private conversation of its own, with Arianna'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.conversation_id, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.conversation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'routines %: its conversation never changes', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  -- A routine removed stays as it was; only its title goes, when its conversation is deleted (purge_conversation).
  IF OLD.status = 'retired' AND (NEW.title IS DISTINCT FROM 'Routine cancellata'
     OR (NEW.status, NEW.paused_by, NEW.next_run_at, NEW.days, NEW.at, NEW.timezone, NEW.sources, NEW.summary, NEW.channel, NEW.dashboard_tiles)
        IS DISTINCT FROM (OLD.status, OLD.paused_by, OLD.next_run_at, OLD.days, OLD.at, OLD.timezone, OLD.sources, OLD.summary, OLD.channel, OLD.dashboard_tiles)) THEN
    RAISE EXCEPTION 'routines %: a routine removed stays as it was', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.approved_at IS DISTINCT FROM OLD.approved_at AND OLD.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'routines %: approved once', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- routines_proposal_guard of 0080 again: a proposal stays as the user saw it, the choice of tiles too
-- (routine.propose never chooses tiles: a proposal with the source `dashboard` is every tile, NULL).
CREATE OR REPLACE FUNCTION routines_proposal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'proposed' AND NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'routines: a proposed routine is not approved yet' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'proposed' AND NEW.dashboard_tiles IS NOT NULL THEN
      RAISE EXCEPTION 'routines: a proposed routine never chooses tiles' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status NOT IN ('proposed', 'active') THEN
      RAISE EXCEPTION 'routines: a routine is born proposed or active' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'proposed' AND OLD.status <> 'proposed' THEN
    RAISE EXCEPTION 'routines %: no routine goes back to proposed', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'proposed' AND NEW.status NOT IN ('proposed', 'active', 'retired') THEN
    RAISE EXCEPTION 'routines %: a proposal is approved or discarded', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'proposed' AND NEW.status = 'proposed'
     AND (NEW.title, NEW.days, NEW.at, NEW.timezone, NEW.sources, NEW.summary, NEW.channel, NEW.dashboard_tiles)
         IS DISTINCT FROM (OLD.title, OLD.days, OLD.at, OLD.timezone, OLD.sources, OLD.summary, OLD.channel, OLD.dashboard_tiles) THEN
    RAISE EXCEPTION 'routines %: a proposal stays as the user saw it', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
