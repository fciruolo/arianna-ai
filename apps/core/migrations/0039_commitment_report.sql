-- The end-of-day report of the secretary (I-12 tappa S3, D-151): the user
-- says what was done, what was not and why, and what is postponed to which
-- day. One confirmation (an approval of kind `commitment`, action
-- commitment.report) closes several commitments at once. A postponed
-- commitment stays on its day with its reason and status `postponed`; the
-- new day is a new commitment that names it in `rescheduled_from`.
-- See docs/DATA-MODEL.md. Object names are never schema-qualified.

ALTER TABLE approvals DROP CONSTRAINT approvals_commitment_fields;
ALTER TABLE approvals ADD CONSTRAINT approvals_commitment_fields
  CHECK (kind <> 'commitment' OR (action IN ('commitment.add', 'commitment.done', 'commitment.move', 'commitment.report') AND label >= 'L2' AND task_id IS NOT NULL));

-- The commitment this one continues, postponed: one successor at most.
ALTER TABLE commitments ADD COLUMN rescheduled_from uuid UNIQUE REFERENCES commitments (id);
ALTER TABLE commitments ADD CONSTRAINT commitments_rescheduled_not_self CHECK (rescheduled_from <> id);

-- The origin stays as written, the successor's link included.
CREATE OR REPLACE FUNCTION commitments_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.id, NEW.body, NEW.conversation_id, NEW.task_id, NEW.approval_id, NEW.created_at, NEW.rescheduled_from)
     IS DISTINCT FROM (OLD.id, OLD.body, OLD.conversation_id, OLD.task_id, OLD.approval_id, OLD.created_at, OLD.rescheduled_from) THEN
    RAISE EXCEPTION 'commitment %: its text and origin never change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.label < OLD.label THEN
    RAISE EXCEPTION 'commitment %: the label cannot go down', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- The ticker of D-149 looks for its `schedule.fired` events; the routines of
-- D-110 will add more of them, so the search no longer scans the table.
CREATE INDEX events_schedule_fired_idx ON events ((payload ->> 'schedule'), (payload ->> 'day')) WHERE kind = 'schedule.fired';
