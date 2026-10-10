-- The prices and the invoices of the IM (I-11 tappa P4d, D-167 punti 4-5,
-- D-169). See docs/DATA-MODEL.md. Object names are never schema-qualified.
--
-- Everything here is the user's and private (L2 at least): it stays on this
-- machine, never in the files IM (Interno), towards a cloud executor,
-- Telegram or the gateway. An IM is named by its project (a [[project]]
-- container, D-145) and its number, as the file `IM-<n>.md` says; the items
-- stay in the file (D-167), only money lives here. Amounts in cents.
-- The core never deletes (D-046): an invoice is cancelled with cancelled_at,
-- an IM leaves an invoice with invoice_id set back to NULL.

-- The price of one IM of the project; the currency of its amounts.
CREATE TABLE im_prices (
  project       text PRIMARY KEY CHECK (project ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$'),
  amount_cents  bigint CHECK (amount_cents BETWEEN 0 AND 100000000),
  currency      text NOT NULL DEFAULT 'EUR' CHECK (currency ~ '^[A-Z]{3}$'),
  label         privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- An invoice the user made with their own program: one project, one or more IM (D-167).
CREATE TABLE im_invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project       text NOT NULL CHECK (project ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$'),
  number        text NOT NULL CHECK (btrim(number) <> '' AND length(number) <= 40),
  issued_on     date NOT NULL,
  paid_on       date,
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  note          text CHECK (length(note) <= 2000),
  label         privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz
);

-- One number per invoice among those not cancelled ("12/2026" holds the year).
CREATE UNIQUE INDEX im_invoices_number_key ON im_invoices (lower(btrim(number))) WHERE cancelled_at IS NULL;
CREATE INDEX im_invoices_project_idx ON im_invoices (project, issued_on DESC);

-- What one IM is worth: its exception, "non fatturato", the price of the
-- project fixed when the core saw the IM closed, the invoice it went into.
CREATE TABLE im_billing (
  project          text NOT NULL CHECK (project ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$'),
  im               integer NOT NULL CHECK (im BETWEEN 1 AND 999999),
  override_cents   bigint CHECK (override_cents BETWEEN 0 AND 100000000),
  not_billed       boolean NOT NULL DEFAULT false,
  closed_cents     bigint CHECK (closed_cents BETWEEN 0 AND 100000000),
  closed_currency  text CHECK (closed_currency ~ '^[A-Z]{3}$'),
  closed_at        timestamptz,
  invoice_id       uuid REFERENCES im_invoices (id),
  label            privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project, im),
  CONSTRAINT im_billing_closed CHECK ((closed_cents IS NULL) = (closed_currency IS NULL) AND (closed_cents IS NULL) = (closed_at IS NULL)),
  CONSTRAINT im_billing_not_billed CHECK (NOT (not_billed AND invoice_id IS NOT NULL))
);

CREATE INDEX im_billing_invoice_idx ON im_billing (invoice_id) WHERE invoice_id IS NOT NULL;

-- An invoice keeps its id, project, currency and birth; once cancelled it never changes again; the label only goes up.
CREATE FUNCTION im_invoices_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.id, NEW.project, NEW.currency, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.project, OLD.currency, OLD.created_at) THEN
    RAISE EXCEPTION 'invoice %: its project, currency and birth never change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'invoice %: cancelled, it never changes', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.label < OLD.label THEN
    RAISE EXCEPTION 'invoice %: the label cannot go down', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER im_invoices_guard BEFORE UPDATE ON im_invoices
  FOR EACH ROW EXECUTE FUNCTION im_invoices_guard();

-- An IM in an invoice belongs to that project, and the price fixed at its closing never changes; the label only goes up.
CREATE FUNCTION im_billing_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  invoice_project text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.project, NEW.im) IS DISTINCT FROM (OLD.project, OLD.im) THEN
      RAISE EXCEPTION 'IM billing %/%: its project and number never change', OLD.project, OLD.im USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.closed_at IS NOT NULL AND (NEW.closed_cents, NEW.closed_currency, NEW.closed_at) IS DISTINCT FROM (OLD.closed_cents, OLD.closed_currency, OLD.closed_at) THEN
      RAISE EXCEPTION 'IM billing %/%: the price fixed at the closing never changes', OLD.project, OLD.im USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.label < OLD.label THEN
      RAISE EXCEPTION 'IM billing %/%: the label cannot go down', OLD.project, OLD.im USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.invoice_id END) THEN
    SELECT project INTO invoice_project FROM im_invoices WHERE id = NEW.invoice_id AND cancelled_at IS NULL;
    IF invoice_project IS DISTINCT FROM NEW.project THEN
      RAISE EXCEPTION 'IM billing %/%: only into an invoice of its project, not cancelled', NEW.project, NEW.im USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER im_billing_guard BEFORE INSERT OR UPDATE ON im_billing
  FOR EACH ROW EXECUTE FUNCTION im_billing_guard();

-- The core writes and reads; it never deletes (D-046).
GRANT SELECT, INSERT, UPDATE ON im_prices, im_invoices, im_billing TO arianna_app;
