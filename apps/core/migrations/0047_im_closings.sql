-- The closing of an IM (D-167, I-11 tappa P4b): once the meeting of an IM is
-- over (the moved call, else the date), the core asks in the secretary
-- conversation, item by item, whether the open items are finished. One row
-- per IM of a project: the question is asked once, and the row says whether
-- the closing is still waiting for the user ("Attende te"). The items stay in
-- the file IM-<n>.md of the project, never here. See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

CREATE TABLE im_closings (
  id          bigserial PRIMARY KEY,
  -- A [[project]] name and the number of its IM: names only, no content.
  project     text NOT NULL CHECK (project ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$'),
  im          integer NOT NULL CHECK (im BETWEEN 1 AND 999999),
  -- The message of Arianna that asks; NULL when the IM had nothing open and was closed at once.
  message_id  bigint REFERENCES messages (id) ON DELETE SET NULL,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  UNIQUE (project, im),
  CONSTRAINT im_closings_closed_after CHECK (closed_at IS NULL OR closed_at >= opened_at)
);
CREATE INDEX im_closings_open_idx ON im_closings (opened_at) WHERE closed_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON im_closings TO arianna_app;
GRANT USAGE ON SEQUENCE im_closings_id_seq TO arianna_app;

-- approvals of kind `im` (D-167, P4b): `im.add` asked from a step that read
-- more than the target IM holds (a private conversation, the secretary). The
-- detail holds the project, the IM resolved when it was asked (number and
-- date) and the exact title, the user's words: L2 at least, shown and decided
-- only in the web chat. Approved, the core writes that title in that IM; at
-- most one pending confirmation per step of a task.
ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('action', 'declassify', 'budget', 'setting', 'workspace', 'commitment', 'plan', 'executor', 'im'));
ALTER TABLE approvals ADD CONSTRAINT approvals_im_fields
  CHECK (kind <> 'im' OR (action = 'im.add' AND label >= 'L2' AND task_id IS NOT NULL));
ALTER TABLE approvals ADD CONSTRAINT approvals_im_via_web
  CHECK (kind <> 'im' OR decided_via IS NULL OR decided_via = 'web');
CREATE UNIQUE INDEX approvals_im_pending_step_idx ON approvals (task_id, (detail ->> 'step')) WHERE kind = 'im' AND state = 'pending';
