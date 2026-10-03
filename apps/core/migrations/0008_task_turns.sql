-- Task 1.10: the orchestrator's context, per task (D-053). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- task_turns: one row per orchestrator step that completed. The model's
-- answer (without its thought), the thought, and what the step produced: the
-- tool result shown to the model at the next step, or the chat message that
-- answered the user. The next step rebuilds the context from these rows, so a
-- task resumes after a restart with what it had read, and nothing else.
-- ---------------------------------------------------------------------------

CREATE TABLE task_turns (
  id          bigserial PRIMARY KEY,
  task_id     uuid NOT NULL REFERENCES tasks (id),
  step        integer NOT NULL CHECK (step > 0),
  run_id      uuid NOT NULL REFERENCES runs (id),
  -- Highest label among what the step read: context, tool result. Never L3.
  label       privacy_label NOT NULL CHECK (label <> 'L3'),
  -- {"action": ...} as the response schema allows it.
  answer      jsonb NOT NULL CHECK (jsonb_typeof(answer) = 'object' AND answer ? 'action'),
  -- The model's reasoning (D-051): kept with the run, never shown in the chat.
  thought     text,
  -- Tool result or error, as the model will read it.
  result      text,
  message_id  bigint REFERENCES messages (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- One turn per step: a step that runs again after a crash finds its turn.
  CONSTRAINT task_turns_one_per_step UNIQUE (task_id, step)
);

-- A turn belongs to the running local run of its own task and step, points
-- only to an answer of that task, stays within the task's clearance, and
-- raises the task's effective label to what it read.
CREATE FUNCTION task_turns_within_task() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  t tasks;
  r runs;
BEGIN
  SELECT * INTO t FROM tasks WHERE id = NEW.task_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT * INTO r FROM runs WHERE id = NEW.run_id;
  IF NOT FOUND OR r.task_id <> NEW.task_id OR r.step <> NEW.step THEN
    RAISE EXCEPTION 'task_turns: run % is not step % of task %', NEW.run_id, NEW.step, t.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF r.status <> 'running' THEN
    RAISE EXCEPTION 'task_turns: run % is not running', NEW.run_id USING ERRCODE = 'check_violation';
  END IF;
  IF r.locality <> 'local' THEN
    RAISE EXCEPTION 'task_turns: the orchestrator runs on the local model only' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.message_id IS NOT NULL
     AND NOT EXISTS (SELECT FROM messages m WHERE m.id = NEW.message_id AND m.task_id = NEW.task_id AND m.role = 'assistant') THEN
    RAISE EXCEPTION 'task_turns: message % is not an answer of task %', NEW.message_id, t.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.label > t.clearance THEN
    RAISE EXCEPTION 'task_turns: label % is above the clearance % of task %', NEW.label, t.clearance, t.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.label > t.effective_label THEN
    UPDATE tasks SET effective_label = NEW.label, updated_at = now() WHERE id = t.id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER task_turns_within_task BEFORE INSERT ON task_turns
  FOR EACH ROW EXECUTE FUNCTION task_turns_within_task();

CREATE TRIGGER task_turns_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON task_turns
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- What a task has read never goes down, like a conversation's (0004).
CREATE FUNCTION tasks_label_only_up() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.effective_label < OLD.effective_label THEN
    RAISE EXCEPTION 'task %: effective_label cannot go down', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tasks_label_only_up BEFORE UPDATE OF effective_label ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_label_only_up();

-- Append-only for the application role (D-046).
GRANT SELECT, INSERT ON task_turns TO arianna_app;
GRANT USAGE ON SEQUENCE task_turns_id_seq TO arianna_app;
