-- Deleting an archived conversation for good (D-057, second part): its texts
-- go, the skeleton of the audit stays. See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- conversations.purged_at: when its texts were deleted. A purged conversation
-- stays archived, has no title, is shown nowhere and never changes again.
-- ---------------------------------------------------------------------------

ALTER TABLE conversations ADD COLUMN purged_at timestamptz;
ALTER TABLE conversations ADD CONSTRAINT conversations_purged_archived_untitled
  CHECK (purged_at IS NULL OR (archived_at IS NOT NULL AND title IS NULL));

-- ---------------------------------------------------------------------------
-- purge_target: the conversation purge_conversation is purging, as the guards
-- see it. Set only for the rest of the transaction by purge_conversation, and
-- honoured only when the statement runs as the owner of the table: the core
-- (arianna_app) can set the setting, but never acts as the owner except
-- inside purge_conversation. No table lock and no DDL: the guards stay on.
-- ---------------------------------------------------------------------------

CREATE FUNCTION purge_target(p_rel oid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT nullif(current_setting('arianna.purge', true), '')::uuid
  WHERE (SELECT relowner FROM pg_class WHERE oid = p_rel) = (SELECT oid FROM pg_roles WHERE rolname = current_user)
$$;

-- The append-only tables whose rows a purge deletes; nothing else, and only deletes.
CREATE OR REPLACE FUNCTION append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('messages', 'task_turns', 'task_delegations')
     AND purge_target(TG_RELID) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- A decided approval stays frozen, except that a purge empties the detail of
-- the approvals of its tasks and lets the pending ones expire.
CREATE OR REPLACE FUNCTION approvals_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  v_target uuid := purge_target(TG_RELID);
BEGIN
  IF v_target IS NOT NULL
     AND EXISTS (SELECT FROM tasks WHERE id = OLD.task_id AND conversation_id = v_target)
     AND (NEW.id, NEW.task_id, NEW.kind, NEW.action, NEW.requested_at, NEW.decided_via)
         IS NOT DISTINCT FROM (OLD.id, OLD.task_id, OLD.kind, OLD.action, OLD.requested_at, OLD.decided_via)
     AND (NEW.state = OLD.state OR (OLD.state = 'pending' AND NEW.state = 'expired')) THEN
    RETURN NEW;
  END IF;
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'approval % is already %', OLD.id, OLD.state USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.task_id, NEW.kind, NEW.action, NEW.detail, NEW.requested_at)
     IS DISTINCT FROM (OLD.id, OLD.task_id, OLD.kind, OLD.action, OLD.detail, OLD.requested_at) THEN
    RAISE EXCEPTION 'approval %: only the decision can change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION conversations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- The purge: title gone, purged_at set, nothing else.
  IF purge_target(TG_RELID) = OLD.id AND OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL AND NEW.title IS NULL
     AND (NEW.id, NEW.mode, NEW.clearance, NEW.effective_label, NEW.workspace, NEW.model, NEW.archived_at, NEW.created_at)
         IS NOT DISTINCT FROM (OLD.id, OLD.mode, OLD.clearance, OLD.effective_label, OLD.workspace, OLD.model, OLD.archived_at, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  IF OLD.purged_at IS NOT NULL OR NEW.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'conversation %: only purge_conversation purges, and a purged conversation never changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
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

-- A purged conversation takes no message at all; an archived one no message of the user.
CREATE OR REPLACE FUNCTION messages_not_archived() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (SELECT FROM conversations WHERE id = NEW.conversation_id AND purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'message: conversation % was deleted', NEW.conversation_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.role = 'user' AND EXISTS (SELECT FROM conversations WHERE id = NEW.conversation_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'message: conversation % is archived', NEW.conversation_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- purge_conversation: the only way texts leave the append-only tables. It runs
-- as the owner of the schema (the core cannot delete, D-046) and only on an
-- archived conversation whose tasks are not at work. It locks the rows of the
-- conversation and of its tasks, as the core does, never a whole table. In
-- one transaction:
--   deleted: messages, task_turns and task_delegations of its tasks;
--   emptied: the title, the titles and goals of its tasks, the detail of their
--            approvals (a declassification keeps its labels, with an empty
--            text), the last error of their jobs;
--   closed:  a task not done or failed fails, its pending approvals expire;
--   kept:    tasks, runs, approvals, jobs, gateway_log (with its L1 summary),
--            router_decisions, label_changes, events: no text above L1, and
--            the event chain cannot lose a link.
-- Returns what changed state, for the caller to write the events.
-- ---------------------------------------------------------------------------

CREATE FUNCTION purge_conversation(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout = '5s' AS $$
DECLARE
  c conversations;
  v_tasks uuid[];
  v_failed jsonb;
  v_expired jsonb;
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

  PERFORM set_config('arianna.purge', p_id::text, true);

  WITH closed AS (
    UPDATE tasks t SET status = 'failed', waiting_reason = NULL, waiting_approval_id = NULL, updated_at = now()
    FROM (SELECT id, status FROM tasks WHERE id = ANY (v_tasks) AND status NOT IN ('done', 'failed')) old
    WHERE t.id = old.id
    RETURNING t.id, old.status
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('taskId', id, 'from', status) ORDER BY id), '[]') INTO v_failed FROM closed;
  WITH expired AS (
    UPDATE approvals SET state = 'expired', decided_at = now()
    WHERE task_id = ANY (v_tasks) AND state = 'pending'
    RETURNING id, task_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('approvalId', id, 'taskId', task_id) ORDER BY id), '[]') INTO v_expired FROM expired;
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
  RETURN jsonb_build_object('tasks', cardinality(v_tasks), 'failed', v_failed, 'expired', v_expired);
END
$$;

-- The schema of this migration, then pg_temp last: a temporary table cannot
-- stand in for a table the function deletes from.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION purge_conversation(uuid) SET search_path = %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON FUNCTION purge_conversation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_conversation(uuid) TO arianna_app;
