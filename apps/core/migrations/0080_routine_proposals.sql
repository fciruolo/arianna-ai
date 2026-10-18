-- Routines proposed in the chat (D-110, tappa A2; D-256): the orchestrator's
-- tool `routine.propose` writes a routine `proposed` (off, next_run_at NULL,
-- never approved) and an approval of kind `routine` that the user decides in
-- the web chat, or from the page «Routine»: «Attiva» makes it active (with
-- approved_at and its next run), «Scarta» retires it. The approval holds the
-- routine's id and what the card shows (title, days, time, zone, sources):
-- the title is the user's text, at the label of the approval (L2 at least).
-- See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('action', 'declassify', 'budget', 'setting', 'workspace', 'commitment', 'plan', 'executor', 'im', 'fact', 'routine'));
-- The purge of the asking conversation (purge_conversation) leaves only {"purged": true}.
ALTER TABLE approvals ADD CONSTRAINT approvals_routine_fields
  CHECK (kind <> 'routine' OR (
    action = 'routine.propose' AND label >= 'L2' AND task_id IS NOT NULL AND (
      coalesce(detail -> 'purged' = 'true'::jsonb, false)
      OR (coalesce(jsonb_typeof(detail -> 'routineId') = 'string', false) AND coalesce(jsonb_typeof(detail -> 'title') = 'string', false))
    )
  ));
ALTER TABLE approvals ADD CONSTRAINT approvals_routine_via_web
  CHECK (kind <> 'routine' OR decided_via IS NULL OR decided_via = 'web');

-- A proposal is born proposed and never approved; it leaves that state only
-- to become active (approved) or retired (discarded), and no routine goes back
-- to it. A routine of the page is born active, as before.
CREATE FUNCTION routines_proposal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'proposed' AND NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'routines: a proposed routine is not approved yet' USING ERRCODE = 'check_violation';
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
     AND (NEW.title, NEW.days, NEW.at, NEW.timezone, NEW.sources, NEW.summary, NEW.channel)
         IS DISTINCT FROM (OLD.title, OLD.days, OLD.at, OLD.timezone, OLD.sources, OLD.summary, OLD.channel) THEN
    RAISE EXCEPTION 'routines %: a proposal stays as the user saw it', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER routines_proposal_guard BEFORE INSERT OR UPDATE ON routines FOR EACH ROW EXECUTE FUNCTION routines_proposal_guard();
