-- The cardwall (I-13 tappa C1, D-152): the project of a card and the
-- dependencies between cards ("bloccato da"). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- tasks.project: the project a card belongs to (the name of a [[project]] of
-- arianna.toml, never a path); NULL is a general card. Only on cards (tasks
-- without a conversation): a task of a conversation has the conversation's
-- workspace. No text of the card here: a name the user chose.
-- `due_at` exists since 0001.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN project text CHECK (project ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$');
ALTER TABLE tasks ADD CONSTRAINT tasks_project_only_cards CHECK (project IS NULL OR conversation_id IS NULL);

CREATE INDEX tasks_cards_idx ON tasks (status, updated_at) WHERE conversation_id IS NULL;

-- ---------------------------------------------------------------------------
-- task_dependencies: `task_id` waits for `depends_on` ("aspetta: Grafica
-- della landing"). A task with a dependency not `done` does not start: the
-- engine holds its step back (task.blocked) and queues it again when the
-- last one is done. Between cards only, never a task on itself, never a
-- cycle. A dependency taken away gets `removed_at`: the core never deletes
-- (D-046), so the same pair can come back as a new row.
-- ---------------------------------------------------------------------------

CREATE TABLE task_dependencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks (id),
  depends_on  uuid NOT NULL REFERENCES tasks (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  CONSTRAINT task_dependencies_not_self CHECK (task_id <> depends_on),
  CONSTRAINT task_dependencies_removed_after CHECK (removed_at IS NULL OR removed_at >= created_at)
);

CREATE UNIQUE INDEX task_dependencies_live ON task_dependencies (task_id, depends_on) WHERE removed_at IS NULL;
CREATE INDEX task_dependencies_on_idx ON task_dependencies (depends_on) WHERE removed_at IS NULL;

-- Between cards only; no cycle; a row only gets its removal, once.
CREATE FUNCTION task_dependencies_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.task_id, NEW.depends_on, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.task_id, OLD.depends_on, OLD.created_at)
       OR OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL THEN
      RAISE EXCEPTION 'task dependency %: only its removal, once', OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- Two additions at once could close a cycle that neither sees: one at a time.
  PERFORM pg_advisory_xact_lock(hashtext('task_dependencies'));
  IF EXISTS (SELECT FROM tasks WHERE id IN (NEW.task_id, NEW.depends_on) AND conversation_id IS NOT NULL) THEN
    RAISE EXCEPTION 'task dependency: only between cards' USING ERRCODE = 'check_violation';
  END IF;
  -- A cycle: `depends_on` already waits, directly or not, for `task_id`.
  IF EXISTS (
    WITH RECURSIVE waits (id) AS (
      SELECT d.depends_on FROM task_dependencies d WHERE d.task_id = NEW.depends_on AND d.removed_at IS NULL
      UNION
      SELECT d.depends_on FROM task_dependencies d JOIN waits w ON d.task_id = w.id WHERE d.removed_at IS NULL
    )
    SELECT FROM waits WHERE id = NEW.task_id
  ) THEN
    RAISE EXCEPTION 'task dependency: a cycle' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER task_dependencies_guard BEFORE INSERT OR UPDATE ON task_dependencies
  FOR EACH ROW EXECUTE FUNCTION task_dependencies_guard();

-- The core adds a dependency and takes it away; it never deletes (D-046).
GRANT SELECT, INSERT, UPDATE ON task_dependencies TO arianna_app;
