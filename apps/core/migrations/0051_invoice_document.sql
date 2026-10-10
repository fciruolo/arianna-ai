-- The client dashboard (I-16 tappa C3, D-170): an invoice registered by the
-- user gets the total of the document as it is on the invoice (VAT,
-- withholding and stamp included), which the dashboard adds up, and an
-- optional due date written by hand over the one computed from the payment
-- terms of the client. Both private (L2) like the rest of im_invoices; NULL
-- for the invoices registered before (the dashboard counts their taxable
-- amount and says so). See docs/DATA-MODEL.md.

ALTER TABLE im_invoices
  ADD COLUMN document_cents bigint CHECK (document_cents BETWEEN 0 AND 100000000),
  ADD COLUMN due_on date;
