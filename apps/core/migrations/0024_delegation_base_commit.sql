-- The commit the files of a delegated run are compared against (D-117). See
-- docs/DATA-MODEL.md. Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- task_delegations.base_commit: HEAD of the project when the run's changes
-- were listed (task_delegations.files, 0020), so that the chat can show the
-- diff of each file later (GET /api/delegations/:id/diff) by reading the old
-- version from git and the current one from the folder. A commit id only,
-- never content. NULL: not recorded (a delegation from before this
-- migration, no files) or a repository without commits (every file is then
-- added). Written in the same update as the files, then frozen like them.
-- The table grants of 0009 (SELECT, INSERT, UPDATE) cover the column.
-- ---------------------------------------------------------------------------

ALTER TABLE task_delegations ADD COLUMN base_commit text;
ALTER TABLE task_delegations ADD CONSTRAINT task_delegations_base_commit
  CHECK (base_commit IS NULL OR base_commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$');

CREATE FUNCTION task_delegations_base_commit_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.base_commit IS NOT NULL THEN
      RAISE EXCEPTION 'task_delegations: the base commit comes from the run, not with the delegation' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.base_commit IS DISTINCT FROM OLD.base_commit
     AND NOT (OLD.base_commit IS NULL AND OLD.files IS NULL AND NEW.files IS NOT NULL) THEN
    RAISE EXCEPTION 'task_delegations: the base commit of delegation % is written once, with the files', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER task_delegations_base_commit_frozen BEFORE INSERT OR UPDATE ON task_delegations
  FOR EACH ROW EXECUTE FUNCTION task_delegations_base_commit_frozen();
