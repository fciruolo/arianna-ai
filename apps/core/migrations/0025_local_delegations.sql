-- A step delegated to an agent of the user that only answers, on the local
-- model (D-119, tappa T3). See docs/DATA-MODEL.md. Object names are never
-- schema-qualified.

-- ---------------------------------------------------------------------------
-- task_delegations_guard: the run of a delegation was a cloud run only (the
-- Coder on Claude Code, 0009). Now the run matches the executor written on
-- the delegation: a local run for executor = 'local', a cloud run for any
-- other. Everything else of the guard is the same as in 0009.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION task_delegations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  t tasks;
BEGIN
  SELECT * INTO t FROM tasks WHERE id = NEW.task_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.task_id, NEW.step, NEW.agent, NEW.brief, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.task_id, OLD.step, OLD.agent, OLD.brief, OLD.created_at) THEN
    RAISE EXCEPTION 'task_delegations: the delegation of step % of task % cannot change', OLD.step, t.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('ok', 'failed', 'refused') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'task_delegations: delegation % has ended', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.label > OLD.label THEN
    RAISE EXCEPTION 'task_delegations: the label of the brief cannot go up' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.label > t.clearance OR (NEW.result_label IS NOT NULL AND NEW.result_label > t.clearance) THEN
    RAISE EXCEPTION 'task_delegations: above the clearance % of task %', t.clearance, t.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.run_id IS NOT NULL
     AND NOT EXISTS (
       SELECT FROM runs r WHERE r.id = NEW.run_id AND r.task_id = NEW.task_id
         AND r.locality = CASE WHEN NEW.executor = 'local' THEN 'local' ELSE 'cloud' END
     ) THEN
    RAISE EXCEPTION 'task_delegations: run % is not a % run of task %', NEW.run_id,
      CASE WHEN NEW.executor = 'local' THEN 'local' ELSE 'cloud' END, t.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.message_id IS NOT NULL
     AND NOT EXISTS (SELECT FROM messages m WHERE m.id = NEW.message_id AND m.task_id = NEW.task_id AND m.role = 'assistant') THEN
    RAISE EXCEPTION 'task_delegations: message % is not a message of task %', NEW.message_id, t.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.result_label IS NOT NULL AND NEW.result_label > t.effective_label THEN
    UPDATE tasks SET effective_label = NEW.result_label, updated_at = now() WHERE id = t.id;
  END IF;
  RETURN NEW;
END
$$;
