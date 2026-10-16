-- «Rimanda» (D-235): the user sends an agent's card back from Da verificare
-- with a note, and the agent works on it again with its earlier report and the
-- note. One row per time it was sent back; the note is the user's text, with
-- the label the user chose for it (Privato by default, Interno to let the card
-- go back to the cloud). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

CREATE TABLE card_returns (
  id          bigserial PRIMARY KEY,
  task_id     uuid NOT NULL REFERENCES tasks (id),
  -- The last step of the card when it was sent back: the agent reads the note after the turns up to it.
  after_step  integer NOT NULL CHECK (after_step >= 0),
  note        text NOT NULL CHECK (btrim(note) <> '' AND length(note) <= 2000),
  label       privacy_label NOT NULL CHECK (label IN ('L1', 'L2')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_returns_task_idx ON card_returns (task_id, id);

-- Only on cards, and never changed: a note sent back stays as it was sent.
CREATE FUNCTION card_returns_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'card_returns %: a note sent back never changes', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT FROM tasks WHERE id = NEW.task_id AND conversation_id IS NULL) THEN
    RAISE EXCEPTION 'card_returns: only on cards' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER card_returns_guard BEFORE INSERT OR UPDATE ON card_returns FOR EACH ROW EXECUTE FUNCTION card_returns_guard();

-- The core writes and reads them; it never changes or deletes one (D-046).
GRANT SELECT, INSERT ON card_returns TO arianna_app;
GRANT USAGE ON SEQUENCE card_returns_id_seq TO arianna_app;

-- ---------------------------------------------------------------------------
-- The steps of a card at work (D-235): the activity lines of D-083 (0021) for
-- a task without a conversation too, read in the card's detail while it works.
-- A card's line is at least its effective label and within the card's own
-- clearance, as a chat task's is within its conversation's.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION task_activities_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  t tasks;
  c conversations;
  v_clearance privacy_label;
BEGIN
  SELECT * INTO t FROM tasks WHERE id = NEW.task_id;
  IF NOT FOUND THEN
    -- The foreign key reports it with its own message.
    RETURN NEW;
  END IF;
  IF t.conversation_id IS NULL THEN
    v_clearance := t.clearance;
  ELSE
    SELECT * INTO c FROM conversations WHERE id = t.conversation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'task_activities: task % has no conversation', t.id USING ERRCODE = 'check_violation';
    END IF;
    IF c.purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'task_activities: conversation % was deleted', c.id USING ERRCODE = 'check_violation';
    END IF;
    v_clearance := c.clearance;
  END IF;
  IF NEW.label < t.effective_label THEN
    RAISE EXCEPTION 'task_activities: label % is below the effective label % of task %', NEW.label, t.effective_label, t.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.label > v_clearance AND t.conversation_id IS NULL THEN
    RAISE EXCEPTION 'task_activities: label % is above the clearance of card %', NEW.label, t.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.label > v_clearance THEN
    RAISE EXCEPTION 'task_activities: label % is above the clearance of conversation %', NEW.label, c.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- One writer at a time per task, so that the cap holds; no row of tasks is locked.
  -- The cap of 200 is MAX_SAVED_ACTIVITIES in apps/core/src/reply.ts too: change both together.
  PERFORM pg_advisory_xact_lock(hashtext('task_activities:' || t.id::text));
  IF (SELECT count(*) FROM task_activities WHERE task_id = t.id) >= 200 THEN
    RAISE EXCEPTION 'task_activities: task % has 200 lines already', t.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
