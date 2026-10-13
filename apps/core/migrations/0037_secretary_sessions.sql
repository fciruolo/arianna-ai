-- Sessions of the secretary (I-12, D-146): the conversation of the "Segretaria"
-- button stays one, but each click on the button opens a new session. The
-- local model reads only the messages of the current session (from this
-- moment on), and no summary of the older ones (D-077 does not apply).
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- conversations.secretary_session_at: when the user last clicked the button,
-- written by the core on POST /api/secretary. Only on the secretary's
-- conversation; null there until the first click after this migration (the
-- model then reads the whole conversation, still without summaries).
-- ---------------------------------------------------------------------------

ALTER TABLE conversations ADD COLUMN secretary_session_at timestamptz;
ALTER TABLE conversations ADD CONSTRAINT conversations_secretary_session
  CHECK (secretary OR secretary_session_at IS NULL);

-- Only forward: a session never goes back, nor is it cleared.
CREATE FUNCTION conversations_secretary_session_forward() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD.secretary_session_at IS NOT NULL
     AND (NEW.secretary_session_at IS NULL OR NEW.secretary_session_at < OLD.secretary_session_at) THEN
    RAISE EXCEPTION 'conversation %: a session of the secretary only goes forward', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER conversations_secretary_session_forward BEFORE UPDATE OF secretary_session_at ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_secretary_session_forward();

-- ---------------------------------------------------------------------------
-- Each click is also an event `secretary.session` (L0, payload the
-- conversation id), with the same time as the column. A task reads from the
-- session in force when it began (the last click before its creation): a
-- click while it waits for a confirmation changes nothing of what it reads.
-- ---------------------------------------------------------------------------

CREATE INDEX events_secretary_session_idx ON events (ts) WHERE kind = 'secretary.session';

-- No new grant: arianna_app updates conversations at table level since 0007,
-- and appends events since then.
