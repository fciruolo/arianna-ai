-- Moving a commitment of the secretary to another day (I-12, D-148): the
-- confirmation of commitment.move is an approval of kind `commitment` like
-- those of commitment.add and commitment.done. See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

ALTER TABLE approvals DROP CONSTRAINT approvals_commitment_fields;
ALTER TABLE approvals ADD CONSTRAINT approvals_commitment_fields
  CHECK (kind <> 'commitment' OR (action IN ('commitment.add', 'commitment.done', 'commitment.move') AND label >= 'L2' AND task_id IS NOT NULL));
