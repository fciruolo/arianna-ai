-- «Su di te» (D-114, tappa A): the user's profile, single facts each with its
-- label, written only by the user from Settings, never by an agent. See
-- docs/DATA-MODEL.md. Object names are never schema-qualified.
--
-- topic: short, L1 by the user's declaration whatever the fact's label (it
-- may appear in a brief and in the events), unique ignoring case.
-- text: at most 300 characters.
-- label: L1 "Condivisibile" or L2 "Solo in casa" (the default); L3 never
-- enters the profile.
--
-- Lowering a fact by UPDATE (L2 → L1) is a declassification: allowed only in
-- the transaction that wrote its label_changes row for this exact text
-- (content:<sha256>, L2 → L1) with a declassify approval decided in the web
-- chat. Raising is immediate. A new fact may be L1 from the start (the
-- user's declaration, checked by the core). The approval keeps the text it
-- approved, as every declassify does (append-only), even after the fact
-- changes or is deleted.

CREATE TABLE user_facts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic      text NOT NULL CHECK (btrim(topic) <> '' AND length(topic) <= 60 AND topic !~ '[[:cntrl:]]'),
  text       text NOT NULL CHECK (btrim(text) <> '' AND length(text) <= 300),
  label      privacy_label NOT NULL DEFAULT 'L2' CHECK (label IN ('L1', 'L2')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_facts_topic_idx ON user_facts (lower(topic));

CREATE FUNCTION user_facts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'user fact %: id and created_at never change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.label = 'L2' AND NEW.label = 'L1' AND NOT EXISTS (
    SELECT 1 FROM label_changes c JOIN approvals a ON a.id = c.approval_id
    WHERE c.subject = 'content:' || encode(sha256(convert_to(NEW.text, 'UTF8')), 'hex')
      AND c.from_label = 'L2' AND c.to_label = 'L1' AND c.ts = now()
      AND a.kind = 'declassify' AND a.state = 'approved' AND a.decided_via = 'web'
  ) THEN
    RAISE EXCEPTION 'user fact %: lowering to L1 needs an approved declassification of its text', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER user_facts_guard BEFORE UPDATE ON user_facts
  FOR EACH ROW EXECUTE FUNCTION user_facts_guard();

-- arianna_app has no DELETE anywhere (0007): a fact is deleted by this
-- function, one at a time. No such fact: P0002.
CREATE FUNCTION user_fact_delete(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout = '5s' AS $$
BEGIN
  DELETE FROM user_facts WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user fact % does not exist', p_id USING ERRCODE = 'no_data_found';
  END IF;
END
$$;

-- The schema of this migration, then pg_temp last, as finance_delete (0056).
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION user_fact_delete(uuid) SET search_path = %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON FUNCTION user_fact_delete(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_fact_delete(uuid) TO arianna_app;

GRANT SELECT, INSERT, UPDATE ON user_facts TO arianna_app;
