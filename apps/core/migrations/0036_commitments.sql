-- The secretary (I-12, D-144, tappa S1): the commitments the user tells
-- Arianna, each with its day, and the private conversation where they are
-- told. See docs/DATA-MODEL.md. Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- conversations.secretary: the conversation of the "Segretaria" button. One
-- only, which goes on in time: private, opened by the user, answered by
-- Arianna, never incognito nor a trial chat, never archived (so never
-- purged). Chosen at creation, never changed.
-- ---------------------------------------------------------------------------

ALTER TABLE conversations ADD COLUMN secretary boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD CONSTRAINT conversations_secretary_fields
  CHECK (NOT secretary OR (mode = 'private' AND origin = 'user' AND agent IS NULL AND NOT incognito AND trial_model IS NULL AND archived_at IS NULL));
CREATE UNIQUE INDEX conversations_one_secretary ON conversations (secretary) WHERE secretary AND purged_at IS NULL;

CREATE FUNCTION conversations_secretary_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.secretary IS DISTINCT FROM OLD.secretary THEN
    RAISE EXCEPTION 'conversation %: the secretary is chosen at creation and never changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER conversations_secretary_frozen BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_secretary_frozen();

-- ---------------------------------------------------------------------------
-- approvals of kind `commitment`: Arianna asks the user to confirm a
-- commitment to note (action commitment.add, with the day the core computed)
-- or one to mark done (commitment.done). The detail holds the text of the
-- commitment, private: only the web chat (local) shows it, so only there is
-- it decided, and its label is at least L2.
-- ---------------------------------------------------------------------------

ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('action', 'declassify', 'budget', 'setting', 'workspace', 'commitment'));
ALTER TABLE approvals ADD CONSTRAINT approvals_commitment_fields
  CHECK (kind <> 'commitment' OR (action IN ('commitment.add', 'commitment.done') AND label >= 'L2' AND task_id IS NOT NULL));
ALTER TABLE approvals ADD CONSTRAINT approvals_commitment_via_web
  CHECK (kind <> 'commitment' OR decided_via IS NULL OR decided_via = 'web');

-- ---------------------------------------------------------------------------
-- commitments: what the user has to do on a day, as the secretary noted it.
-- `body` is the user's text: private (L2) at least, never towards the cloud.
-- `day` is the date the core computed from the user's words (local time of
-- this machine) and the user confirmed; `at_time` only when said. `status`:
-- open, done, not_done, postponed, cancelled; `reason` why it was not done
-- (S3). `approval_id` is the confirmation that created it: once only.
-- The core never deletes (D-046).
-- ---------------------------------------------------------------------------

CREATE TABLE commitments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body             text NOT NULL CHECK (btrim(body) <> '' AND length(body) <= 500 AND strpos(body, chr(10)) = 0),
  day              date NOT NULL,
  at_time          time,
  status           text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'done', 'not_done', 'postponed', 'cancelled')),
  reason           text CHECK (reason IS NULL OR (btrim(reason) <> '' AND length(reason) <= 1000)),
  label            privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  conversation_id  uuid REFERENCES conversations (id),
  task_id          uuid REFERENCES tasks (id),
  approval_id      uuid UNIQUE REFERENCES approvals (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  done_at          timestamptz,
  CONSTRAINT commitments_done_at CHECK ((status = 'done') = (done_at IS NOT NULL))
);

CREATE INDEX commitments_open_day_idx ON commitments (day, at_time) WHERE status = 'open';

-- The text and the origin of a commitment stay as written; the label only goes up.
CREATE FUNCTION commitments_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.id, NEW.body, NEW.conversation_id, NEW.task_id, NEW.approval_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.body, OLD.conversation_id, OLD.task_id, OLD.approval_id, OLD.created_at) THEN
    RAISE EXCEPTION 'commitment %: its text and origin never change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.label < OLD.label THEN
    RAISE EXCEPTION 'commitment %: the label cannot go down', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commitments_guard BEFORE UPDATE ON commitments
  FOR EACH ROW EXECUTE FUNCTION commitments_guard();

-- The core notes, changes the status and reads; it never deletes (D-046).
GRANT SELECT, INSERT, UPDATE ON commitments TO arianna_app;
