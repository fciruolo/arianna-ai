-- «Nuova sessione» of a direct chat with an agent (I-20, D-185): the user
-- keeps the whole conversation in view, but the agent reads only what comes
-- after the line, plus a short summary written by the code of what came
-- before, as the sessions of the secretary (D-146). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.
--
-- direct_session_at: where the session in force begins; only on a
-- conversation with an agent, and only forward. direct_session_open: the
-- mockup open in the Studio when the session began, for the summary (a
-- relative .html path, no `..`).

ALTER TABLE conversations ADD COLUMN direct_session_at timestamptz;
ALTER TABLE conversations ADD COLUMN direct_session_open text;
ALTER TABLE conversations ADD CONSTRAINT conversations_direct_session
  CHECK (agent IS NOT NULL OR (direct_session_at IS NULL AND direct_session_open IS NULL));
ALTER TABLE conversations ADD CONSTRAINT conversations_direct_session_open
  CHECK (direct_session_open IS NULL OR (length(direct_session_open) <= 300 AND direct_session_open ~ '^[A-Za-z0-9._ /-]+\.html$' AND direct_session_open !~ '(^|/)\.\.?(/|$)'));

CREATE FUNCTION conversations_direct_session_forward() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD.direct_session_at IS NOT NULL
     AND (NEW.direct_session_at IS NULL OR NEW.direct_session_at < OLD.direct_session_at) THEN
    RAISE EXCEPTION 'conversation %: a session of a direct chat only goes forward', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER conversations_direct_session_forward BEFORE UPDATE OF direct_session_at ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_direct_session_forward();
