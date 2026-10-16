-- The cardwall, tappa C5 (I-13, D-235): «/progetta», the plan edited before
-- the decision, the cards of a plan in the inbox with their complexity. See
-- docs/DATA-MODEL.md. Object names are never schema-qualified.
--
-- No new grant: arianna_app selects, inserts and updates tasks and approvals
-- at table level since 0007. Only ids and closed values here, never text.

-- ---------------------------------------------------------------------------
-- tasks.plan_approval_id: the approved plan a card was born from. Only on
-- cards (tasks without a conversation). erase_conversation deletes the
-- approvals of a conversation's tasks while the cards stay on the wall
-- (D-159): the link is then cleared, never the card.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN plan_approval_id uuid REFERENCES approvals (id) ON DELETE SET NULL;
ALTER TABLE tasks ADD CONSTRAINT tasks_plan_approval_only_cards CHECK (plan_approval_id IS NULL OR conversation_id IS NULL);
CREATE INDEX tasks_plan_approval_idx ON tasks (plan_approval_id) WHERE plan_approval_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- tasks.complexity: S, M or L, as the plan proposed it (the user may change
-- it before approving). Only on cards.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN complexity text CHECK (complexity IN ('S', 'M', 'L'));
ALTER TABLE tasks ADD CONSTRAINT tasks_complexity_only_cards CHECK (complexity IS NULL OR conversation_id IS NULL);

-- ---------------------------------------------------------------------------
-- tasks.planning: «/progetta» (D-235). `request` is the chat task of the
-- message «/progetta …» (Arianna answers without a model and the card below
-- is born); `card` is the card «Piano: …», a job of its own on the wall,
-- assigned to Arianna, that calls the planner and waits for the user's
-- decision on its approval of kind plan. A request is never an addressed
-- message too. The card's parent is the request (cleared when its
-- conversation is erased); one card per request, so that a step repeated
-- after a crash finds the card instead of writing a second one.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN planning text CHECK (planning IN ('request', 'card'));
ALTER TABLE tasks ADD CONSTRAINT tasks_planning_fields CHECK (
  planning IS NULL
  OR (planning = 'request' AND conversation_id IS NOT NULL AND addressed IS NULL)
  OR (planning = 'card' AND conversation_id IS NULL AND assignee = 'arianna')
);
CREATE UNIQUE INDEX tasks_planning_card_one ON tasks (parent_id) WHERE planning = 'card';

-- ---------------------------------------------------------------------------
-- approvals_guard: as in 0012, the purge reaching the plan of a card «Piano»
-- of the conversation too (below), and the cards of a pending plan may be
-- replaced (the user edits the plan in its card before deciding, D-235).
-- Only the detail of a pending approval of kind plan, while it stays pending:
-- id, task, kind, action, time of the request and label never change (the
-- label is frozen by approvals_label_frozen too), and a decided plan never
-- changes again.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION approvals_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  v_target uuid := purge_target(TG_RELID);
BEGIN
  IF v_target IS NOT NULL
     AND EXISTS (SELECT FROM tasks t WHERE t.id = OLD.task_id
                 AND (t.conversation_id = v_target
                      OR (t.planning = 'card' AND t.parent_id IN (SELECT p.id FROM tasks p WHERE p.conversation_id = v_target))))
     AND (NEW.id, NEW.task_id, NEW.kind, NEW.action, NEW.requested_at, NEW.decided_via)
         IS NOT DISTINCT FROM (OLD.id, OLD.task_id, OLD.kind, OLD.action, OLD.requested_at, OLD.decided_via)
     AND (NEW.state = OLD.state OR (OLD.state = 'pending' AND NEW.state = 'expired')) THEN
    RETURN NEW;
  END IF;
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'approval % is already %', OLD.id, OLD.state USING ERRCODE = 'restrict_violation';
  END IF;
  -- A pending plan edited by the user: only its detail, and it stays pending.
  IF OLD.kind = 'plan' AND NEW.state = 'pending'
     AND (NEW.id, NEW.task_id, NEW.kind, NEW.action, NEW.requested_at, NEW.decided_at, NEW.decided_via, NEW.choice)
         IS NOT DISTINCT FROM (OLD.id, OLD.task_id, OLD.kind, OLD.action, OLD.requested_at, OLD.decided_at, OLD.decided_via, OLD.choice)
     AND jsonb_typeof(NEW.detail) = 'object' THEN
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.task_id, NEW.kind, NEW.action, NEW.detail, NEW.requested_at)
     IS DISTINCT FROM (OLD.id, OLD.task_id, OLD.kind, OLD.action, OLD.detail, OLD.requested_at) THEN
    RAISE EXCEPTION 'approval %: only the decision can change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- «Elimina» and «Elimina per sempre» (D-157) take the card «Piano» with the
-- conversation: it holds the user's request word for word (its title and
-- goal) and the plan's approval, at the label of the conversation, but has no
-- conversation of its own. purge_conversation: as in 0071, and the cards
-- «Piano» whose request is a task of the conversation are purged with its
-- tasks (closed, titles and goals emptied, their approvals expired and
-- emptied; approvals_guard above lets the purge reach them). The cards the
-- plan created stay on the wall, as since D-159.
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
  FROM (SELECT id FROM tasks WHERE conversation_id = p_id
          -- The card «Piano» of a «/progetta» of the conversation (D-235): its request and plan go with it.
          OR (planning = 'card' AND parent_id IN (SELECT id FROM tasks WHERE conversation_id = p_id))
        ORDER BY id FOR UPDATE) locked;
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
-- erase_conversation: as in 0071, and the cards «Piano» of the tree are
-- erased with its tasks (their runs, approvals, jobs and events).
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
  FROM (SELECT id FROM tasks WHERE conversation_id = ANY (v_convs)
          -- The card «Piano» of a «/progetta» of the tree (D-235): its request and plan are erased with it.
          OR (planning = 'card' AND parent_id IN (SELECT id FROM tasks WHERE conversation_id = ANY (v_convs)))
        ORDER BY id FOR UPDATE) locked;
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
