-- Deleting a conversation for good, with everything it left (D-157, the
-- user's choice of 2026-10-10, which supersedes D-046 and D-057 here): its
-- rows go from every table, the audit included, and the chain of the events
-- is sewn again over the gap, with one line without content that says it
-- was. See docs/DATA-MODEL.md. Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- erase_target: the conversation erase_conversation is erasing, as the guards
-- see it. Set only for the rest of the transaction by erase_conversation, and
-- honoured only when the statement runs as the owner of the table, as
-- purge_target (0012): the core (arianna_app) can set the setting, but never
-- acts as the owner except inside erase_conversation.
-- ---------------------------------------------------------------------------

CREATE FUNCTION erase_target(p_rel oid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT nullif(current_setting('arianna.erase', true), '')::uuid
  WHERE (SELECT relowner FROM pg_class WHERE oid = p_rel) = (SELECT oid FROM pg_roles WHERE rolname = current_user)
$$;

-- As in 0021, and the erase deletes from any append-only table (never a TRUNCATE, never an UPDATE).
CREATE OR REPLACE FUNCTION append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' AND erase_target(TG_RELID) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('messages', 'task_turns', 'task_delegations', 'conversation_summaries', 'task_activities')
     AND purge_target(TG_RELID) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- The events: only the erase deletes some and writes the hashes again after them.
CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') AND erase_target(TG_RELID) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- As in 0026, and the erase deletes the participants of its conversations.
CREATE OR REPLACE FUNCTION conversation_participants_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  c conversations;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF purge_target(TG_RELID) = OLD.conversation_id OR erase_target(TG_RELID) IS NOT NULL THEN
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

-- As in 0039, and a commitment told in an erased conversation stays, without
-- its origin: only conversation, task and confirmation go to NULL, nothing else.
CREATE OR REPLACE FUNCTION commitments_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF erase_target(TG_RELID) IS NOT NULL
     AND (NEW.id, NEW.body, NEW.created_at, NEW.rescheduled_from, NEW.label)
         IS NOT DISTINCT FROM (OLD.id, OLD.body, OLD.created_at, OLD.rescheduled_from, OLD.label)
     AND (NEW.conversation_id IS NULL OR NEW.conversation_id = OLD.conversation_id)
     AND (NEW.task_id IS NULL OR NEW.task_id = OLD.task_id)
     AND (NEW.approval_id IS NULL OR NEW.approval_id = OLD.approval_id) THEN
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.body, NEW.conversation_id, NEW.task_id, NEW.approval_id, NEW.created_at, NEW.rescheduled_from)
     IS DISTINCT FROM (OLD.id, OLD.body, OLD.conversation_id, OLD.task_id, OLD.approval_id, OLD.created_at, OLD.rescheduled_from) THEN
    RAISE EXCEPTION 'commitment %: its text and origin never change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.label < OLD.label THEN
    RAISE EXCEPTION 'commitment %: the label cannot go down', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- erase_conversation: the only DELETE of the core on the audit. It runs as
-- the owner of the schema (the core cannot delete, D-046) on one conversation
-- of the user that is not the secretary's, nor Telegram's, nor an incognito
-- one (it has "Termina"), and not deleted already. With it go the system
-- chats about its tasks (D-064), at any depth. Refused while a step of one
-- of its tasks is claimed by a worker or a call on it is live: the core stops
-- them first (as for an incognito, D-136) and tries again.
--
-- Deleted: every row that names the conversation, its tasks, their runs,
-- approvals and calls: messages, tasks, turns, delegations (with their
-- files), activities, errors, summaries, participants, approvals,
-- label_changes, runs, router_decisions, gateway_log, jobs, calls, the parts
-- and dependencies of a card that would name them, and the events, found by
-- task, run or any of those ids in their payload.
-- Kept: the cards made from the conversation (tasks without a conversation,
-- D-152), unlinked from their parent; a commitment, without its origin.
-- The chain: from the first event deleted on, every hash is written again
-- in order, then one event `events.rewoven` without content (no id, no
-- text, the time only) says the log was sewn. Every row it updates, and
-- every job it deletes, is locked before the chain's; after the chain's it
-- deletes only rows of append-only tables (events, label_changes, messages,
-- turns, summaries...) that no writer updates.
-- Refused (55000) when an id of these rows is also the id of a row of
-- another table: a forged id would take that row's events with it.
-- ---------------------------------------------------------------------------

CREATE FUNCTION erase_conversation(p_id uuid) RETURNS jsonb
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

  -- The conversation and the system chats about its tasks, at any depth.
  WITH RECURSIVE tree (id) AS (
    SELECT p_id
    UNION
    SELECT s.id FROM conversations s JOIN tasks t ON t.id = s.source_task_id JOIN tree ON t.conversation_id = tree.id
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
