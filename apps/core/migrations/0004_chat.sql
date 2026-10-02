-- Task 1.11: conversations, messages, the conversation of a task and live
-- notifications of events. See docs/DATA-MODEL.md and D-039.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- conversations: work (L1, may use the cloud) or private (L2, stays local).
-- The mode and its clearance never change; the effective label only rises.
-- ---------------------------------------------------------------------------

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode            text NOT NULL DEFAULT 'private' CHECK (mode IN ('work', 'private')),
  clearance       privacy_label NOT NULL DEFAULT 'L2',
  -- Highest label written in the conversation so far; only ever goes up.
  effective_label privacy_label NOT NULL DEFAULT 'L0',
  -- Repository of a work conversation, relative to ARIANNA_HOME (allowlist: task 1.6).
  workspace       text CHECK (workspace <> ''),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_clearance_follows_mode
    CHECK ((mode = 'work' AND clearance = 'L1') OR (mode = 'private' AND clearance = 'L2')),
  CONSTRAINT conversations_effective_within_clearance CHECK (effective_label <= clearance),
  CONSTRAINT conversations_workspace_only_work CHECK (workspace IS NULL OR mode = 'work')
);

CREATE INDEX conversations_created_idx ON conversations (created_at);

CREATE FUNCTION conversations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.mode, NEW.clearance, NEW.workspace, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.mode, OLD.clearance, OLD.workspace, OLD.created_at) THEN
    RAISE EXCEPTION 'conversation %: only the effective label can change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.effective_label < OLD.effective_label THEN
    RAISE EXCEPTION 'conversation %: the effective label cannot go down', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversations_guard BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_guard();

CREATE TRIGGER conversations_append_only BEFORE DELETE OR TRUNCATE ON conversations
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- ---------------------------------------------------------------------------
-- tasks: the conversation a task answers in. A task never reads above it.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN conversation_id uuid REFERENCES conversations (id);
CREATE INDEX tasks_conversation_idx ON tasks (conversation_id) WHERE conversation_id IS NOT NULL;

CREATE FUNCTION tasks_within_conversation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  v_clearance privacy_label;
BEGIN
  IF NEW.conversation_id IS NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.conversation_id IS NOT NULL THEN
      RAISE EXCEPTION 'task %: the conversation cannot change', NEW.id USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
    RAISE EXCEPTION 'task %: the conversation cannot change', NEW.id USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT clearance INTO v_clearance FROM conversations WHERE id = NEW.conversation_id;
  IF NEW.clearance > v_clearance THEN
    RAISE EXCEPTION 'task %: clearance % is above the clearance % of its conversation',
      NEW.id, NEW.clearance, v_clearance USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tasks_within_conversation BEFORE INSERT OR UPDATE OF conversation_id, clearance ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_within_conversation();

-- ---------------------------------------------------------------------------
-- messages: the history shared by the web chat and, later, Telegram.
-- Append-only. A message never exceeds the clearance of its conversation and
-- raises the conversation's effective label.
-- ---------------------------------------------------------------------------

CREATE TABLE messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations (id),
  ts              timestamptz NOT NULL DEFAULT now(),
  role            text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  channel         text NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'telegram', 'voice')),
  label           privacy_label NOT NULL DEFAULT 'L2',
  body            text NOT NULL CHECK (body <> ''),
  -- The task a user message started, or the task that wrote an assistant message.
  task_id         uuid REFERENCES tasks (id),
  -- No model reads L3, so no conversation holds it.
  CONSTRAINT messages_below_secret CHECK (label <> 'L3')
);

CREATE INDEX messages_conversation_idx ON messages (conversation_id, id);

CREATE FUNCTION messages_within_conversation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  c conversations;
  v_task_conversation uuid;
BEGIN
  SELECT * INTO c FROM conversations WHERE id = NEW.conversation_id FOR UPDATE;
  IF NOT FOUND THEN
    -- The foreign key reports it with its own message.
    RETURN NEW;
  END IF;
  IF NEW.label > c.clearance THEN
    RAISE EXCEPTION 'message: label % is above the clearance % of conversation %',
      NEW.label, c.clearance, c.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.task_id IS NOT NULL THEN
    SELECT conversation_id INTO v_task_conversation FROM tasks WHERE id = NEW.task_id;
    IF v_task_conversation IS DISTINCT FROM NEW.conversation_id THEN
      RAISE EXCEPTION 'message: task % does not belong to conversation %', NEW.task_id, c.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.label > c.effective_label THEN
    UPDATE conversations SET effective_label = NEW.label WHERE id = c.id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER messages_within_conversation BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_within_conversation();

-- The task a user message starts is created first, in the same transaction.
CREATE TRIGGER messages_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON messages
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- ---------------------------------------------------------------------------
-- events: every new event is announced with its id, delivered at commit.
-- The channel carries the schema, so that tests in separate schemas do not
-- hear each other. Listeners read the event itself from the table.
-- ---------------------------------------------------------------------------

CREATE FUNCTION events_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('arianna_events:' || current_schema(), NEW.id::text);
  RETURN NULL;
END
$$;

CREATE TRIGGER events_notify AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION events_notify();
