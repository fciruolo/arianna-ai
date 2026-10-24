-- Milestones proposed in the chat (D-313, seguito 2): the orchestrator's tool
-- `milestone.propose` writes an approval of kind `milestone_plan` with what the
-- card shows (the project, the title, «Fatta quando», the due day and the
-- titles of the new cards), at the label of the step that wrote it and never
-- below the project's. Nothing is created until the user approves it in the
-- web chat: then, in the transaction of the decision, the core creates the
-- milestone (Privato, as every milestone today) and its cards in the inbox,
-- children of the chat task, each in the milestone. `milestones.approval_id`
-- names the approval that created it: one milestone per approval, and the
-- answer of the chat reads it. See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('action', 'declassify', 'budget', 'setting', 'workspace', 'commitment', 'plan', 'executor', 'im', 'fact', 'routine', 'browser', 'milestone', 'mac', 'milestone_plan'));
-- The purge of the asking conversation (purge_conversation) leaves only {"purged": true}.
ALTER TABLE approvals ADD CONSTRAINT approvals_milestone_plan_fields
  CHECK (kind <> 'milestone_plan' OR (
    action = 'milestone.propose' AND task_id IS NOT NULL AND label <= 'L2' AND (
      coalesce(detail -> 'purged' = 'true'::jsonb, false)
      OR (coalesce(jsonb_typeof(detail -> 'project') = 'string', false)
        AND coalesce(jsonb_typeof(detail -> 'title') = 'string', false)
        AND coalesce(jsonb_typeof(detail -> 'cards') = 'array', false))
    )
  ));
ALTER TABLE approvals ADD CONSTRAINT approvals_milestone_plan_via_web
  CHECK (kind <> 'milestone_plan' OR decided_via IS NULL OR decided_via = 'web');

-- The approval that created a milestone from the chat; NULL for one written on the wall.
-- Erasing the asking conversation (0043, 0072) deletes its approvals: the milestone stays on the wall.
ALTER TABLE milestones ADD COLUMN approval_id uuid REFERENCES approvals (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX milestones_approval_idx ON milestones (approval_id) WHERE approval_id IS NOT NULL;

-- milestones_guard of 0093, and approval_id: set when the milestone is born, then only taken away (the erase).
CREATE OR REPLACE FUNCTION milestones_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.project IS DISTINCT FROM OLD.project OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'milestone %: its project never changes', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.approval_id IS DISTINCT FROM OLD.approval_id AND NEW.approval_id IS NOT NULL THEN
    RAISE EXCEPTION 'milestone %: its approval is set once, when it is born', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- No new grant: arianna_app selects, inserts and updates approvals (0007) and milestones (0093).
