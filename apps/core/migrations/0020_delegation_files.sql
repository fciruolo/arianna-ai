-- The files a delegated run left changed in the project folder (D-082). See
-- docs/DATA-MODEL.md. Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- task_delegations.files: [{path, change, from?}] of the run, against the
-- last commit and without the paths the user had already changed before it.
-- Paths relative to the project and the kind of change only, never content:
-- the chat lists them under the Coder's report, and shows a file on request
-- by reading the approved project folder again (GET /api/delegations/:id/files/:index).
-- NULL: not recorded (no run, a run that failed before the comparison, or a
-- delegation from before this migration); [] : the run changed nothing.
-- Written once, then frozen; deleted with the delegation by purge_conversation
-- (0012). The table grants of 0009 (SELECT, INSERT, UPDATE) cover the column.
-- ---------------------------------------------------------------------------

-- A path as git writes it, relative to the top of the project: not empty, not
-- absolute, no `..` segment, no control character, at most 1024 characters.
CREATE FUNCTION delegation_path_ok(p_path text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path FROM CURRENT AS $$
  SELECT p_path IS NOT NULL
     AND char_length(p_path) BETWEEN 1 AND 1024
     AND left(p_path, 1) <> '/'
     AND p_path !~ '(^|/)\.\.(/|$)'
     AND p_path !~ '[[:cntrl:]]'
$$;

-- CASE, not AND: SQL does not promise the order, and the jsonb functions fail on the wrong type.
CREATE FUNCTION delegation_files_ok(p_files jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path FROM CURRENT AS $$
  SELECT CASE WHEN jsonb_typeof(p_files) <> 'array' THEN false
    ELSE jsonb_array_length(p_files) <= 500 AND NOT EXISTS (
      SELECT FROM jsonb_array_elements(p_files) AS e (item)
      WHERE CASE WHEN jsonb_typeof(e.item) <> 'object' THEN true
        ELSE EXISTS (SELECT FROM jsonb_object_keys(e.item) AS k (key) WHERE k.key NOT IN ('path', 'change', 'from'))
          OR coalesce(jsonb_typeof(e.item -> 'path'), '') <> 'string'
          OR NOT delegation_path_ok(e.item ->> 'path')
          OR coalesce(e.item ->> 'change', '') NOT IN ('added', 'modified', 'deleted', 'renamed')
          OR ((e.item ->> 'change') = 'renamed') <> (e.item ? 'from')
          OR (e.item ? 'from' AND (coalesce(jsonb_typeof(e.item -> 'from'), '') <> 'string' OR NOT delegation_path_ok(e.item ->> 'from')))
        END
    )
  END
$$;

ALTER TABLE task_delegations ADD COLUMN files jsonb;
ALTER TABLE task_delegations ADD CONSTRAINT task_delegations_files CHECK (files IS NULL OR delegation_files_ok(files));

-- Written once, by the run of the delegation on its project: never on a new
-- row, never changed afterwards.
CREATE FUNCTION task_delegations_files_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.files IS NOT NULL THEN
      RAISE EXCEPTION 'task_delegations: the files come from the run, not with the delegation' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.files IS NOT NULL AND NEW.files IS DISTINCT FROM OLD.files THEN
    RAISE EXCEPTION 'task_delegations: the files of delegation % are written once', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.files IS NULL AND NEW.files IS NOT NULL AND (NEW.run_id IS NULL OR NEW.repo IS NULL) THEN
    RAISE EXCEPTION 'task_delegations: files only for a run on a project' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER task_delegations_files_frozen BEFORE INSERT OR UPDATE ON task_delegations
  FOR EACH ROW EXECUTE FUNCTION task_delegations_files_frozen();
