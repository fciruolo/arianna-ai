-- «Chiedi a lato» (D-232, idea 8 of OpenWork): a side thread is a
-- conversation of its own, born from an answer of another conversation (its
-- mother) and hidden from the list. Its questions and answers never enter the
-- history the model reads in the mother: they are messages of the side
-- thread. Who answers and what it may read are the mother's, copied at birth
-- (mode, clearance, agent, model, project, finance mark), and its effective
-- label starts at least at the mother's and at the label of the answer it is
-- about. Only ids here, never content. See docs/DATA-MODEL.md. Object names
-- are never schema-qualified.
--
-- No new grant: arianna_app inserts and updates conversations at table level
-- since 0007; the guard below freezes the two new columns. Deleting the
-- mother takes its side threads with it: purge_conversation purges them as it
-- purges the system chats about its tasks, erase_conversation erases them
-- with the rest of its tree.

-- side_message_id is not a foreign key: purge_conversation deletes the
-- messages of the mother while a purged side thread keeps its skeleton. The
-- guard below checks it at birth, and it never changes.
ALTER TABLE conversations
  ADD COLUMN side_of uuid REFERENCES conversations(id),
  ADD COLUMN side_message_id bigint;

ALTER TABLE conversations ADD CONSTRAINT conversations_side_pair
  CHECK ((side_of IS NULL) = (side_message_id IS NULL));
-- A side thread is the user's, never incognito, the secretary's or a trial chat, never pinned.
ALTER TABLE conversations ADD CONSTRAINT conversations_side_fields
  CHECK (side_of IS NULL OR (origin = 'user' AND NOT incognito AND NOT secretary AND trial_model IS NULL AND pinned_at IS NULL));

-- One live side thread per answer: «Chiedi a lato» opens the same one again.
CREATE UNIQUE INDEX conversations_side_one ON conversations (side_message_id) WHERE side_of IS NOT NULL AND purged_at IS NULL;
CREATE INDEX conversations_side_of_idx ON conversations (side_of) WHERE side_of IS NOT NULL;

CREATE FUNCTION conversations_side_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  m conversations;
  v_role text;
  v_label privacy_label;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.side_of, NEW.side_message_id) IS DISTINCT FROM (OLD.side_of, OLD.side_message_id) THEN
      RAISE EXCEPTION 'conversation %: a side thread is chosen at creation and never changes', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.side_of IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO m FROM conversations WHERE id = NEW.side_of;
  IF NOT FOUND OR m.purged_at IS NOT NULL OR m.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'side thread: conversation % is not open', NEW.side_of USING ERRCODE = 'check_violation';
  END IF;
  -- Never a side thread of a side thread, of a system chat, of an incognito, the secretary's or a trial chat.
  IF m.side_of IS NOT NULL OR m.origin <> 'user' OR m.incognito OR m.secretary OR m.trial_model IS NOT NULL THEN
    RAISE EXCEPTION 'side thread: conversation % takes no side thread', m.id USING ERRCODE = 'check_violation';
  END IF;
  -- Only where the answer comes without a delegation of its own: Arianna, the local model, the plain chats.
  IF m.agent IS NOT NULL AND m.agent NOT IN ('local-chat', 'claude', 'codex') THEN
    RAISE EXCEPTION 'side thread: the direct chat with % takes no side thread', m.agent USING ERRCODE = 'check_violation';
  END IF;
  -- Who answers, and what it may read, are the mother's.
  IF (NEW.mode, NEW.clearance, NEW.agent, NEW.model, NEW.workspace, NEW.origin, NEW.incognito)
     IS DISTINCT FROM (m.mode, m.clearance, m.agent, m.model, m.workspace, 'user'::text, false) THEN
    RAISE EXCEPTION 'side thread: mode, clearance, agent, model and project are those of conversation %', m.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT role, label INTO v_role, v_label FROM messages WHERE id = NEW.side_message_id AND conversation_id = m.id;
  IF NOT FOUND OR v_role <> 'assistant' THEN
    RAISE EXCEPTION 'side thread: message % is not an answer of conversation %', NEW.side_message_id, m.id USING ERRCODE = 'check_violation';
  END IF;
  -- Never lower than the mother and the answer: the side thread reads them.
  NEW.effective_label := GREATEST(NEW.effective_label, m.effective_label, v_label);
  NEW.finance := NEW.finance OR m.finance;
  IF NEW.finance THEN
    NEW.effective_label := 'L2';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversations_side_guard BEFORE INSERT OR UPDATE OF side_of, side_message_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_side_guard();

-- ---------------------------------------------------------------------------
-- As in 0026, and the side threads of the conversation are purged first, as
-- the system chats about its tasks are (archived, then purged, their counts in
-- `system`).
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
    WHERE ((origin = 'system' AND source_task_id = ANY (v_tasks)) OR side_of = p_id) AND purged_at IS NULL AND id <> p_id
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


-- ---------------------------------------------------------------------------
-- As in 0043, and the tree of the conversation holds its side threads too, at
-- any depth together with the system chats.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION erase_conversation(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout = '5s' AS $$
DECLARE
  c conversations;
  v_convs uuid[];
  v_tasks uuid[];
  v_runs uuid[];
  v_approvals uuid[];
  v_calls uuid[];
  v_ids text[];
  v_uuids uuid[];
  v_table regclass;
  v_found bigint;
  v_total bigint := 0;
  v_cards bigint;
  v_events bigint;
  v_first bigint;
  v_prev bytea;
  e events;
BEGIN
  SELECT * INTO c FROM conversations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR c.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'conversation % does not exist', p_id USING ERRCODE = 'no_data_found';
  END IF;

  -- The conversation, the system chats about its tasks and its side threads (D-232), at any depth.
  WITH RECURSIVE tree (id) AS (
    SELECT p_id
    UNION
    SELECT s.id FROM tree LEFT JOIN tasks t ON t.conversation_id = tree.id
      JOIN conversations s ON s.source_task_id = t.id OR s.side_of = tree.id
  )
  SELECT array_agg(id ORDER BY id) INTO v_convs FROM tree;
  PERFORM FROM conversations WHERE id = ANY (v_convs) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT FROM conversations WHERE id = ANY (v_convs) AND (secretary OR incognito))
     OR EXISTS (SELECT FROM telegram_state WHERE conversation_id = ANY (v_convs)) THEN
    RAISE EXCEPTION 'conversation %: the conversation of the secretary, of Telegram or an incognito one is not erased', p_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT coalesce(array_agg(id), '{}') INTO v_tasks
  FROM (SELECT id FROM tasks WHERE conversation_id = ANY (v_convs) ORDER BY id FOR UPDATE) locked;
  SELECT coalesce(array_agg(id), '{}') INTO v_runs
  FROM (SELECT id FROM runs WHERE task_id = ANY (v_tasks) ORDER BY id FOR UPDATE) locked;
  SELECT coalesce(array_agg(id), '{}') INTO v_approvals
  FROM (SELECT id FROM approvals WHERE task_id = ANY (v_tasks) ORDER BY id FOR UPDATE) locked;
  SELECT coalesce(array_agg(id), '{}') INTO v_calls
  FROM (SELECT id FROM calls WHERE conversation_id = ANY (v_convs) OR task_id = ANY (v_tasks) ORDER BY id FOR UPDATE) locked;
  PERFORM FROM jobs WHERE key = ANY (SELECT 'task:' || t FROM unnest(v_tasks) t) ORDER BY id FOR UPDATE;

  IF EXISTS (SELECT FROM jobs WHERE status = 'running' AND key = ANY (SELECT 'task:' || t FROM unnest(v_tasks) t))
     OR EXISTS (SELECT FROM calls WHERE id = ANY (v_calls) AND status IN ('ringing', 'connecting', 'active')) THEN
    RAISE EXCEPTION 'conversation %: a step or a call is still at work', p_id USING ERRCODE = 'object_in_use';
  END IF;

  -- Every id that may stand in a payload or a key, as text.
  v_uuids := ARRAY(SELECT DISTINCT x FROM unnest(v_convs || v_tasks || v_runs || v_approvals || v_calls) x);
  v_ids := ARRAY(SELECT x::text FROM unnest(v_uuids) x);

  -- Each of them is the id of its own row only: the core writes these ids,
  -- and one equal to another row's (the secretary, a card, a commitment)
  -- would take that row's events and labels with this conversation.
  FOR v_table IN
    SELECT r.oid::regclass FROM pg_class r JOIN pg_attribute col ON col.attrelid = r.oid
    WHERE r.relnamespace = current_schema()::regnamespace AND r.relkind IN ('r', 'p')
      AND col.attname = 'id' AND col.atttypid = 'uuid'::regtype AND NOT col.attisdropped
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE id = ANY ($1)', v_table) INTO v_found USING v_uuids;
    v_total := v_total + v_found;
  END LOOP;
  IF v_total <> cardinality(v_uuids) THEN
    RAISE EXCEPTION 'conversation %: an id of its rows is also the id of another row', p_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- The jobs found by their payload too, before the chain's lock.
  PERFORM FROM jobs WHERE EXISTS (SELECT FROM unnest(v_ids) x WHERE strpos(payload::text, x) > 0) ORDER BY id FOR UPDATE;

  PERFORM set_config('arianna.erase', p_id::text, true);

  -- What stays, without the link: the cards and the runs of other tasks resumed from these.
  UPDATE tasks SET parent_id = NULL WHERE parent_id = ANY (v_tasks) AND NOT id = ANY (v_tasks);
  GET DIAGNOSTICS v_cards = ROW_COUNT;
  UPDATE runs SET resumed_from = NULL WHERE resumed_from = ANY (v_runs) AND NOT id = ANY (v_runs);
  UPDATE commitments SET
    conversation_id = CASE WHEN conversation_id = ANY (v_convs) THEN NULL ELSE conversation_id END,
    task_id = CASE WHEN task_id = ANY (v_tasks) THEN NULL ELSE task_id END,
    approval_id = CASE WHEN approval_id = ANY (v_approvals) THEN NULL ELSE approval_id END
  WHERE conversation_id = ANY (v_convs) OR task_id = ANY (v_tasks) OR approval_id = ANY (v_approvals);

  -- The audit of these tasks and runs. The chain lock first: no event is written meanwhile.
  PERFORM pg_advisory_xact_lock(hashtext('arianna.events'));
  WITH gone AS (
    DELETE FROM events
    WHERE task_id = ANY (v_tasks) OR run_id = ANY (v_runs)
       OR EXISTS (SELECT FROM unnest(v_ids) x WHERE strpos(payload::text, x) > 0)
    RETURNING id
  )
  SELECT count(*), min(id) INTO v_events, v_first FROM gone;
  DELETE FROM label_changes
  WHERE approval_id = ANY (v_approvals) OR EXISTS (SELECT FROM unnest(v_ids) x WHERE strpos(subject, x) > 0);
  DELETE FROM gateway_log WHERE task_id = ANY (v_tasks) OR run_id = ANY (v_runs);
  DELETE FROM router_decisions WHERE task_id = ANY (v_tasks) OR run_id = ANY (v_runs);

  -- The texts, children before parents.
  DELETE FROM conversation_summaries WHERE conversation_id = ANY (v_convs) OR task_id = ANY (v_tasks);
  DELETE FROM conversation_participants WHERE conversation_id = ANY (v_convs) OR task_id = ANY (v_tasks);
  DELETE FROM task_turns WHERE task_id = ANY (v_tasks);
  DELETE FROM task_delegations WHERE task_id = ANY (v_tasks);
  DELETE FROM task_activities WHERE task_id = ANY (v_tasks);
  DELETE FROM messages WHERE conversation_id = ANY (v_convs) OR task_id = ANY (v_tasks);
  DELETE FROM calls WHERE id = ANY (v_calls);
  -- Parts and dependencies are of cards only, which have no conversation: none here, deleted for safety.
  DELETE FROM task_dependencies WHERE task_id = ANY (v_tasks) OR depends_on = ANY (v_tasks);
  DELETE FROM card_checklist WHERE task_id = ANY (v_tasks);
  DELETE FROM card_links WHERE task_id = ANY (v_tasks);
  DELETE FROM card_files WHERE task_id = ANY (v_tasks);
  DELETE FROM jobs
  WHERE key = ANY (SELECT 'task:' || t FROM unnest(v_tasks) t)
     OR EXISTS (SELECT FROM unnest(v_ids) x WHERE strpos(payload::text, x) > 0);
  DELETE FROM runs WHERE id = ANY (v_runs);
  -- Tasks, approvals, errors and conversations name each other: one statement, checked at its end.
  WITH errors AS (DELETE FROM task_errors WHERE task_id = ANY (v_tasks)),
       approvals_gone AS (DELETE FROM approvals WHERE id = ANY (v_approvals)),
       tasks_gone AS (DELETE FROM tasks WHERE id = ANY (v_tasks))
  DELETE FROM conversations WHERE id = ANY (v_convs);

  -- The chain sewn again from the first event deleted, in order.
  IF v_first IS NOT NULL THEN
    SELECT hash INTO v_prev FROM events WHERE id < v_first ORDER BY id DESC LIMIT 1;
    FOR e IN SELECT * FROM events WHERE id > v_first ORDER BY id LOOP
      e.prev_hash := v_prev;
      e.hash := event_hash(v_prev, e);
      UPDATE events SET prev_hash = e.prev_hash, hash = e.hash WHERE id = e.id;
      v_prev := e.hash;
    END LOOP;
  END IF;
  INSERT INTO events (kind, label, payload) VALUES ('events.rewoven', 'L0', '{}');

  PERFORM set_config('arianna.erase', '', true);
  RETURN jsonb_build_object('conversations', cardinality(v_convs), 'tasks', cardinality(v_tasks), 'cards', v_cards, 'events', v_events);
END
$$;

-- The schema of this migration, then pg_temp last: a temporary table cannot
-- stand in for a table the function deletes from.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION erase_conversation(uuid) SET search_path = %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON FUNCTION erase_conversation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_conversation(uuid) TO arianna_app;
