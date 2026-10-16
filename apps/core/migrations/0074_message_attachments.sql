-- Images and files attached in the chat (D-247, idea 9 of OpenWork). See
-- docs/DATA-MODEL.md. Object names are never schema-qualified.
--
-- The bytes live in data/attachments/<id>.<ext>, out of git; a row here says
-- what the file is and, once read, what the local model may read of it
-- (`reading`): the text of a text file, the reading the model of the `vision`
-- role wrote of an image. Every attachment is Privato (L2), whatever it holds:
-- it goes only into a private conversation, whose messages are L2, and never
-- leaves the Mac. The name and the reading are the user's data; events carry
-- ids only.
--
-- An attachment is born pending (no message, no conversation) when the user
-- pastes or drops it, and is bound to the user message that carries it when
-- that leaves: then it never moves again. «Elimina» (erase_conversation,
-- 0043) deletes the messages and the conversation: their attachments go with
-- them by cascade, and the core removes the files without a row.
CREATE TABLE message_attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations (id) ON DELETE CASCADE,
  message_id      bigint REFERENCES messages (id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('image', 'text')),
  media_type      text NOT NULL,
  name            text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200 AND strpos(name, '/') = 0),
  size_bytes      integer NOT NULL CHECK (size_bytes > 0),
  sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Always L2 (D-247): the check keeps it so, whatever a caller writes.
  label           privacy_label NOT NULL DEFAULT 'L2' CHECK (label = 'L2'),
  -- `pending`: an image the vision model has not read yet; `done`: `reading` holds what it read
  -- (or the text of a text file, from birth); `failed`: the model could not read it.
  read_state      text NOT NULL CHECK (read_state IN ('pending', 'done', 'failed')),
  reading         text CHECK (reading IS NULL OR length(reading) <= 262144),
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_attachments_bound CHECK ((message_id IS NULL) = (conversation_id IS NULL)),
  -- Closed types: PNG, JPEG, WebP and GIF images up to 10 MB (never SVG, which can carry a
  -- script); plain text, Markdown, CSV and JSON up to 256 KiB.
  CONSTRAINT message_attachments_type CHECK (
    (kind = 'image' AND media_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif') AND size_bytes <= 10485760)
    OR (kind = 'text' AND media_type IN ('text/plain', 'text/markdown', 'text/csv', 'application/json') AND size_bytes <= 262144)),
  -- A text file is read at birth; an image waits for the model, and only it has a failed reading.
  CONSTRAINT message_attachments_reading CHECK (
    (read_state = 'done') = (reading IS NOT NULL)
    AND (kind = 'image' OR read_state = 'done'))
);
CREATE INDEX message_attachments_message_idx ON message_attachments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX message_attachments_pending_idx ON message_attachments (created_at) WHERE message_id IS NULL;

-- Bound once, to a user message of a private conversation that is not
-- incognito, the same conversation as the message's; after that only the
-- reading changes (pending to done or failed, once). What a file is never
-- changes.
CREATE FUNCTION message_attachments_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  m messages;
  c conversations;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.message_id IS NOT NULL THEN
      RAISE EXCEPTION 'message_attachments: an attachment is born pending' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.kind, NEW.media_type, NEW.name, NEW.size_bytes, NEW.sha256, NEW.label, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.kind, OLD.media_type, OLD.name, OLD.size_bytes, OLD.sha256, OLD.label, OLD.created_at) THEN
    RAISE EXCEPTION 'message_attachments %: what a file is never changes', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.message_id IS NOT NULL AND (NEW.message_id, NEW.conversation_id) IS DISTINCT FROM (OLD.message_id, OLD.conversation_id) THEN
    RAISE EXCEPTION 'message_attachments %: bound to its message for good', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.message_id IS NULL AND NEW.message_id IS NOT NULL THEN
    SELECT * INTO m FROM messages WHERE id = NEW.message_id;
    IF NOT FOUND OR m.role <> 'user' OR m.conversation_id <> NEW.conversation_id THEN
      RAISE EXCEPTION 'message_attachments %: only on a user message of its conversation', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO c FROM conversations WHERE id = NEW.conversation_id;
    IF c.mode <> 'private' OR c.clearance <> 'L2' OR c.incognito OR c.purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'message_attachments %: only in a private conversation, never incognito', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.read_state <> 'pending' AND (NEW.read_state, NEW.reading) IS DISTINCT FROM (OLD.read_state, OLD.reading) THEN
    RAISE EXCEPTION 'message_attachments %: read once', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER message_attachments_guard BEFORE INSERT OR UPDATE ON message_attachments
  FOR EACH ROW EXECUTE FUNCTION message_attachments_guard();

-- The purge of a conversation (purge_conversation, 0012 and after) takes its
-- attachments with it, as it takes the queue (0066): no text of them is left.
CREATE FUNCTION message_attachments_purge() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  DELETE FROM message_attachments WHERE conversation_id = NEW.id;
  RETURN NULL;
END
$$;
CREATE TRIGGER message_attachments_purge AFTER UPDATE OF purged_at ON conversations
  FOR EACH ROW WHEN (OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL)
  EXECUTE FUNCTION message_attachments_purge();

-- A pending attachment leaves the table only here: removed by the user from
-- the field («×»), or left behind for a day (the core prunes them at start).
-- One bound to a message goes only with its message or conversation. The
-- core holds no DELETE on any table (doctor, 0007).
CREATE FUNCTION message_attachment_discard(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout = '5s' AS $$
BEGIN
  DELETE FROM message_attachments WHERE id = p_id AND message_id IS NULL;
  RETURN FOUND;
END
$$;

CREATE FUNCTION message_attachments_prune(p_before timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout = '5s' AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM message_attachments WHERE message_id IS NULL AND created_at < p_before;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- The schema of this migration, then pg_temp last, as queued_message_delete (0066).
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION message_attachment_discard(uuid) SET search_path = %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION message_attachments_prune(timestamptz) SET search_path = %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON FUNCTION message_attachment_discard(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION message_attachments_prune(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION message_attachment_discard(uuid) TO arianna_app;
GRANT EXECUTE ON FUNCTION message_attachments_prune(timestamptz) TO arianna_app;

GRANT SELECT, INSERT, UPDATE ON message_attachments TO arianna_app;
