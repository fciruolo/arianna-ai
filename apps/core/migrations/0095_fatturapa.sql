-- FatturaPA invoices and their deadlines (D-310): the invoices read from the
-- XML (or from a signed .xml.p7m) the user chooses in the page «Finanze»,
-- their lines, and the instalments to pay with their due day, which make the
-- deadlines list. See docs/DATA-MODEL.md and docs/FINANCE-API.md. Object
-- names are never schema-qualified.
--
-- Everything here is the user's and private (L2 at least): it stays on this
-- machine, read only by the page of the web chat; no model, executor or
-- channel reads it. The file itself is never stored: only what is read
-- from it, with the name the user chose. What the file says never changes;
-- only the day an instalment was paid does. An invoice the user removes goes
-- only through fatturapa_delete, which runs as the owner like finance_delete
-- (D-157): arianna_app has no DELETE (D-046).

CREATE TABLE fatturapa_invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- sha256 of supplier, document type, number and day (@arianna/invoices): the same invoice is one row.
  fingerprint        text NOT NULL UNIQUE CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  -- The name of the file the user chose; the file itself is not kept.
  file_name          text NOT NULL CHECK (btrim(file_name) <> '' AND length(file_name) <= 255 AND file_name !~ '[\r\n]'),
  -- Read from a signed envelope (.p7m); the signature is not checked.
  signed             boolean NOT NULL,
  format             text NOT NULL CHECK (format IN ('FPR12', 'FPA12')),
  document_type      text NOT NULL CHECK (document_type ~ '^TD[0-9]{2}$'),
  number             text NOT NULL CHECK (btrim(number) <> '' AND length(number) <= 20 AND number !~ '[\r\n]'),
  issued_on          date NOT NULL,
  currency           text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Integer cents. ImportoTotaleDocumento is optional in FatturaPA.
  total_cents        bigint,
  taxable_cents      bigint NOT NULL,
  vat_cents          bigint NOT NULL,
  -- DatiRiepilogo: [{ vatRate, nature, taxableCents, vatCents }].
  vat_summary        jsonb NOT NULL CHECK (jsonb_typeof(vat_summary) = 'array' AND length(vat_summary::text) <= 500000),
  supplier_name      text NOT NULL CHECK (btrim(supplier_name) <> '' AND length(supplier_name) <= 200 AND supplier_name !~ '[\r\n]'),
  supplier_vat       text CHECK (supplier_vat ~ '^[A-Z]{2}[A-Z0-9]{1,28}$'),
  supplier_tax_code  text CHECK (supplier_tax_code ~ '^[A-Z0-9]{11,16}$'),
  customer_name      text NOT NULL CHECK (btrim(customer_name) <> '' AND length(customer_name) <= 200 AND customer_name !~ '[\r\n]'),
  customer_vat       text CHECK (customer_vat ~ '^[A-Z]{2}[A-Z0-9]{1,28}$'),
  customer_tax_code  text CHECK (customer_tax_code ~ '^[A-Z0-9]{11,16}$'),
  label              privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fatturapa_invoices_supplier_id CHECK (supplier_vat IS NOT NULL OR supplier_tax_code IS NOT NULL),
  CONSTRAINT fatturapa_invoices_customer_id CHECK (customer_vat IS NOT NULL OR customer_tax_code IS NOT NULL)
);

CREATE INDEX fatturapa_invoices_issued_idx ON fatturapa_invoices (issued_on DESC, created_at DESC);

CREATE TABLE fatturapa_lines (
  invoice_id   uuid NOT NULL REFERENCES fatturapa_invoices (id) ON DELETE CASCADE,
  -- The order in the file, from 0.
  position     integer NOT NULL CHECK (position >= 0),
  line_no      integer NOT NULL CHECK (line_no BETWEEN 0 AND 9999),
  description  text NOT NULL CHECK (btrim(description) <> '' AND length(description) <= 1000),
  -- Decimals as written in the file (up to 8 places).
  quantity     text CHECK (quantity ~ '^-?[0-9]{1,15}(\.[0-9]{1,8})?$'),
  unit_price   text NOT NULL CHECK (unit_price ~ '^-?[0-9]{1,15}(\.[0-9]{1,8})?$'),
  total_cents  bigint NOT NULL,
  vat_rate     numeric(5, 2) NOT NULL CHECK (vat_rate BETWEEN 0 AND 100),
  nature       text CHECK (nature ~ '^N[1-7](\.[1-6])?$'),
  label        privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  PRIMARY KEY (invoice_id, position)
);

CREATE TABLE fatturapa_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    uuid NOT NULL REFERENCES fatturapa_invoices (id) ON DELETE CASCADE,
  position      integer NOT NULL CHECK (position >= 0),
  -- ModalitaPagamento, MP01-MP23.
  method        text NOT NULL CHECK (method ~ '^MP[0-9]{2}$'),
  -- DataScadenzaPagamento; NULL when the invoice gives none.
  due_on        date,
  amount_cents  bigint NOT NULL,
  -- The day the user marked it paid; NULL while it is open.
  paid_on       date,
  label         privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, position)
);

CREATE INDEX fatturapa_payments_open_idx ON fatturapa_payments (due_on) WHERE paid_on IS NULL;
CREATE INDEX fatturapa_payments_invoice_idx ON fatturapa_payments (invoice_id);

-- What the file said never changes (arianna_app has no UPDATE on these: defense in depth).
CREATE FUNCTION fatturapa_invoices_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION '%: what the invoice says never changes', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER fatturapa_invoices_frozen BEFORE UPDATE ON fatturapa_invoices
  FOR EACH ROW EXECUTE FUNCTION fatturapa_invoices_frozen();
CREATE TRIGGER fatturapa_lines_frozen BEFORE UPDATE ON fatturapa_lines
  FOR EACH ROW EXECUTE FUNCTION fatturapa_invoices_frozen();

-- An instalment is what the invoice wrote: only the day it was paid changes, and the label only goes up.
CREATE FUNCTION fatturapa_payments_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.id, NEW.invoice_id, NEW.position, NEW.method, NEW.due_on, NEW.amount_cents, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.invoice_id, OLD.position, OLD.method, OLD.due_on, OLD.amount_cents, OLD.created_at) THEN
    RAISE EXCEPTION 'invoice instalment %: only the day it was paid changes', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.label < OLD.label THEN
    RAISE EXCEPTION 'invoice instalment %: the label cannot go down', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fatturapa_payments_guard BEFORE UPDATE ON fatturapa_payments
  FOR EACH ROW EXECUTE FUNCTION fatturapa_payments_guard();

-- ---------------------------------------------------------------------------
-- fatturapa_delete: an invoice the user removes, with its lines and
-- instalments. Runs as the owner (arianna_app has no DELETE). No such
-- invoice: P0002.
-- ---------------------------------------------------------------------------

CREATE FUNCTION fatturapa_delete(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout = '5s' AS $$
BEGIN
  DELETE FROM fatturapa_invoices WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice % does not exist', p_id USING ERRCODE = 'no_data_found';
  END IF;
END
$$;

-- The schema of this migration, then pg_temp last, as erase_conversation (0043).
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION fatturapa_delete(uuid) SET search_path = %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON FUNCTION fatturapa_delete(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fatturapa_delete(uuid) TO arianna_app;

-- The core writes what it read and the day an instalment was paid; what goes away goes through fatturapa_delete.
GRANT SELECT, INSERT ON fatturapa_invoices, fatturapa_lines TO arianna_app;
GRANT SELECT, INSERT, UPDATE ON fatturapa_payments TO arianna_app;
