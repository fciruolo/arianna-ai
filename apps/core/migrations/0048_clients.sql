-- The clients (I-16, D-168, tappa C1): who the user works for, with what
-- an invoice needs (Italian and foreign), the people to talk to and the
-- projects of each one. See docs/DATA-MODEL.md. Object names are never
-- schema-qualified.
--
-- Everything here is the user's and private (L2 at least): it stays on this
-- machine, never towards a cloud executor, Telegram or the gateway. The core
-- checks every field (apps/core/src/clients-format.ts); the checks below are
-- the last fence: lengths and forms, not the check digits.
-- The core never deletes (D-046): a client is archived, a contact or a
-- project link is removed with removed_at.

CREATE TABLE clients (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL DEFAULT 'company'
    CHECK (kind IN ('company', 'individual', 'freelancer', 'public_administration')),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'prospect', 'archived')),
  display_name         text NOT NULL CHECK (btrim(display_name) <> '' AND length(display_name) <= 200),
  legal_name           text CHECK (length(legal_name) <= 300),
  first_name           text CHECK (length(first_name) <= 100),
  last_name            text CHECK (length(last_name) <= 100),
  sector               text CHECK (length(sector) <= 100),
  website              text CHECK (length(website) <= 300),
  notes                text CHECK (length(notes) <= 10000),
  tags                 text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  -- Tax: ISO 3166-1 alpha-2; the area (Italia, UE, extra UE) is derived from it.
  country              text NOT NULL DEFAULT 'IT' CHECK (country ~ '^[A-Z]{2}$'),
  vat_number           text CHECK (vat_number ~ '^[0-9]{11}$'),                       -- partita IVA italiana
  tax_code             text CHECK (tax_code ~ '^([A-Z0-9]{16}|[0-9]{11})$'),          -- codice fiscale
  eu_vat_number        text CHECK (eu_vat_number ~ '^[A-Z]{2}[A-Z0-9+*]{2,13}$'),     -- with its prefix, for VIES
  foreign_tax_id       text CHECK (length(foreign_tax_id) BETWEEN 1 AND 30),
  vat_rate             numeric(5, 2) CHECK (vat_rate >= 0 AND vat_rate <= 100),
  vat_nature           text CHECK (vat_nature ~ '^N[1-7](\.[1-9])?$'),
  split_payment        boolean NOT NULL DEFAULT false,
  withholding_agent    boolean NOT NULL DEFAULT false,
  -- E-invoicing (FatturaPA, SDI)
  sdi_code             text CHECK (sdi_code ~ '^[A-Z0-9]{7}$'),
  pec                  text CHECK (length(pec) <= 254),
  ipa_code             text CHECK (ipa_code ~ '^[A-Z0-9]{6}$'),
  cig                  text CHECK (cig ~ '^[A-Z0-9]{10}$'),
  cup                  text CHECK (cup ~ '^[A-Z0-9]{15}$'),
  -- Addresses: {street, number, postalCode, city, province, country}
  registered_address   jsonb CHECK (jsonb_typeof(registered_address) = 'object' AND length(registered_address::text) <= 2000),
  billing_address      jsonb CHECK (jsonb_typeof(billing_address) = 'object' AND length(billing_address::text) <= 2000),
  shipping_address     jsonb CHECK (jsonb_typeof(shipping_address) = 'object' AND length(shipping_address::text) <= 2000),
  -- Billing
  billing_email        text CHECK (length(billing_email) <= 254),
  payment_method       text CHECK (payment_method IN ('bank_transfer', 'riba', 'card', 'paypal', 'cash', 'other')),
  payment_days         smallint CHECK (payment_days BETWEEN 0 AND 365),
  payment_end_of_month boolean NOT NULL DEFAULT false,
  currency             text NOT NULL DEFAULT 'EUR' CHECK (currency ~ '^[A-Z]{3}$'),
  invoice_language     text NOT NULL DEFAULT 'it' CHECK (invoice_language ~ '^[a-z]{2}$'),
  purchase_order       text CHECK (length(purchase_order) <= 500),
  iban                 text CHECK (iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  -- Contacts of the client as a whole; the people are in client_contacts.
  email                text CHECK (length(email) <= 254),
  phone                text CHECK (length(phone) <= 30),
  mobile               text CHECK (length(mobile) <= 30),
  -- The logo in data/clients/<id>/logo.<png|jpg|webp> (never SVG); its bytes checked against the hash.
  logo_type            text CHECK (logo_type IN ('image/png', 'image/jpeg', 'image/webp')),
  logo_sha256          text CHECK (logo_sha256 ~ '^[0-9a-f]{64}$'),
  label                privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz,
  CONSTRAINT clients_archived CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT clients_logo CHECK ((logo_type IS NULL) = (logo_sha256 IS NULL))
);

CREATE INDEX clients_name_idx ON clients (lower(display_name));
-- One client per partita IVA among those not archived.
CREATE UNIQUE INDEX clients_vat_number_key ON clients (vat_number) WHERE vat_number IS NOT NULL AND status <> 'archived';

-- The people of a client. One primary at most among those not removed.
CREATE TABLE client_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients (id),
  name        text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200),
  role        text CHECK (length(role) <= 100),
  email       text CHECK (length(email) <= 254),
  phone       text CHECK (length(phone) <= 30),
  mobile      text CHECK (length(mobile) <= 30),
  notes       text CHECK (length(notes) <= 2000),
  is_primary  boolean NOT NULL DEFAULT false,
  label       privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz
);

CREATE INDEX client_contacts_client_idx ON client_contacts (client_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX client_contacts_one_primary ON client_contacts (client_id) WHERE is_primary AND removed_at IS NULL;

-- The projects of a client: the name of a [[project]] container (D-145).
-- A project belongs to one client at most.
CREATE TABLE client_projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients (id),
  project     text NOT NULL CHECK (project ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz
);

CREATE UNIQUE INDEX client_projects_one_client ON client_projects (project) WHERE removed_at IS NULL;

-- A client keeps its id and birth; the label only goes up.
CREATE FUNCTION clients_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.id, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.created_at) THEN
    RAISE EXCEPTION 'client %: its id and birth never change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.label < OLD.label THEN
    RAISE EXCEPTION 'client %: the label cannot go down', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER clients_guard BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION clients_guard();

-- A contact keeps its client; once removed it never changes again; the label only goes up.
CREATE FUNCTION client_contacts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.id, NEW.client_id, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.client_id, OLD.created_at) THEN
    RAISE EXCEPTION 'contact %: its client and birth never change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'contact %: removed, it never changes', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.label < OLD.label THEN
    RAISE EXCEPTION 'contact %: the label cannot go down', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER client_contacts_guard BEFORE UPDATE ON client_contacts
  FOR EACH ROW EXECUTE FUNCTION client_contacts_guard();

-- A link between a client and a project: only its removal, once.
CREATE FUNCTION client_projects_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.id, NEW.client_id, NEW.project, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.client_id, OLD.project, OLD.created_at)
     OR OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL THEN
    RAISE EXCEPTION 'client project %: only its removal, once', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER client_projects_guard BEFORE UPDATE ON client_projects
  FOR EACH ROW EXECUTE FUNCTION client_projects_guard();

-- The core writes and reads; it never deletes (D-046).
GRANT SELECT, INSERT, UPDATE ON clients, client_contacts, client_projects TO arianna_app;
