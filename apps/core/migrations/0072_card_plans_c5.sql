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
-- approvals_guard: as in 0012, and the cards of a pending plan may be
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
     AND EXISTS (SELECT FROM tasks WHERE id = OLD.task_id AND conversation_id = v_target)
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
