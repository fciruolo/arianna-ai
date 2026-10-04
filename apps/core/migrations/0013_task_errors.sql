-- Readable errors and system chats (D-064, first part). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- task_errors: why a task failed, without text. Origin, a stable code and
-- technical details that are scalar values from a closed list per code
-- (apps/core/src/failures.ts): endpoint ids, ports, HTTP statuses, attempts,
-- never a message or an output, which could quote the task. The row carries
-- the label of what the task had read. Append-only: a task that fails again
-- after a retry gets a new row, the latest one is the current error.
-- ---------------------------------------------------------------------------

-- An object whose values are strings of at most 100 characters, numbers or booleans.
CREATE FUNCTION scalar_details(p_details jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_typeof(p_details) = 'object'
    AND (SELECT count(*) FROM jsonb_each(p_details)) <= 12
    AND NOT EXISTS (
      SELECT FROM jsonb_each(p_details) d
      WHERE char_length(d.key) > 40
         OR jsonb_typeof(d.value) NOT IN ('string', 'number', 'boolean')
         OR (jsonb_typeof(d.value) = 'string' AND char_length(d.value #>> '{}') > 100)
    )
$$;

CREATE TABLE task_errors (
  id       bigserial PRIMARY KEY,
  task_id  uuid NOT NULL REFERENCES tasks (id),
  ts       timestamptz NOT NULL DEFAULT now(),
  origin   text NOT NULL CHECK (origin IN ('local-model', 'claude', 'tool', 'engine')),
  -- `origin.kind`, e.g. local-model.unavailable: the page explains it from its catalog.
  code     text NOT NULL CHECK (code ~ '^[a-z][a-z-]*\.[a-z][a-z0-9-]{0,60}$'),
  details  jsonb NOT NULL DEFAULT '{}' CHECK (scalar_details(details)),
  label    privacy_label NOT NULL DEFAULT 'L2',
  CONSTRAINT task_errors_code_in_origin CHECK (split_part(code, '.', 1) = origin)
);

CREATE INDEX task_errors_task_idx ON task_errors (task_id, id);

CREATE TRIGGER task_errors_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON task_errors
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- Append-only for the application role (D-046).
GRANT SELECT, INSERT ON task_errors TO arianna_app;
GRANT USAGE ON SEQUENCE task_errors_id_seq TO arianna_app;

-- ---------------------------------------------------------------------------
-- System chats: conversations the system opens, not the user. `origin` is
-- 'system', `system_reason` why ('failure': a failed task), `source_task_id`
-- the task it is about. Mode and clearance come from the conversation of that
-- task, so the privacy constraints do not change. One open system chat per
-- task: opening it again resumes it. `question_attached` turns true once,
-- when the user attaches the question of the failed task.
-- ---------------------------------------------------------------------------

ALTER TABLE conversations ADD COLUMN origin text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'system'));
ALTER TABLE conversations ADD COLUMN system_reason text CHECK (system_reason IN ('failure'));
ALTER TABLE conversations ADD COLUMN source_task_id uuid REFERENCES tasks (id);
ALTER TABLE conversations ADD COLUMN question_attached boolean NOT NULL DEFAULT false;
-- The latest error of the source task the chat has told: a newer one is told when the chat is opened again.
ALTER TABLE conversations ADD COLUMN source_error_id bigint REFERENCES task_errors (id);
ALTER TABLE conversations ADD CONSTRAINT conversations_system_fields CHECK (
  (origin = 'user' AND system_reason IS NULL AND source_task_id IS NULL AND NOT question_attached AND source_error_id IS NULL)
  OR (origin = 'system' AND system_reason IS NOT NULL AND source_task_id IS NOT NULL)
);

CREATE UNIQUE INDEX conversations_one_system_chat ON conversations (source_task_id, system_reason)
  WHERE origin = 'system' AND purged_at IS NULL;

-- Its mode follows the conversation of the source task; a task without one is private (default-deny).
CREATE FUNCTION conversations_system_mode() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  v_mode text;
BEGIN
  IF NEW.origin <> 'system' THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(c.mode, 'private') INTO v_mode
  FROM tasks t LEFT JOIN conversations c ON c.id = t.conversation_id
  WHERE t.id = NEW.source_task_id;
  IF v_mode IS NULL THEN
    -- The foreign key reports it with its own message.
    RETURN NEW;
  END IF;
  IF NEW.mode IS DISTINCT FROM v_mode THEN
    RAISE EXCEPTION 'system chat: mode % differs from the mode % of the conversation of task %', NEW.mode, v_mode, NEW.source_task_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.workspace IS NOT NULL THEN
    RAISE EXCEPTION 'system chat: it has no project' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversations_system_mode BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_system_mode();

-- As in 0012, with the system fields frozen, except question_attached that
-- only goes from false to true.
CREATE OR REPLACE FUNCTION conversations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- The purge: title gone, purged_at set, nothing else.
  IF purge_target(TG_RELID) = OLD.id AND OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL AND NEW.title IS NULL
     AND (NEW.id, NEW.mode, NEW.clearance, NEW.effective_label, NEW.workspace, NEW.model, NEW.archived_at, NEW.created_at,
          NEW.origin, NEW.system_reason, NEW.source_task_id, NEW.question_attached, NEW.source_error_id)
         IS NOT DISTINCT FROM (OLD.id, OLD.mode, OLD.clearance, OLD.effective_label, OLD.workspace, OLD.model, OLD.archived_at, OLD.created_at,
          OLD.origin, OLD.system_reason, OLD.source_task_id, OLD.question_attached, OLD.source_error_id) THEN
    RETURN NEW;
  END IF;
  IF OLD.purged_at IS NOT NULL OR NEW.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'conversation %: only purge_conversation purges, and a purged conversation never changes', OLD.id
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

-- ---------------------------------------------------------------------------
-- purge_conversation, as in 0012, first purges the system chats about its
-- tasks: one of them may hold the question the user attached, and deleting a
-- conversation deletes its texts everywhere. They are archived and purged
-- with the same checks (a system chat at work refuses the whole purge).
-- The result also lists the system chats purged, for the caller's events.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION purge_conversation(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout = '5s' AS $$
DECLARE
  c conversations;
  v_tasks uuid[];
  v_failed jsonb;
  v_expired jsonb;
  v_system jsonb := '[]';
  v_nested jsonb;
  v_chat uuid;
BEGIN
  SELECT * INTO c FROM conversations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR c.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'conversation % does not exist', p_id USING ERRCODE = 'no_data_found';
  END IF;
  IF c.archived_at IS NULL THEN
    RAISE EXCEPTION 'conversation %: only an archived conversation can be deleted', p_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT coalesce(array_agg(id), '{}') INTO v_tasks
  FROM (SELECT id FROM tasks WHERE conversation_id = p_id ORDER BY id FOR UPDATE) locked;
  IF EXISTS (SELECT FROM tasks WHERE id = ANY (v_tasks) AND status IN ('ready', 'running'))
     OR EXISTS (SELECT FROM jobs WHERE status IN ('queued', 'running')
                AND key = ANY (SELECT 'task:' || t FROM unnest(v_tasks) t)) THEN
    RAISE EXCEPTION 'conversation %: a task is still at work', p_id USING ERRCODE = 'object_in_use';
  END IF;

  FOR v_chat IN
    SELECT id FROM conversations
    WHERE origin = 'system' AND source_task_id = ANY (v_tasks) AND purged_at IS NULL AND id <> p_id
    ORDER BY id FOR UPDATE
  LOOP
    UPDATE conversations SET archived_at = now() WHERE id = v_chat AND archived_at IS NULL;
    v_nested := purge_conversation(v_chat);
    v_system := v_system || jsonb_build_array(jsonb_build_object('conversationId', v_chat, 'tasks', v_nested -> 'tasks'))
      || coalesce(v_nested -> 'system', '[]');
    v_failed := coalesce(v_failed, '[]') || (v_nested -> 'failed');
    v_expired := coalesce(v_expired, '[]') || (v_nested -> 'expired');
  END LOOP;

  PERFORM set_config('arianna.purge', p_id::text, true);

  WITH closed AS (
    UPDATE tasks t SET status = 'failed', waiting_reason = NULL, waiting_approval_id = NULL, updated_at = now()
    FROM (SELECT id, status FROM tasks WHERE id = ANY (v_tasks) AND status NOT IN ('done', 'failed')) old
    WHERE t.id = old.id
    RETURNING t.id, old.status
  )
  SELECT coalesce(v_failed, '[]') || coalesce(jsonb_agg(jsonb_build_object('taskId', id, 'from', status) ORDER BY id), '[]')
  INTO v_failed FROM closed;
  WITH expired AS (
    UPDATE approvals SET state = 'expired', decided_at = now()
    WHERE task_id = ANY (v_tasks) AND state = 'pending'
    RETURNING id, task_id
  )
  SELECT coalesce(v_expired, '[]') || coalesce(jsonb_agg(jsonb_build_object('approvalId', id, 'taskId', task_id) ORDER BY id), '[]')
  INTO v_expired FROM expired;
  UPDATE approvals
  SET detail = CASE WHEN kind = 'declassify'
    THEN jsonb_build_object('text', '', 'sha256', encode(sha256(''::bytea), 'hex'),
                            'from', detail -> 'from', 'to', detail -> 'to', 'purged', true)
    ELSE jsonb_build_object('purged', true) END
  WHERE task_id = ANY (v_tasks);

  DELETE FROM task_delegations WHERE task_id = ANY (v_tasks);
  DELETE FROM task_turns WHERE task_id = ANY (v_tasks);
  DELETE FROM messages WHERE conversation_id = p_id;

  UPDATE tasks SET title = 'Conversazione eliminata', goal = NULL, done_criteria = NULL, updated_at = now()
  WHERE id = ANY (v_tasks);
  UPDATE jobs SET last_error = NULL
  WHERE key = ANY (SELECT 'task:' || t FROM unnest(v_tasks) t) AND last_error IS NOT NULL;
  UPDATE conversations SET title = NULL, purged_at = now() WHERE id = p_id;

  PERFORM set_config('arianna.purge', '', true);
  RETURN jsonb_build_object('tasks', cardinality(v_tasks), 'failed', v_failed, 'expired', v_expired, 'system', v_system);
END
$$;

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION purge_conversation(uuid) SET search_path = %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON FUNCTION purge_conversation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_conversation(uuid) TO arianna_app;
