-- Arianna reads the folders of the Mac (D-314, I-22, tappa M1): read only,
-- in a private conversation with Arianna on the local model. A folder not yet
-- allowed asks the user first: an approval of kind `mac`, action `mac.read`,
-- at L2 (it names a folder and a file of the user), decided in the web chat
-- with one of three choices, written in `choice`: `once` (that call only),
-- `conversation` (every call of that conversation in the folder and its
-- subfolders) or `always` (the folder joins the permanent list). The detail
-- holds what the card shows: the folder as written, its name, the sentence
-- and the equivalent command written by the core, the tool, the step, and what
-- the step had read before (pages, files), each a short text. The purge of the
-- asking conversation leaves only {"purged": true}.
--
-- mac_folders: the permanent list of Impostazioni → Cartelle del Mac, written
-- only by the user (the page of the settings, or «Sempre» on a card); no agent
-- writes it. A path is absolute, as written (the core resolves it again with
-- realpath at every call); L2 like everything of the Mac, and it never leaves
-- this machine. arianna_app never deletes (doctor): «Togli» sets removed_at,
-- once and for good; the same folder added again is a new row. See docs/DATA-MODEL.md and docs/PRIVACY-POLICY-SPEC.md.
-- Object names are never schema-qualified.

CREATE TABLE mac_folders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path        text NOT NULL
              CHECK (left(path, 1) = '/' AND length(path) BETWEEN 2 AND 1000 AND path !~ '[[:cntrl:]]'),
  added_at    timestamptz NOT NULL DEFAULT now(),
  -- The card «Sempre» that added it; null for a folder added in the settings.
  approval_id uuid REFERENCES approvals (id),
  removed_at  timestamptz
);

-- One live row per folder.
CREATE UNIQUE INDEX mac_folders_live ON mac_folders (path) WHERE removed_at IS NULL;

-- Only «Togli»: removed_at from null to a time, nothing else changes, never back.
CREATE FUNCTION mac_folders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
     OR NEW.id <> OLD.id OR NEW.path <> OLD.path OR NEW.added_at <> OLD.added_at
     OR NEW.approval_id IS DISTINCT FROM OLD.approval_id THEN
    RAISE EXCEPTION 'mac_folders_guard: a folder is only taken off, once';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER mac_folders_guard BEFORE UPDATE ON mac_folders
  FOR EACH ROW EXECUTE FUNCTION mac_folders_guard();

GRANT SELECT, INSERT ON mac_folders TO arianna_app;
GRANT UPDATE (removed_at) ON mac_folders TO arianna_app;

ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('action', 'declassify', 'budget', 'setting', 'workspace', 'commitment', 'plan', 'executor', 'im', 'fact', 'routine', 'browser', 'mac'));

ALTER TABLE approvals ADD CONSTRAINT approvals_mac_fields
  CHECK (kind <> 'mac' OR (
    action = 'mac.read' AND label = 'L2' AND task_id IS NOT NULL AND (
      coalesce(detail -> 'purged' = 'true'::jsonb, false)
      OR (coalesce(detail ->> 'tool' IN ('mac.list', 'mac.info', 'mac.read', 'mac.find'), false)
          AND coalesce(jsonb_typeof(detail -> 'step') = 'number', false)
          AND coalesce(left(detail ->> 'folder', 1) = '/', false)
          AND coalesce(jsonb_typeof(detail -> 'place') = 'string', false)
          AND coalesce(jsonb_typeof(detail -> 'sentence') = 'string', false)
          AND coalesce(jsonb_typeof(detail -> 'command') = 'string', false)
          AND CASE WHEN jsonb_typeof(detail -> 'after') = 'array' THEN jsonb_array_length(detail -> 'after') <= 5 ELSE false END
          AND NOT jsonb_path_exists(detail, '$.after[*] ? (@.type() != "string")'))
    )
  ));
ALTER TABLE approvals ADD CONSTRAINT approvals_mac_via_web
  CHECK (kind <> 'mac' OR decided_via IS NULL OR decided_via = 'web');

-- The choice of an approved card: the executor of a card of an agent (D-159), or how long a folder of the Mac is allowed.
ALTER TABLE approvals DROP CONSTRAINT approvals_choice_check;
ALTER TABLE approvals DROP CONSTRAINT approvals_choice;
ALTER TABLE approvals ADD CONSTRAINT approvals_choice
  CHECK ((choice IS NOT NULL) = (kind IN ('executor', 'mac') AND state = 'approved')
    AND (choice IS NULL
      OR (kind = 'executor' AND choice IN ('claude', 'codex', 'local'))
      OR (kind = 'mac' AND choice IN ('once', 'conversation', 'always'))));

-- The grants of a conversation are read by its tasks, from the approvals of kind mac.
CREATE INDEX approvals_mac_idx ON approvals (task_id) WHERE kind = 'mac';

-- arianna_app inserts and updates approvals and appends events since 0007; mac_folders above.
