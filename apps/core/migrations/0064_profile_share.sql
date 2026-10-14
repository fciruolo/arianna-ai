-- «Su di te», tappe C e D (D-114, D-213): one fact at a time towards the
-- cloud, and the facts Arianna proposes. See docs/DATA-MODEL.md. Object names
-- are never schema-qualified.
--
-- profile.share (tappa C) asks the user to let the exact text of one fact out
-- once, to one agent: an approval of kind `declassify` with action
-- `share_fact`, decided in the web chat only (approvals_declassify_via_web of
-- 0002), whose detail adds topic, agent and reason to the text, its sha256
-- and the two labels. The core uses it once, for the next delegation of the
-- same task to that agent: the label_changes row (used once, 0002) and the
-- row of delegation_facts are written in the same transaction. The text
-- stays in the approval only, never in delegation_facts nor in the events.
--
-- profile.propose (tappa D) asks the user to remember a fact Arianna heard in
-- the conversation: an approval of kind `fact`, decided in the web chat only;
-- approved, the core writes the fact "Solo in casa" (L2) with the decision.

-- The purge of a conversation (0012) blanks the detail of its approvals and
-- marks it `purged`: such a detail has no fields left, as for every kind.
ALTER TABLE approvals ADD CONSTRAINT approvals_share_fact_fields
  CHECK (action <> 'share_fact' OR (
    kind = 'declassify' AND task_id IS NOT NULL AND (
      coalesce(detail -> 'purged' = 'true'::jsonb, false) OR (
        coalesce(jsonb_typeof(detail -> 'topic') = 'string', false) AND coalesce(jsonb_typeof(detail -> 'agent') = 'string', false)
        AND coalesce(jsonb_typeof(detail -> 'reason') = 'string', false)
      )
    )
  ));

ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check
  CHECK (kind IN ('action', 'declassify', 'budget', 'setting', 'workspace', 'commitment', 'plan', 'executor', 'im', 'fact'));
ALTER TABLE approvals ADD CONSTRAINT approvals_fact_fields
  CHECK (kind <> 'fact' OR (
    action = 'profile.propose' AND label >= 'L2' AND task_id IS NOT NULL AND (
      coalesce(detail -> 'purged' = 'true'::jsonb, false)
      OR (coalesce(jsonb_typeof(detail -> 'topic') = 'string', false) AND coalesce(jsonb_typeof(detail -> 'text') = 'string', false))
    )
  ));
ALTER TABLE approvals ADD CONSTRAINT approvals_fact_via_web
  CHECK (kind <> 'fact' OR decided_via IS NULL OR decided_via = 'web');

-- The facts shared with a delegation: which approval, never the text.
-- Deleted only with its delegation or its approval (the purge and the erase of
-- a conversation, 0012, 0031, 0043): arianna_app never updates nor deletes it.
CREATE TABLE delegation_facts (
  delegation_id bigint NOT NULL REFERENCES task_delegations (id) ON DELETE CASCADE,
  approval_id   uuid NOT NULL REFERENCES approvals (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (delegation_id, approval_id),
  -- One fact shared once: an approval goes with one delegation only.
  CONSTRAINT delegation_facts_approval_once UNIQUE (approval_id)
);

CREATE FUNCTION delegation_facts_check() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- An approved share of the delegation's own task and agent, lowered in this
  -- very transaction (its label_changes row, written once).
  IF NOT EXISTS (
    SELECT 1 FROM approvals a
      JOIN task_delegations d ON d.id = NEW.delegation_id
      JOIN label_changes c ON c.approval_id = a.id
    WHERE a.id = NEW.approval_id AND a.kind = 'declassify' AND a.action = 'share_fact'
      AND a.state = 'approved' AND a.decided_via = 'web'
      AND a.task_id = d.task_id AND a.detail ->> 'agent' = d.agent
      AND c.ts = now()
  ) THEN
    RAISE EXCEPTION 'delegation %: approval % is not an approved share of a fact for it', NEW.delegation_id, NEW.approval_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER delegation_facts_check BEFORE INSERT ON delegation_facts
  FOR EACH ROW EXECUTE FUNCTION delegation_facts_check();

GRANT SELECT, INSERT ON delegation_facts TO arianna_app;

-- A fact becomes "Condivisibile" only with the declassification of the page
-- (action `declassify`, 0061), never with a share of one fact to one agent:
-- that one lets the text out once, it does not lower the fact.
CREATE OR REPLACE FUNCTION user_facts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'user fact %: id and created_at never change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.label = 'L2' AND NEW.label = 'L1' AND NOT EXISTS (
    SELECT 1 FROM label_changes c JOIN approvals a ON a.id = c.approval_id
    WHERE c.subject = 'content:' || encode(sha256(convert_to(NEW.text, 'UTF8')), 'hex')
      AND c.from_label = 'L2' AND c.to_label = 'L1' AND c.ts = now()
      AND a.kind = 'declassify' AND a.action = 'declassify' AND a.state = 'approved' AND a.decided_via = 'web'
  ) THEN
    RAISE EXCEPTION 'user fact %: lowering to L1 needs an approved declassification of its text', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
