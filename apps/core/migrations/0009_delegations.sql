-- Task 1.10, second part (D-055): a step delegated to the Coder on a cloud
-- executor, the model the user chose for a work conversation, and the agent
-- that wrote a chat message. See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- conversations.model: the cloud model the user chose for the delegated steps
-- of a work conversation (a router alias: sonnet, opus, fable, codex). NULL
-- lets the router choose. A private conversation never has one: it stays on
-- the local model. The guard trigger of 0004 leaves this column free to change.
-- ---------------------------------------------------------------------------

ALTER TABLE conversations ADD COLUMN model text CHECK (model <> '');
ALTER TABLE conversations ADD CONSTRAINT conversations_model_only_work CHECK (model IS NULL OR mode = 'work');

-- ---------------------------------------------------------------------------
-- messages.agent: the agent that wrote an assistant message (`coder` for the
-- report of a delegated step). NULL means Arianna, as every row before this
-- migration. A user or system message has none.
-- ---------------------------------------------------------------------------

ALTER TABLE messages ADD COLUMN agent text CHECK (agent <> '');
ALTER TABLE messages ADD CONSTRAINT messages_agent_only_assistant CHECK (agent IS NULL OR role = 'assistant');

-- ---------------------------------------------------------------------------
-- task_delegations: one row per task.delegate call of the orchestrator. The
-- brief as the model wrote it, with the label of what it was written from;
-- the executor and model the router chose; the cloud run, its workspace and
-- session for resuming; and the outcome the next local step reads as the
-- tool result. The brief leaves only through the gateway (gateway_log).
-- ---------------------------------------------------------------------------

CREATE TABLE task_delegations (
  id            bigserial PRIMARY KEY,
  task_id       uuid NOT NULL REFERENCES tasks (id),
  -- The orchestrator step whose call delegated.
  step          integer NOT NULL CHECK (step > 0),
  agent         text NOT NULL CHECK (agent <> ''),
  brief         text NOT NULL CHECK (brief <> ''),
  -- Label of the brief as written; lowered only by an approved declassification (label_changes).
  label         privacy_label NOT NULL CHECK (label <> 'L3'),
  -- Repository the step works on, relative to ARIANNA_HOME; in cloud.allowlist.
  repo          text CHECK (repo <> ''),
  -- pending: to run; running: launched; ok, failed: ended; refused: the user kept it local.
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ok', 'failed', 'refused')),
  executor      text CHECK (executor <> ''),
  model         text CHECK (model <> ''),
  -- The cloud run (the last attempt).
  run_id        uuid REFERENCES runs (id),
  -- The run whose folder data/worktrees/<id> is the workspace, kept across attempts and restarts.
  workspace_run uuid,
  session_ref   text CHECK (session_ref <> ''),
  -- The report of the agent (ok) or the error, as the next local step reads it.
  result        text CHECK (result <> ''),
  result_label  privacy_label CHECK (result_label <> 'L3'),
  -- The report stored in the chat, when the task answers in a conversation.
  message_id    bigint REFERENCES messages (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  CONSTRAINT task_delegations_one_per_step UNIQUE (task_id, step),
  CONSTRAINT task_delegations_ended CHECK ((status IN ('pending', 'running')) = (ended_at IS NULL)),
  CONSTRAINT task_delegations_result CHECK (status IN ('pending', 'running') OR (result IS NOT NULL AND result_label IS NOT NULL))
);

CREATE INDEX task_delegations_task_idx ON task_delegations (task_id, step);

-- A delegation stays within the clearance of its task; what identifies it
-- never changes; a cloud run belongs to the same task; a stored report is a
-- message of the same task; its label raises the task's effective label.
CREATE FUNCTION task_delegations_guard() RETURNS trigger
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
     AND NOT EXISTS (SELECT FROM runs r WHERE r.id = NEW.run_id AND r.task_id = NEW.task_id AND r.locality = 'cloud') THEN
    RAISE EXCEPTION 'task_delegations: run % is not a cloud run of task %', NEW.run_id, t.id USING ERRCODE = 'check_violation';
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

CREATE TRIGGER task_delegations_guard BEFORE INSERT OR UPDATE ON task_delegations
  FOR EACH ROW EXECUTE FUNCTION task_delegations_guard();

CREATE TRIGGER task_delegations_no_delete BEFORE DELETE OR TRUNCATE ON task_delegations
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- Rows only, under the guard (D-046).
GRANT SELECT, INSERT, UPDATE ON task_delegations TO arianna_app;
GRANT USAGE ON SEQUENCE task_delegations_id_seq TO arianna_app;
