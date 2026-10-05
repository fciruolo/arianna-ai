-- Activity lines of a task, saved and readable after it ends (D-083, on the
-- request of D-054). See docs/DATA-MODEL.md. Object names are never
-- schema-qualified.

-- ---------------------------------------------------------------------------
-- task_activities: the lines the chat shows while a task works ("searching
-- the KB", "reading", the tools of the Coder, waits), saved where they are
-- published (postActivity, apps/core/src/reply.ts): a kind from a closed list
-- and the same short detail the page shows, after the same filters (a value
-- revealed by the vault refused, at most 300 characters). Never more than
-- what the live line shows: no file content, no brief. The "thinking" line
-- is not saved: the next line replaces it on the page. A line equal to the
-- last one of the task (step, kind, detail) is not saved twice, as the page
-- does not show it twice.
-- Label: the effective label of the task when the line was written, never
-- below it, never above the clearance of its conversation. At most 200 lines
-- per task. Append-only; purge_conversation deletes them with the messages.
-- ---------------------------------------------------------------------------

CREATE TABLE task_activities (
  id       bigserial PRIMARY KEY,
  task_id  uuid NOT NULL REFERENCES tasks (id),
  step     integer NOT NULL CHECK (step >= 0),
  ts       timestamptz NOT NULL DEFAULT now(),
  kind     text NOT NULL CHECK (kind IN ('search', 'read', 'write', 'card', 'plan', 'error', 'delegate', 'tool', 'wait')),
  detail   text NOT NULL CHECK (char_length(detail) <= 300 AND detail !~ '[[:cntrl:]]'),
  label    privacy_label NOT NULL
);

CREATE INDEX task_activities_task_idx ON task_activities (task_id, id);

-- A line of a task of a live conversation, at least the task's effective
-- label, within the clearance of the conversation, under the cap.
CREATE FUNCTION task_activities_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  t tasks;
  c conversations;
BEGIN
  SELECT * INTO t FROM tasks WHERE id = NEW.task_id;
  IF NOT FOUND THEN
    -- The foreign key reports it with its own message.
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM conversations WHERE id = t.conversation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_activities: task % has no conversation', t.id USING ERRCODE = 'check_violation';
  END IF;
  IF c.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'task_activities: conversation % was deleted', c.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.label < t.effective_label THEN
    RAISE EXCEPTION 'task_activities: label % is below the effective label % of task %', NEW.label, t.effective_label, t.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.label > c.clearance THEN
    RAISE EXCEPTION 'task_activities: label % is above the clearance of conversation %', NEW.label, c.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- One writer at a time per task, so that the cap holds; no row of tasks is locked.
  -- The cap of 200 is MAX_SAVED_ACTIVITIES in apps/core/src/reply.ts too: change both together.
  PERFORM pg_advisory_xact_lock(hashtext('task_activities:' || t.id::text));
  IF (SELECT count(*) FROM task_activities WHERE task_id = t.id) >= 200 THEN
    RAISE EXCEPTION 'task_activities: task % has 200 lines already', t.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER task_activities_guard BEFORE INSERT ON task_activities
  FOR EACH ROW EXECUTE FUNCTION task_activities_guard();

CREATE TRIGGER task_activities_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON task_activities
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- Append-only for the application role (D-046).
GRANT SELECT, INSERT ON task_activities TO arianna_app;
GRANT USAGE ON SEQUENCE task_activities_id_seq TO arianna_app;

-- ---------------------------------------------------------------------------
-- The purge (0012, 0013, 0018) deletes the activity lines of the tasks too.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('messages', 'task_turns', 'task_delegations', 'conversation_summaries', 'task_activities')
     AND purge_target(TG_RELID) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- As in 0018, with the activity lines of its tasks deleted with the turns.
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

  DELETE FROM conversation_summaries WHERE conversation_id = p_id;
  DELETE FROM task_delegations WHERE task_id = ANY (v_tasks);
  DELETE FROM task_turns WHERE task_id = ANY (v_tasks);
  DELETE FROM task_activities WHERE task_id = ANY (v_tasks);
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
