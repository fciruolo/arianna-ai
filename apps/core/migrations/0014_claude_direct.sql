-- Claude answering directly in a system chat (D-064, second part). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- conversations.model in a system chat: the Claude model that answers it
-- directly (sonnet or opus), or NULL for Arianna on the local model. It stays
-- a work conversation only (conversations_model_only_work, 0009): a private
-- system chat never reaches the cloud. Fable is not offered here: it needs a
-- budget approval at every step.
-- ---------------------------------------------------------------------------

ALTER TABLE conversations ADD CONSTRAINT conversations_system_model CHECK (
  origin <> 'system' OR model IS NULL OR model IN ('sonnet', 'opus')
);

-- ---------------------------------------------------------------------------
-- messages.model: the cloud model that wrote an answer of the task itself
-- (Claude in a system chat), so the chat says who answered. NULL means the
-- local model, as every row before this migration; a report of a delegated
-- step names its agent instead (messages.agent).
-- ---------------------------------------------------------------------------

ALTER TABLE messages ADD COLUMN model text CHECK (model <> '');
ALTER TABLE messages ADD CONSTRAINT messages_model_only_assistant CHECK (model IS NULL OR (role = 'assistant' AND agent IS NULL));

-- A message written by a cloud model only in a work conversation (clearance
-- L1): the database refuses it anywhere else, whatever the core does.
CREATE FUNCTION messages_model_work() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.model IS NOT NULL
     AND NOT EXISTS (SELECT FROM conversations WHERE id = NEW.conversation_id AND mode = 'work' AND clearance = 'L1') THEN
    RAISE EXCEPTION 'message: a cloud model writes only in a work conversation, not in %', NEW.conversation_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER messages_model_work BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_model_work();
