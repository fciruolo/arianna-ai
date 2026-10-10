-- The documents of a client (I-16 tappa C2, D-171): contracts, signed
-- quotes, NDA, orders and other files, in the private folder of the client
-- on this machine (data/clients/<client>/documenti/<id>.<ext>). Here only
-- what describes them; the bytes stay in the file, checked against sha256.
-- Private (L2 at least): never to the Coder, Claude, Codex or Telegram, never
-- indexed. The core never deletes (D-046): a document is archived.
-- See docs/DATA-MODEL.md.

CREATE TABLE client_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES clients (id),
  -- The legal ones from a fixed list; `other` with a free type (brochure, materiali…).
  kind         text NOT NULL CHECK (kind IN ('contract', 'signed_quote', 'nda', 'order', 'other')),
  other_type   text CHECK (btrim(other_type) <> '' AND length(other_type) <= 60),
  name         text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200),
  project      text CHECK (project ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$'),
  document_on  date,
  expires_on   date,
  -- The morning the secretary named its due date (30 days before), once.
  reminded_on  date,
  extension    text NOT NULL CHECK (extension ~ '^[a-z0-9]{1,5}$'),
  media_type   text NOT NULL CHECK (length(media_type) <= 120),
  size_bytes   bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 26214400),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  label        privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  CONSTRAINT client_documents_other CHECK ((kind = 'other') OR other_type IS NULL)
);

CREATE INDEX client_documents_client_idx ON client_documents (client_id, created_at DESC);
CREATE INDEX client_documents_expiry_idx ON client_documents (expires_on) WHERE archived_at IS NULL AND expires_on IS NOT NULL;

-- The file of a document never changes: client, bytes, extension and birth stay; the label only goes up.
CREATE FUNCTION client_documents_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.id, NEW.client_id, NEW.extension, NEW.media_type, NEW.size_bytes, NEW.sha256, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.client_id, OLD.extension, OLD.media_type, OLD.size_bytes, OLD.sha256, OLD.created_at) THEN
    RAISE EXCEPTION 'client document %: its file never changes', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.label < OLD.label THEN
    RAISE EXCEPTION 'client document %: the label cannot go down', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER client_documents_guard BEFORE UPDATE ON client_documents
  FOR EACH ROW EXECUTE FUNCTION client_documents_guard();

GRANT SELECT, INSERT, UPDATE ON client_documents TO arianna_app;
