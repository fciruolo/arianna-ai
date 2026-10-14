-- «Ferma» and the queue of messages (D-218, idea 4 of OpenWork, D-093). See
-- docs/DATA-MODEL.md. Object names are never schema-qualified.
--
-- A message the user writes while a task of the conversation is still at work
-- waits here, in order, and the core sends it when that task ends: one task
-- at a time per conversation. The user can change or remove it before it
-- leaves. The text carries the label of the conversation, as the message it
-- becomes; only ids go to the events. «Elimina» (erase_conversation, 0043)
-- deletes the conversation row: the queue goes with it by cascade.
CREATE TABLE queued_messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  label           privacy_label NOT NULL,
  body            text NOT NULL CHECK (body <> '' AND length(body) <= 16000),
  -- The style and skills of the Studio (D-184), already checked: NULL skills is a message without them.
  design_style    text,
  design_skills   text[],
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT queued_messages_below_secret CHECK (label <> 'L3'),
  CONSTRAINT queued_messages_design CHECK (design_skills IS NOT NULL OR design_style IS NULL)
);
CREATE INDEX queued_messages_conversation_idx ON queued_messages (conversation_id, id);

-- «Ferma» pauses the queue of its conversation: nothing of it leaves alone
-- until «Riprendi la coda», or the queue empties. arianna_app never deletes:
-- it turns `paused` off.
CREATE TABLE message_queue_pauses (
  conversation_id uuid PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
  paused          boolean NOT NULL DEFAULT true,
  changed_at      timestamptz NOT NULL DEFAULT now()
);

-- A queued message leaves the table only here: sent (the core writes it as
-- the user's message in the same transaction) or removed by the user. The
-- core holds no DELETE on any table (doctor, 0007).
CREATE FUNCTION queued_message_delete(p_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout = '5s' AS $$
BEGIN
  DELETE FROM queued_messages WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'queued message % does not exist', p_id USING ERRCODE = 'no_data_found';
  END IF;
END
$$;

-- The schema of this migration, then pg_temp last, as user_fact_delete (0061).
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION queued_message_delete(bigint) SET search_path = %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON FUNCTION queued_message_delete(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queued_message_delete(bigint) TO arianna_app;

-- The purge of a conversation (incognito closing, 0012, 0031) takes its queue
-- with it: no text of it is left behind. It runs inside the purge functions,
-- as their owner.
CREATE FUNCTION message_queue_purge() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  DELETE FROM queued_messages WHERE conversation_id = NEW.id;
  DELETE FROM message_queue_pauses WHERE conversation_id = NEW.id;
  RETURN NULL;
END
$$;
CREATE TRIGGER message_queue_purge AFTER UPDATE OF purged_at ON conversations
  FOR EACH ROW WHEN (OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL)
  EXECUTE FUNCTION message_queue_purge();

-- No queued message for a purged conversation.
CREATE FUNCTION queued_messages_live() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (SELECT FROM conversations WHERE id = NEW.conversation_id AND purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'conversation %: purged, nothing is queued in it', NEW.conversation_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER queued_messages_live BEFORE INSERT OR UPDATE ON queued_messages
  FOR EACH ROW EXECUTE FUNCTION queued_messages_live();

GRANT SELECT, INSERT, UPDATE ON queued_messages, message_queue_pauses TO arianna_app;
GRANT USAGE ON SEQUENCE queued_messages_id_seq TO arianna_app;
