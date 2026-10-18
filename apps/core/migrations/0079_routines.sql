-- Routines (D-110, tappa A; D-254): recurring appointments of the user with
-- Arianna. At its days and time, in its own time zone, the core writes in the
-- routine's private conversation a report written by code from SQL and files
-- (todo, waits, done and failed, at work, new thoughts), then, if asked, three
-- lines of the local model without tools. Only the chat in this tappa: the
-- call (tappa B) and the email (tappa C) come with their own migrations.
-- One row per routine, one row per run; nothing is ever deleted (D-046): a
-- routine removed is `retired`. Deleting its conversation (purge_conversation)
-- retires it and replaces its title; «Elimina per sempre» (erase_conversation)
-- takes the routine and its runs with it, by cascade.
-- See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

CREATE TABLE routines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The user's text (Privato, as the conversation that holds it): one line, never in an event.
  title            text NOT NULL CHECK (btrim(title) <> '' AND length(title) <= 80 AND title !~ '[\r\n]'),
  -- The private conversation of the routine, born with it, never changed.
  conversation_id  uuid NOT NULL UNIQUE REFERENCES conversations (id) ON DELETE CASCADE,
  -- ISO days, 1 Monday … 7 Sunday, at least one.
  days             smallint[] NOT NULL CHECK (
                     cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
                     AND array_position(days, NULL) IS NULL),
  -- "HH:MM" in `timezone`.
  at               text NOT NULL CHECK (at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- An IANA name, checked by the core with Intl; the system's when the routine is born.
  timezone         text NOT NULL CHECK (timezone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
  -- A closed list of sources, at least one; the email and the calendar come with tappa C and D.
  sources          text[] NOT NULL CHECK (
                     cardinality(sources) BETWEEN 1 AND 6
                     AND sources <@ ARRAY['todo', 'waiting', 'cards', 'done-since', 'failed-since', 'notes']::text[]
                     AND array_position(sources, NULL) IS NULL),
  -- Three lines of the local model after the report (routine.summary), without tools.
  summary          boolean NOT NULL DEFAULT true,
  -- How the report reaches the user: only in the chat in this tappa (the call is tappa B).
  channel          text NOT NULL DEFAULT 'chat' CHECK (channel IN ('chat')),
  -- proposed (routine.propose, tappa A2), active, paused (by the user or because its conversation was archived), retired.
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('proposed', 'active', 'paused', 'retired')),
  paused_by        text CHECK (paused_by IN ('user', 'archived')),
  -- The next run, only while active.
  next_run_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- When it became active the first time: saved from the page (the user's own action) or approved (A2).
  approved_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT routines_next_when_active CHECK ((status = 'active') = (next_run_at IS NOT NULL)),
  CONSTRAINT routines_paused_by CHECK ((status = 'paused') = (paused_by IS NOT NULL)),
  CONSTRAINT routines_approved_when_running CHECK (status NOT IN ('active', 'paused') OR approved_at IS NOT NULL)
);
CREATE INDEX routines_due_idx ON routines (next_run_at) WHERE status = 'active';

CREATE FUNCTION routines_guard() RETURNS trigger
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
     OR (NEW.status, NEW.paused_by, NEW.next_run_at, NEW.days, NEW.at, NEW.timezone, NEW.sources, NEW.summary, NEW.channel)
        IS DISTINCT FROM (OLD.status, OLD.paused_by, OLD.next_run_at, OLD.days, OLD.at, OLD.timezone, OLD.sources, OLD.summary, OLD.channel)) THEN
    RAISE EXCEPTION 'routines %: a routine removed stays as it was', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.approved_at IS DISTINCT FROM OLD.approved_at AND OLD.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'routines %: approved once', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER routines_guard BEFORE INSERT OR UPDATE ON routines FOR EACH ROW EXECUTE FUNCTION routines_guard();

CREATE TABLE routine_runs (
  id                  bigserial PRIMARY KEY,
  routine_id          uuid NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
  -- The run of the schedule this row is (the time it was due), or the moment of «Prova adesso».
  scheduled_for       timestamptz NOT NULL,
  -- schedule: the ticker; manual: «Prova adesso» from the page (in the chat, never a call).
  trigger             text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  -- done: the report is in the chat; missed-offline: the Mac was off more than two hours past the time,
  -- one line says so; skipped: nothing written (a closed reason); failed: the report could not be written.
  status              text NOT NULL CHECK (status IN ('done', 'missed-offline', 'skipped', 'failed')),
  -- A closed code, never a message: late (written after the Mac was off, within two hours), blocked (the gateway),
  -- error (the report could not be read); archived and purged, like the status skipped, are kept for the next tappe.
  reason              text CHECK (reason IN ('late', 'blocked', 'archived', 'purged', 'error')),
  -- Not foreign keys: purge_conversation deletes the messages, the run stays.
  message_id          bigint,
  summary_message_id  bigint,
  -- none: not asked; queued: routine.summary waits for the local model (at most 20 minutes);
  -- done, unavailable (the model was not ready in time), failed.
  summary_state       text NOT NULL DEFAULT 'none' CHECK (summary_state IN ('none', 'queued', 'done', 'unavailable', 'failed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT routine_runs_done_message CHECK (status <> 'done' OR message_id IS NOT NULL),
  CONSTRAINT routine_runs_summary_message CHECK ((summary_state = 'done') = (summary_message_id IS NOT NULL)),
  CONSTRAINT routine_runs_late_done CHECK (reason IS DISTINCT FROM 'late' OR status = 'done')
);
-- One run per time of the schedule: two cores or a restart never write two reports.
CREATE UNIQUE INDEX routine_runs_once ON routine_runs (routine_id, scheduled_for) WHERE trigger = 'schedule';
CREATE INDEX routine_runs_routine_idx ON routine_runs (routine_id, id DESC);

-- Only the summary changes after the run, once, forward.
CREATE FUNCTION routine_runs_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.id, NEW.routine_id, NEW.scheduled_for, NEW.trigger, NEW.status, NEW.reason, NEW.message_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.routine_id, OLD.scheduled_for, OLD.trigger, OLD.status, OLD.reason, OLD.message_id, OLD.created_at) THEN
    RAISE EXCEPTION 'routine_runs %: a run stays as it was written', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.summary_state IS DISTINCT FROM OLD.summary_state AND OLD.summary_state <> 'queued' THEN
    RAISE EXCEPTION 'routine_runs %: the summary is settled once', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER routine_runs_guard BEFORE UPDATE ON routine_runs FOR EACH ROW EXECUTE FUNCTION routine_runs_guard();

-- The core writes and reads them; it never deletes one (D-046).
GRANT SELECT, INSERT, UPDATE ON routines TO arianna_app;
GRANT SELECT, INSERT, UPDATE ON routine_runs TO arianna_app;
GRANT USAGE ON SEQUENCE routine_runs_id_seq TO arianna_app;
