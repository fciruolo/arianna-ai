-- Incognito conversations (D-136, I-4 tappa 1): a conversation like the
-- others, whose texts are deleted when it closes. See docs/DATA-MODEL.md and
-- docs/I-4-incognito.md. Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- conversations.incognito: chosen at creation, never changed (conversations_guard).
-- An incognito conversation is one the user opened (never a system chat),
-- answered by Arianna (no direct chat: its agent keeps a session to resume),
-- never titled (the chat shows "Incognito"), never archived nor pinned: it
-- never shows in the list nor in the archive. purge_incognito purges it
-- without archiving it, so a purged incognito stays unarchived.
-- ---------------------------------------------------------------------------

ALTER TABLE conversations ADD COLUMN incognito boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD CONSTRAINT conversations_incognito_fields
  CHECK (NOT incognito OR (origin = 'user' AND agent IS NULL AND title IS NULL AND archived_at IS NULL AND pinned_at IS NULL));
ALTER TABLE conversations DROP CONSTRAINT conversations_purged_archived_untitled;
ALTER TABLE conversations ADD CONSTRAINT conversations_purged_archived_untitled
  CHECK (purged_at IS NULL OR ((archived_at IS NOT NULL OR incognito) AND title IS NULL));

CREATE INDEX conversations_incognito_open_idx ON conversations (id) WHERE incognito AND purged_at IS NULL;

-- As in 0013, with incognito frozen like the mode.
CREATE OR REPLACE FUNCTION conversations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- The purge: title gone, purged_at set, nothing else.
  IF purge_target(TG_RELID) = OLD.id AND OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL AND NEW.title IS NULL
     AND (NEW.id, NEW.mode, NEW.clearance, NEW.effective_label, NEW.workspace, NEW.model, NEW.archived_at, NEW.created_at,
          NEW.origin, NEW.system_reason, NEW.source_task_id, NEW.question_attached, NEW.source_error_id, NEW.incognito)
         IS NOT DISTINCT FROM (OLD.id, OLD.mode, OLD.clearance, OLD.effective_label, OLD.workspace, OLD.model, OLD.archived_at, OLD.created_at,
          OLD.origin, OLD.system_reason, OLD.source_task_id, OLD.question_attached, OLD.source_error_id, OLD.incognito) THEN
    RETURN NEW;
  END IF;
  IF OLD.purged_at IS NOT NULL OR NEW.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'conversation %: only purge_conversation purges, and a purged conversation never changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.incognito IS DISTINCT FROM OLD.incognito THEN
    RAISE EXCEPTION 'conversation %: incognito is chosen at creation and never changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.mode, NEW.clearance, NEW.workspace, NEW.created_at, NEW.origin, NEW.system_reason, NEW.source_task_id)
     IS DISTINCT FROM (OLD.id, OLD.mode, OLD.clearance, OLD.workspace, OLD.created_at, OLD.origin, OLD.system_reason, OLD.source_task_id) THEN
    RAISE EXCEPTION 'conversation %: only the effective label, title, model and archive can change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.question_attached AND NOT NEW.question_attached THEN
    RAISE EXCEPTION 'conversation %: an attached question stays attached', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.source_error_id IS NOT NULL AND (NEW.source_error_id IS NULL OR NEW.source_error_id < OLD.source_error_id) THEN
    RAISE EXCEPTION 'conversation %: the error it told only moves to a newer one', OLD.id
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

-- A system chat about a task of an incognito conversation would hold its
-- texts outside it (the question, the error): it is never opened.
CREATE FUNCTION conversations_incognito_source() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.origin = 'system' AND EXISTS (
    SELECT FROM tasks t JOIN conversations c ON c.id = t.conversation_id
    WHERE t.id = NEW.source_task_id AND c.incognito
  ) THEN
    RAISE EXCEPTION 'system chat: task % belongs to an incognito conversation', NEW.source_task_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversations_incognito_source BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_incognito_source();

-- ---------------------------------------------------------------------------
-- Telegram passes through its servers and keeps what it gets: the bot is
-- never bound to an incognito conversation. The binding never changes
-- (telegram_state_guard), so checking the insert is enough.
-- ---------------------------------------------------------------------------

CREATE FUNCTION telegram_state_not_incognito() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (SELECT FROM conversations WHERE id = NEW.conversation_id AND incognito) THEN
    RAISE EXCEPTION 'telegram_state: the bot is never bound to an incognito conversation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER telegram_state_not_incognito BEFORE INSERT ON telegram_state
  FOR EACH ROW EXECUTE FUNCTION telegram_state_not_incognito();

-- ---------------------------------------------------------------------------
-- The tasks of an incognito conversation have a fixed title from birth: the
-- start of the user's message never reaches the disk as a title.
-- ---------------------------------------------------------------------------

CREATE FUNCTION tasks_incognito_title() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.conversation_id IS NOT NULL AND NEW.title IS DISTINCT FROM 'Incognito'
     AND EXISTS (SELECT FROM conversations WHERE id = NEW.conversation_id AND incognito) THEN
    RAISE EXCEPTION 'task %: a task of an incognito conversation is titled Incognito', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tasks_incognito_title BEFORE INSERT OR UPDATE OF title, conversation_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_incognito_title();

-- ---------------------------------------------------------------------------
-- purge_incognito: purge_conversation (0026) for an incognito conversation,
-- which is never archived. The core first stops its work (jobs failed, runs
-- ended); a task or run still at work refuses the purge. In more it empties
-- the session and the folder of its runs (the sessions of an incognito are
-- not kept, D-136), and counts what it deleted for the closing card.
-- ---------------------------------------------------------------------------

CREATE FUNCTION purge_incognito(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout = '5s' AS $$
DECLARE
  c conversations;
  v_tasks uuid[];
  v_failed jsonb;
  v_expired jsonb;
  v_messages bigint;
  v_summaries bigint;
BEGIN
  SELECT * INTO c FROM conversations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR c.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'conversation % does not exist', p_id USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT c.incognito THEN
    RAISE EXCEPTION 'conversation %: only an incognito conversation is purged without the archive', p_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT coalesce(array_agg(id), '{}') INTO v_tasks
  FROM (SELECT id FROM tasks WHERE conversation_id = p_id ORDER BY id FOR UPDATE) locked;
  IF EXISTS (SELECT FROM tasks WHERE id = ANY (v_tasks) AND status IN ('ready', 'running'))
     OR EXISTS (SELECT FROM runs WHERE task_id = ANY (v_tasks) AND status = 'running')
     OR EXISTS (SELECT FROM jobs WHERE status IN ('queued', 'running')
                AND key = ANY (SELECT 'task:' || t FROM unnest(v_tasks) t)) THEN
    RAISE EXCEPTION 'conversation %: a task is still at work', p_id USING ERRCODE = 'object_in_use';
  END IF;

  PERFORM set_config('arianna.purge', p_id::text, true);

  WITH closed AS (
    UPDATE tasks t SET status = 'failed', waiting_reason = NULL, waiting_approval_id = NULL, updated_at = now()
    FROM (SELECT id, status FROM tasks WHERE id = ANY (v_tasks) AND status NOT IN ('done', 'failed')) old
    WHERE t.id = old.id
    RETURNING t.id, old.status
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('taskId', id, 'from', status) ORDER BY id), '[]')
  INTO v_failed FROM closed;
  WITH expired AS (
    UPDATE approvals SET state = 'expired', decided_at = now()
    WHERE task_id = ANY (v_tasks) AND state = 'pending'
    RETURNING id, task_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('approvalId', id, 'taskId', task_id) ORDER BY id), '[]')
  INTO v_expired FROM expired;
  UPDATE approvals
  SET detail = CASE WHEN kind = 'declassify'
    THEN jsonb_build_object('text', '', 'sha256', encode(sha256(''::bytea), 'hex'),
                            'from', detail -> 'from', 'to', detail -> 'to', 'purged', true)
    ELSE jsonb_build_object('purged', true) END
  WHERE task_id = ANY (v_tasks);

  DELETE FROM conversation_summaries WHERE conversation_id = p_id;
  GET DIAGNOSTICS v_summaries = ROW_COUNT;
  DELETE FROM conversation_participants WHERE conversation_id = p_id;
  DELETE FROM task_delegations WHERE task_id = ANY (v_tasks);
  DELETE FROM task_turns WHERE task_id = ANY (v_tasks);
  DELETE FROM task_activities WHERE task_id = ANY (v_tasks);
  DELETE FROM messages WHERE conversation_id = p_id;
  GET DIAGNOSTICS v_messages = ROW_COUNT;

  UPDATE tasks SET title = 'Incognito', goal = NULL, done_criteria = NULL, updated_at = now()
  WHERE id = ANY (v_tasks);
  UPDATE runs SET session_ref = NULL, workspace = NULL
  WHERE task_id = ANY (v_tasks) AND (session_ref IS NOT NULL OR workspace IS NOT NULL);
  UPDATE jobs SET last_error = NULL
  WHERE key = ANY (SELECT 'task:' || t FROM unnest(v_tasks) t) AND last_error IS NOT NULL;
  UPDATE conversations SET purged_at = now() WHERE id = p_id;

  PERFORM set_config('arianna.purge', '', true);
  RETURN jsonb_build_object('tasks', cardinality(v_tasks), 'messages', v_messages, 'summaries', v_summaries,
                            'failed', v_failed, 'expired', v_expired);
END
$$;

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION purge_incognito(uuid) SET search_path = %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON FUNCTION purge_incognito(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_incognito(uuid) TO arianna_app;
