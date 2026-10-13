-- "Parlane con GOD" (I-6, D-178): a new conversation with GOD can start from
-- an entry of the register of the versions (CHANGELOG.md on the
-- installation's main) instead of an earlier conversation. Its context is the
-- same kind of summary "Riassumi e riparti" saves (0053), read once by the
-- first session after the dossier: the text of the entry, the ids it cites,
-- the commits and files of its version (names and line counts, never
-- contents). So a summary comes either from a conversation or from a version
-- of the register: exactly one of the two. Work data of Arianna's own code,
-- L1 at most as before. See docs/DATA-MODEL.md.

ALTER TABLE god_carries ALTER COLUMN from_conversation_id DROP NOT NULL;

-- The version the entry belongs to (X.Y.Z), or `unreleased` for "Non rilasciato".
ALTER TABLE god_carries ADD COLUMN from_changelog text
  CHECK (from_changelog ~ '^([0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}|unreleased)$');

ALTER TABLE god_carries ADD CONSTRAINT god_carries_one_source
  CHECK ((from_conversation_id IS NULL) <> (from_changelog IS NULL));
