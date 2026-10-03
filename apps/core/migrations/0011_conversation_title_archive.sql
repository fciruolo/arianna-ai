-- Conversations as in the chat apps the user knows (D-057): a title, taken
-- from the first message and renamable, and an archive that takes a
-- conversation out of the list without deleting anything. See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- conversations.title: one line. Written from the first user message, or by
-- the user. It carries the clearance of the conversation (L2 in a private
-- one): it is shown only by the web chat and never goes in an event payload.
-- conversations.archived_at: when the user archived it; NULL while it is in
-- the list. Its messages stay (append-only, D-046).
-- ---------------------------------------------------------------------------

ALTER TABLE conversations ADD COLUMN title text
  CHECK (title <> '' AND char_length(title) <= 200 AND title !~ '[\r\n]');
ALTER TABLE conversations ADD COLUMN archived_at timestamptz;

CREATE INDEX conversations_archived_idx ON conversations (archived_at) WHERE archived_at IS NOT NULL;

-- Title, archive and model change; the rest stays as written. The conversation
-- of the Telegram channel stays in the list: the bot writes there.
CREATE OR REPLACE FUNCTION conversations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.id, NEW.mode, NEW.clearance, NEW.workspace, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.mode, OLD.clearance, OLD.workspace, OLD.created_at) THEN
    RAISE EXCEPTION 'conversation %: only the effective label, title, model and archive can change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.effective_label < OLD.effective_label THEN
    RAISE EXCEPTION 'conversation %: the effective label cannot go down', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.title IS NULL AND OLD.title IS NOT NULL THEN
    RAISE EXCEPTION 'conversation %: a title is changed, never removed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL
     AND EXISTS (SELECT FROM telegram_state WHERE conversation_id = OLD.id) THEN
    RAISE EXCEPTION 'conversation %: the conversation of Telegram cannot be archived', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- An archived conversation takes no new user message: the user restores it
-- first. Replies of tasks already running are still written.
CREATE FUNCTION messages_not_archived() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.role = 'user' AND EXISTS (SELECT FROM conversations WHERE id = NEW.conversation_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'message: conversation % is archived', NEW.conversation_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER messages_not_archived BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_not_archived();

-- Conversations written before this migration take the title of their first
-- user message, as a new one would: taskTitle in apps/core/src/conversations.ts
-- (trim as JavaScript does, first line, 80 characters with an ellipsis, then
-- runs of white space as one space). The class below is JavaScript's \s.
WITH first AS (
  SELECT DISTINCT ON (conversation_id) conversation_id, body FROM messages WHERE role = 'user' ORDER BY conversation_id, id
), line AS (
  SELECT conversation_id,
    regexp_replace(
      split_part(regexp_replace(body, '^[\s   -     　﻿]+', ''), E'\n', 1),
      '^[\s   -     　﻿]+|[\s   -     　﻿]+$', '', 'g'
    ) AS text
  FROM first
)
UPDATE conversations c
SET title = NULLIF(regexp_replace(
  CASE WHEN char_length(l.text) <= 80 THEN l.text ELSE left(l.text, 79) || '…' END,
  '[\s   -     　﻿]+', ' ', 'g'), '')
FROM line l
WHERE l.conversation_id = c.id AND c.title IS NULL;
