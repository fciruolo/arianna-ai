-- Summaries of the conversation history the orchestrator no longer reads
-- message by message (D-077). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- conversation_summaries: the orchestrator reads a conversation from an
-- anchor that stays put until the history grows past a maximum, then jumps
-- forward. The messages it leaves behind are summarized by the local model,
-- one piece per jump, appended at the end: pieces are never rewritten, so the
-- prompt "system prompt + summary" keeps its prefix (the cache of oMLX).
-- A piece covers the messages of its conversation from first_message_id to
-- last_message_id that the orchestrator reads (user, assistant and system
-- messages not written by a delegated agent); pieces follow each other
-- without overlapping. Its label is at least the highest label among those
-- messages: the output of a model inherits the highest label of its inputs.
-- A range the gateway blocked gets a placeholder piece, with that label and
-- no content of the messages, so that the next piece can follow it.
-- Append-only; purge_conversation deletes them with the messages.
-- ---------------------------------------------------------------------------

CREATE TABLE conversation_summaries (
  id                bigserial PRIMARY KEY,
  conversation_id   uuid NOT NULL REFERENCES conversations (id),
  first_message_id  bigint NOT NULL REFERENCES messages (id),
  last_message_id   bigint NOT NULL REFERENCES messages (id),
  -- No model reads L3, so no summary holds it.
  label             privacy_label NOT NULL CHECK (label <> 'L3'),
  body              text NOT NULL CHECK (body <> '' AND char_length(body) <= 4000),
  -- The local model alias that wrote it, the orchestrator's: never a cloud executor.
  model             text NOT NULL CHECK (model = 'local-large'),
  -- The step of the orchestrator that wrote it.
  task_id           uuid NOT NULL REFERENCES tasks (id),
  run_id            uuid NOT NULL REFERENCES runs (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_summaries_range CHECK (first_message_id <= last_message_id),
  CONSTRAINT conversation_summaries_one_per_end UNIQUE (conversation_id, last_message_id)
);

-- A piece comes from the running local run of a task of its conversation,
-- covers messages of that conversation right after the last piece (no gap
-- and no overlap among the messages the orchestrator reads), carries at least
-- their highest label, stays within the clearances and raises the task's
-- effective label to what it read, like a turn (0008).
CREATE FUNCTION conversation_summaries_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  c conversations;
  t tasks;
  r runs;
  v_read privacy_label;
  v_last bigint;
BEGIN
  SELECT * INTO c FROM conversations WHERE id = NEW.conversation_id FOR UPDATE;
  IF NOT FOUND THEN
    -- The foreign key reports it with its own message.
    RETURN NEW;
  END IF;
  IF c.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'conversation_summaries: conversation % was deleted', c.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO t FROM tasks WHERE id = NEW.task_id FOR UPDATE;
  IF NOT FOUND OR t.conversation_id IS DISTINCT FROM c.id THEN
    RAISE EXCEPTION 'conversation_summaries: task % does not belong to conversation %', NEW.task_id, c.id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO r FROM runs WHERE id = NEW.run_id;
  IF NOT FOUND OR r.task_id <> t.id OR r.status <> 'running' THEN
    RAISE EXCEPTION 'conversation_summaries: run % is not a running run of task %', NEW.run_id, t.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF r.locality <> 'local' THEN
    RAISE EXCEPTION 'conversation_summaries: only the local model writes a summary' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT FROM messages WHERE id = NEW.first_message_id AND conversation_id = c.id)
     OR NOT EXISTS (SELECT FROM messages WHERE id = NEW.last_message_id AND conversation_id = c.id) THEN
    RAISE EXCEPTION 'conversation_summaries: the messages are not of conversation %', c.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(last_message_id) INTO v_last FROM conversation_summaries WHERE conversation_id = c.id;
  IF v_last >= NEW.first_message_id THEN
    RAISE EXCEPTION 'conversation_summaries: a piece is appended after the last one of conversation %', c.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT FROM messages
             WHERE conversation_id = c.id AND id > coalesce(v_last, 0) AND id < NEW.first_message_id
               AND role IN ('user', 'assistant', 'system') AND agent IS NULL) THEN
    RAISE EXCEPTION 'conversation_summaries: a piece starts right after the last one of conversation %, leaving no message out', c.id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(label) INTO v_read FROM messages
  WHERE conversation_id = c.id AND id BETWEEN NEW.first_message_id AND NEW.last_message_id
    AND role IN ('user', 'assistant', 'system') AND agent IS NULL;
  IF v_read IS NOT NULL AND NEW.label < v_read THEN
    RAISE EXCEPTION 'conversation_summaries: label % is below the label % of the messages it summarizes', NEW.label, v_read
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.label > c.clearance OR NEW.label > t.clearance THEN
    RAISE EXCEPTION 'conversation_summaries: label % is above the clearance of task % or of its conversation', NEW.label, t.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.label > t.effective_label THEN
    UPDATE tasks SET effective_label = NEW.label, updated_at = now() WHERE id = t.id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversation_summaries_guard BEFORE INSERT ON conversation_summaries
  FOR EACH ROW EXECUTE FUNCTION conversation_summaries_guard();

CREATE TRIGGER conversation_summaries_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON conversation_summaries
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- Append-only for the application role (D-046).
GRANT SELECT, INSERT ON conversation_summaries TO arianna_app;
GRANT USAGE ON SEQUENCE conversation_summaries_id_seq TO arianna_app;

-- ---------------------------------------------------------------------------
-- The purge (0012, 0013) deletes the summaries of the conversation too.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('messages', 'task_turns', 'task_delegations', 'conversation_summaries')
     AND purge_target(TG_RELID) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- As in 0013, with the summaries deleted before the messages they point to.
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
