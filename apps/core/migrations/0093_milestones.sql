-- Milestones of a project on the cardwall (D-313): a group of cards of one
-- project with a title, an optional description ("fatta" quando…) and due
-- day, an order, «bloccata da» another milestone of the same project, open
-- or closed. A card is in at most one milestone, of its own project (a
-- composite foreign key: the database refuses a milestone of another
-- project, and a card without a project has none). The closing is never
-- automatic: when every card of an open milestone is done, the core asks
-- (an approval of kind `milestone`, decided in the web chat); with «No» it
-- does not ask again until a card comes in, goes out or opens again.
-- See docs/DATA-MODEL.md. Object names are never schema-qualified.

CREATE TABLE milestones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The name of a [[project]] of arianna.toml (the same check as tasks.project); it never changes.
  project      text NOT NULL CHECK (project ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$'),
  -- The user's words, at `label`: one line, and what "done" means.
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND title !~ '[\r\n]'),
  description  text CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000),
  due_on       date,
  -- The order of the bands of the project: lower first; ties by creation.
  position     integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  -- Never below the project's label; a text written by hand is Privato (L2,
  -- default-deny). At most L2: the secretary conversation, where the closing
  -- is asked, holds it.
  label        privacy_label NOT NULL DEFAULT 'L2' CHECK (label <= 'L2'),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at    timestamptz,
  -- The user said «No» to the closing: no new proposal until the cards change (the core clears it).
  declined_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT milestones_closed_at CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  -- The target of the composite key of tasks: a card's milestone is of the card's project.
  CONSTRAINT milestones_id_project UNIQUE (id, project)
);
CREATE INDEX milestones_project_idx ON milestones (project, position, created_at);

-- The project of a milestone never changes: its cards would be of another project.
CREATE FUNCTION milestones_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.project IS DISTINCT FROM OLD.project OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'milestone %: its project never changes', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER milestones_guard BEFORE UPDATE ON milestones FOR EACH ROW EXECUTE FUNCTION milestones_guard();

-- ---------------------------------------------------------------------------
-- tasks.milestone_id: the milestone of a card, of the card's own project.
-- MATCH SIMPLE skips the key when `project` is NULL: the check below refuses
-- a milestone on a card without a project. Only on cards, as tasks.project.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN milestone_id uuid;
ALTER TABLE tasks ADD CONSTRAINT tasks_milestone_project CHECK (milestone_id IS NULL OR project IS NOT NULL);
ALTER TABLE tasks ADD CONSTRAINT tasks_milestone_fkey FOREIGN KEY (milestone_id, project) REFERENCES milestones (id, project);
CREATE INDEX tasks_milestone_idx ON tasks (milestone_id) WHERE milestone_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- milestone_dependencies: `milestone_id` is «bloccata da» `depends_on`, of the
-- same project, never itself, never a cycle (as task_dependencies, 0040). A
-- sign on the wall: it holds no card back. Taken away with `removed_at`.
-- ---------------------------------------------------------------------------

CREATE TABLE milestone_dependencies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id  uuid NOT NULL REFERENCES milestones (id),
  depends_on    uuid NOT NULL REFERENCES milestones (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  CONSTRAINT milestone_dependencies_not_self CHECK (milestone_id <> depends_on),
  CONSTRAINT milestone_dependencies_removed_after CHECK (removed_at IS NULL OR removed_at >= created_at)
);
CREATE UNIQUE INDEX milestone_dependencies_live ON milestone_dependencies (milestone_id, depends_on) WHERE removed_at IS NULL;
CREATE INDEX milestone_dependencies_on_idx ON milestone_dependencies (depends_on) WHERE removed_at IS NULL;

CREATE FUNCTION milestone_dependencies_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.milestone_id, NEW.depends_on, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.milestone_id, OLD.depends_on, OLD.created_at)
       OR OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL THEN
      RAISE EXCEPTION 'milestone dependency %: only its removal, once', OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- Two additions at once could close a cycle that neither sees: one at a time.
  PERFORM pg_advisory_xact_lock(hashtext('milestone_dependencies'));
  IF (SELECT count(DISTINCT project) FROM milestones WHERE id IN (NEW.milestone_id, NEW.depends_on)) <> 1 THEN
    RAISE EXCEPTION 'milestone dependency: only within one project' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    WITH RECURSIVE waits (id) AS (
      SELECT d.depends_on FROM milestone_dependencies d WHERE d.milestone_id = NEW.depends_on AND d.removed_at IS NULL
      UNION
      SELECT d.depends_on FROM milestone_dependencies d JOIN waits w ON d.milestone_id = w.id WHERE d.removed_at IS NULL
    )
    SELECT FROM waits WHERE id = NEW.milestone_id
  ) THEN
    RAISE EXCEPTION 'milestone dependency: a cycle' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER milestone_dependencies_guard BEFORE INSERT OR UPDATE ON milestone_dependencies
  FOR EACH ROW EXECUTE FUNCTION milestone_dependencies_guard();

-- The core writes and changes milestones and their dependencies; it never deletes (D-046).
GRANT SELECT, INSERT, UPDATE ON milestones TO arianna_app;
GRANT SELECT, INSERT, UPDATE ON milestone_dependencies TO arianna_app;

-- ---------------------------------------------------------------------------
-- approvals of kind `milestone` (action `milestone.close`): the core proposes
-- to close an open milestone whose cards are all done. No task: the detail
-- holds the milestone's id, its project and its title (the user's words, at
-- the label of the milestone); decided only in the web chat; at most one
-- pending per milestone.
-- ---------------------------------------------------------------------------

ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('action', 'declassify', 'budget', 'setting', 'workspace', 'commitment', 'plan', 'executor', 'im', 'fact', 'routine', 'browser', 'milestone'));
ALTER TABLE approvals ADD CONSTRAINT approvals_milestone_fields
  CHECK (kind <> 'milestone' OR (
    action = 'milestone.close' AND task_id IS NULL
    AND coalesce(jsonb_typeof(detail -> 'milestoneId') = 'string', false)
    AND coalesce(jsonb_typeof(detail -> 'project') = 'string', false)
    AND coalesce(jsonb_typeof(detail -> 'title') = 'string', false)
  ));
ALTER TABLE approvals ADD CONSTRAINT approvals_milestone_via_web
  CHECK (kind <> 'milestone' OR decided_via IS NULL OR decided_via = 'web');
CREATE UNIQUE INDEX approvals_milestone_pending_idx ON approvals ((detail ->> 'milestoneId')) WHERE kind = 'milestone' AND state = 'pending';
