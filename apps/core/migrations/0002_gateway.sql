-- Task 1.2: approvals, label changes and the gateway log. See docs/DATA-MODEL.md
-- and docs/PRIVACY-POLICY-SPEC.md. Object names are never schema-qualified.
-- The checks repeat rules of packages/policy as defense in depth: a bug in the
-- code must not be able to write a row that the policy would never allow.

CREATE FUNCTION append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- ---------------------------------------------------------------------------
-- approvals: what waits for the user ("Attende te"). Decided once, then frozen.
-- ---------------------------------------------------------------------------

CREATE TABLE approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Optional: settings and declassifications may have no task.
  task_id      uuid REFERENCES tasks (id),
  kind         text NOT NULL CHECK (kind IN ('action', 'declassify', 'budget', 'setting')),
  action       text NOT NULL CHECK (action <> ''),
  -- For declassify: the exact text, its sha256 and both labels.
  detail       jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  state        text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_via  text CHECK (decided_via IN ('web', 'telegram', 'phone')),
  CONSTRAINT approvals_decided_at CHECK ((state = 'pending') = (decided_at IS NULL)),
  -- Approving or rejecting is the user's act, through a channel; expiry is not.
  CONSTRAINT approvals_decided_via CHECK ((state IN ('approved', 'rejected')) = (decided_via IS NOT NULL)),
  -- The card of a declassification shows the exact text, which may be L2: only
  -- the web chat (local, over the VPN) can show it, so only there can it be decided.
  CONSTRAINT approvals_declassify_via_web CHECK (kind <> 'declassify' OR decided_via IS NULL OR decided_via = 'web'),
  -- A declassification lowers L2 to L1 or L0, or L1 to L0. L3 is never declassified.
  -- The hash is the hash of the text the user sees: approving one text cannot cover another.
  -- A missing field makes the expression NULL, which a CHECK would let through: coalesce.
  CONSTRAINT approvals_declassify_detail CHECK (
    kind <> 'declassify' OR coalesce(
      jsonb_typeof(detail -> 'text') = 'string'
      AND detail ->> 'sha256' = encode(sha256(convert_to(detail ->> 'text', 'UTF8')), 'hex')
      AND detail ->> 'from' IN ('L1', 'L2')
      AND detail ->> 'to' IN ('L0', 'L1')
      AND NOT (detail ->> 'from' = 'L1' AND detail ->> 'to' = 'L1'),
      false
    )
  )
);

CREATE INDEX approvals_pending_idx ON approvals (requested_at) WHERE state = 'pending';

CREATE FUNCTION approvals_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'approval % is already %', OLD.id, OLD.state USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.task_id, NEW.kind, NEW.action, NEW.detail, NEW.requested_at)
     IS DISTINCT FROM (OLD.id, OLD.task_id, OLD.kind, OLD.action, OLD.detail, OLD.requested_at) THEN
    RAISE EXCEPTION 'approval %: only the decision can change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER approvals_guard BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION approvals_guard();

CREATE TRIGGER approvals_append_only BEFORE DELETE OR TRUNCATE ON approvals
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- ---------------------------------------------------------------------------
-- label_changes: every change of label. Lowering needs an approved declassify
-- approval for the same text and the same two labels.
-- ---------------------------------------------------------------------------

CREATE TABLE label_changes (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  -- e.g. content:<sha256>, document:<id>, task:<id>
  subject     text NOT NULL CHECK (subject <> ''),
  from_label  privacy_label NOT NULL,
  to_label    privacy_label NOT NULL,
  approval_id uuid REFERENCES approvals (id),
  -- An approval is used once: approving a text lets it out once, not forever.
  CONSTRAINT label_changes_approval_used_once UNIQUE (approval_id),
  CONSTRAINT label_changes_is_a_change CHECK (to_label <> from_label),
  CONSTRAINT label_changes_lowering_approved CHECK (to_label > from_label OR approval_id IS NOT NULL)
);

CREATE FUNCTION label_changes_check_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  a approvals;
BEGIN
  -- Raising needs no approval; an unchanged label is left to label_changes_is_a_change.
  IF NEW.to_label >= NEW.from_label THEN
    RETURN NEW;
  END IF;
  SELECT * INTO a FROM approvals WHERE id = NEW.approval_id;
  IF a.id IS NULL OR a.kind <> 'declassify' OR a.state <> 'approved'
     OR NEW.subject IS DISTINCT FROM 'content:' || (a.detail ->> 'sha256')
     OR NEW.from_label::text IS DISTINCT FROM a.detail ->> 'from'
     OR NEW.to_label::text IS DISTINCT FROM a.detail ->> 'to' THEN
    RAISE EXCEPTION 'lowering % from % to % is not covered by an approved declassify approval',
      NEW.subject, NEW.from_label, NEW.to_label
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER label_changes_check_approval BEFORE INSERT ON label_changes
  FOR EACH ROW EXECUTE FUNCTION label_changes_check_approval();

CREATE TRIGGER label_changes_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON label_changes
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- ---------------------------------------------------------------------------
-- gateway_log: every decision of the gateway, written before anything is sent.
-- ---------------------------------------------------------------------------

CREATE TABLE gateway_log (
  id             bigserial PRIMARY KEY,
  ts             timestamptz NOT NULL DEFAULT now(),
  task_id        uuid,
  run_id         uuid,
  target_kind    text NOT NULL CHECK (target_kind IN ('executor', 'channel', 'web')),
  target         text NOT NULL CHECK (target <> ''),
  locality       text NOT NULL CHECK (locality IN ('local', 'cloud')),
  -- Highest label in the payload.
  label          privacy_label NOT NULL,
  decision       text NOT NULL CHECK (decision IN ('allow', 'block')),
  rule           text NOT NULL CHECK (rule <> ''),
  -- Labels and rules only, never content.
  reason         text NOT NULL CHECK (reason <> ''),
  bytes_out      integer CHECK (bytes_out >= 0),
  payload_sha256 text CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  -- A short description of what left; only for allowed payloads up to L1.
  summary        text,
  CONSTRAINT gateway_log_no_secret_out CHECK (decision = 'block' OR label <> 'L3'),
  CONSTRAINT gateway_log_cloud_up_to_l1 CHECK (decision = 'block' OR locality = 'local' OR label <= 'L1'),
  CONSTRAINT gateway_log_summary_only_l1 CHECK (summary IS NULL OR (decision = 'allow' AND label <= 'L1'))
);

CREATE INDEX gateway_log_task_id_idx ON gateway_log (task_id) WHERE task_id IS NOT NULL;

CREATE TRIGGER gateway_log_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON gateway_log
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();
