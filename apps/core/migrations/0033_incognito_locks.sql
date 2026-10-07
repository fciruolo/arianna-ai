-- Closing an incognito conversation (D-136) writes events (task.status,
-- run.interrupted, call.ended) before purge_incognito runs, and appending an
-- event holds the advisory lock of the chain (0001_init.sql) until the end of
-- the transaction: a lock waited for after the first event stops every other
-- event of Arianna for up to the lock_timeout of the purge. lock_incognito
-- takes first, in the order of the purge, the row locks the purge will need on
-- the tables arianna_app cannot lock by itself (it has no UPDATE there). A lock
-- that does not come in time fails here, before anything is written. Whoever
-- works on the rows of a task writes its event after the update, never before.
CREATE FUNCTION lock_incognito(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout = '5s' AS $$
DECLARE
  v_tasks uuid[];
BEGIN
  PERFORM FROM conversations WHERE id = p_id AND incognito AND purged_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation %: not an incognito conversation', p_id USING ERRCODE = 'no_data_found';
  END IF;
  SELECT coalesce(array_agg(id), '{}') INTO v_tasks
  FROM (SELECT id FROM tasks WHERE conversation_id = p_id ORDER BY id FOR UPDATE) locked;
  PERFORM FROM approvals WHERE task_id = ANY (v_tasks) ORDER BY id FOR UPDATE;
  PERFORM FROM conversation_summaries WHERE conversation_id = p_id FOR UPDATE;
  PERFORM FROM conversation_participants WHERE conversation_id = p_id FOR UPDATE;
  PERFORM FROM task_delegations WHERE task_id = ANY (v_tasks) FOR UPDATE;
  PERFORM FROM task_turns WHERE task_id = ANY (v_tasks) FOR UPDATE;
  PERFORM FROM task_activities WHERE task_id = ANY (v_tasks) FOR UPDATE;
  PERFORM FROM messages WHERE conversation_id = p_id ORDER BY id FOR UPDATE;
  PERFORM FROM runs WHERE task_id = ANY (v_tasks) ORDER BY id FOR UPDATE;
  PERFORM FROM jobs WHERE key = ANY (SELECT 'task:' || t FROM unnest(v_tasks) t) ORDER BY id FOR UPDATE;
  PERFORM FROM calls WHERE conversation_id = p_id ORDER BY id FOR UPDATE;
END
$$;

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION lock_incognito(uuid) SET search_path = %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON FUNCTION lock_incognito(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_incognito(uuid) TO arianna_app;
