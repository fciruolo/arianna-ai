-- Who answers in a conversation (D-111, tappa A): NULL is Arianna, as every
-- conversation before this one; 'coder' is the direct chat with the Coder,
-- without Arianna in between. See docs/DATA-MODEL.md. Object names are never
-- schema-qualified.
--
-- A direct chat sends every message as it is to Claude: only a work
-- conversation (L1) the user opened, on a project, can have it. It is chosen
-- when the conversation is created and never changes: switching in the middle
-- would send to the cloud a history written for Arianna on the local model.
-- conversations_guard freezes the other columns; this trigger freezes agent.

ALTER TABLE conversations ADD COLUMN agent text;
ALTER TABLE conversations ADD CONSTRAINT conversations_agent_known
  CHECK (agent IS NULL OR agent = 'coder');
ALTER TABLE conversations ADD CONSTRAINT conversations_agent_work_project
  CHECK (agent IS NULL OR (mode = 'work' AND origin = 'user' AND workspace IS NOT NULL));

CREATE FUNCTION conversations_agent_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.agent IS DISTINCT FROM OLD.agent THEN
    RAISE EXCEPTION 'conversation %: who answers is chosen at creation and never changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversations_agent_fixed BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_agent_fixed();
