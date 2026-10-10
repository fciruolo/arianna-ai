-- The money of an IM in an invoice never changes, in the database too (D-169,
-- from the review of P4d): the exception and "non fatturato" of an IM stay
-- as they were while it is in its invoice, so the total of an invoice already
-- registered never changes behind the user. The rest of the guard is the one
-- of 0049_im_billing.sql. See docs/DATA-MODEL.md.

CREATE OR REPLACE FUNCTION im_billing_guard() RETURNS trigger
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
    IF OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id
       AND (NEW.override_cents, NEW.not_billed) IS DISTINCT FROM (OLD.override_cents, OLD.not_billed) THEN
      RAISE EXCEPTION 'IM billing %/%: in an invoice, its money never changes', OLD.project, OLD.im USING ERRCODE = 'restrict_violation';
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
