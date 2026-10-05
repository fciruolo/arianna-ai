-- The agents that joined a conversation as colleagues (D-125, D-107 B1).
-- See docs/DATA-MODEL.md. Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- conversation_participants: who is in a conversation besides the user and
-- Arianna. Arianna brings an agent in with its first delegation there
-- (added_by = 'arianna', with that delegation and its task); the user takes
-- it out with a click (removed_at). An agent taken out comes back with the
-- next delegation as a new row. At most one active row per agent and
-- conversation (the partial unique index): two tasks delegating together add
-- it once.
-- No text: ids, names of agents and times only. The lines the chat shows
-- ("Arianna aggiunge…", "… è stato aggiunto", "Hai tolto …") are system
-- messages with the task, written by the core (apps/core/src/participants.ts).
-- Rows only end (removed_at), and only once; purge_conversation deletes them.
-- ---------------------------------------------------------------------------

CREATE TABLE conversation_participants (
  id               bigserial PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations (id),
  agent            text NOT NULL CHECK (agent ~ '^[a-z][a-z0-9-]{0,63}$' AND agent <> 'arianna'),
  added_by         text NOT NULL CHECK (added_by IN ('arianna', 'user')),
  -- The task and the delegation that brought the agent in (added_by = 'arianna').
  task_id          uuid REFERENCES tasks (id),
  delegation_id    bigint REFERENCES task_delegations (id),
  added_at         timestamptz NOT NULL DEFAULT now(),
  removed_at       timestamptz,
  CONSTRAINT conversation_participants_by_arianna
    CHECK (added_by <> 'arianna' OR (task_id IS NOT NULL AND delegation_id IS NOT NULL)),
  CONSTRAINT conversation_participants_removed_after CHECK (removed_at IS NULL OR removed_at >= added_at)
);

CREATE UNIQUE INDEX conversation_participants_one_active
  ON conversation_participants (conversation_id, agent) WHERE removed_at IS NULL;
CREATE INDEX conversation_participants_conversation_idx ON conversation_participants (conversation_id, id);
CREATE INDEX conversation_participants_delegation_idx ON conversation_participants (delegation_id) WHERE delegation_id IS NOT NULL;

-- A new row joins a live conversation, active, with a delegation of its own
-- task to the same agent; an update only ends a row, once; a row is deleted
-- only by the purge of its conversation.
CREATE FUNCTION conversation_participants_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  c conversations;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF purge_target(TG_RELID) = OLD.conversation_id THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'conversation_participants: a participant is taken out, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.conversation_id, NEW.agent, NEW.added_by, NEW.task_id, NEW.delegation_id, NEW.added_at)
       IS DISTINCT FROM (OLD.id, OLD.conversation_id, OLD.agent, OLD.added_by, OLD.task_id, OLD.delegation_id, OLD.added_at) THEN
      RAISE EXCEPTION 'conversation_participants: only removed_at can change' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL THEN
      RAISE EXCEPTION 'conversation_participants: participant % can only be taken out once', OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM conversations WHERE id = NEW.conversation_id;
  IF NOT FOUND THEN
    -- The foreign key reports it with its own message.
    RETURN NEW;
  END IF;
  IF c.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'conversation_participants: conversation % was deleted', c.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'conversation_participants: a participant joins active' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.task_id IS NOT NULL AND NOT EXISTS (SELECT FROM tasks WHERE id = NEW.task_id AND conversation_id = c.id) THEN
    RAISE EXCEPTION 'conversation_participants: task % does not belong to conversation %', NEW.task_id, c.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.delegation_id IS NOT NULL
     AND NOT EXISTS (SELECT FROM task_delegations WHERE id = NEW.delegation_id AND task_id = NEW.task_id AND agent = NEW.agent) THEN
    RAISE EXCEPTION 'conversation_participants: delegation % is not a delegation of task % to %', NEW.delegation_id, NEW.task_id, NEW.agent
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversation_participants_guard BEFORE INSERT OR UPDATE OR DELETE ON conversation_participants
  FOR EACH ROW EXECUTE FUNCTION conversation_participants_guard();

CREATE TRIGGER conversation_participants_no_truncate BEFORE TRUNCATE ON conversation_participants
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- The core adds and takes out; it never deletes (D-046).
GRANT SELECT, INSERT, UPDATE ON conversation_participants TO arianna_app;
GRANT USAGE ON SEQUENCE conversation_participants_id_seq TO arianna_app;

-- ---------------------------------------------------------------------------
-- conversation_summaries_guard: as in 0018, but a system message with a task
-- (the lines of D-109 and of the participants) is for the user only, as
-- conversationView and the summaries read it: it is neither a gap between
-- two pieces nor part of a piece's label. Before this, such a line between
-- two pieces refused the second one.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION conversation_summaries_guard() RETURNS trigger
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
               AND role IN ('user', 'assistant', 'system') AND agent IS NULL
               AND NOT (role = 'system' AND task_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'conversation_summaries: a piece starts right after the last one of conversation %, leaving no message out', c.id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(label) INTO v_read FROM messages
  WHERE conversation_id = c.id AND id BETWEEN NEW.first_message_id AND NEW.last_message_id
    AND role IN ('user', 'assistant', 'system') AND agent IS NULL
    AND NOT (role = 'system' AND task_id IS NOT NULL);
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

-- ---------------------------------------------------------------------------
-- The purge (0012, 0013, 0018, 0021) deletes the participants too, before
-- the delegations they point at.
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

  DELETE FROM conversation_summaries WHERE conversation_id = p_id;
  DELETE FROM conversation_participants WHERE conversation_id = p_id;
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
