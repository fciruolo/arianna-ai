-- D-056: the Coder works in the project folder itself. When that folder has
-- changes the user has not committed, the launch waits for an approval of a
-- new kind, `workspace`, whose detail names the repository and the files.
-- Object names are never schema-qualified.

ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('action', 'declassify', 'budget', 'setting', 'workspace'));
