-- The devices that open the chat from the phone (D-292, stage B): a device
-- paired with a code shown on the Mac, its passkeys, and its sessions. See
-- docs/DATA-MODEL.md and docs/SECURITY.md.
-- Object names are never schema-qualified.
--
-- Nothing here is a secret that opens anything by itself: a credential holds
-- the PUBLIC key of a passkey (the private one never leaves the phone), and a
-- session holds only the sha256 of its cookie. The name of a device is text
-- of the user (L1): it is shown in Impostazioni → Dispositivi, never written
-- in events or logs, where a device is its id only.
--
-- Never deleted: the application role deletes nothing (D-046). «Scollega»
-- sets revoked_at on the device, its credentials and its sessions at once,
-- and nothing un-revokes them.

CREATE TABLE remote_devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60 AND name !~ '[[:cntrl:]]'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE remote_credentials (
  id            bigserial PRIMARY KEY,
  device_id     uuid NOT NULL REFERENCES remote_devices (id),
  -- The credential id the authenticator chose (WebAuthn: at most 1023 bytes).
  credential_id bytea NOT NULL UNIQUE CHECK (octet_length(credential_id) BETWEEN 16 AND 1023),
  -- The public key as SubjectPublicKeyInfo (DER), and its COSE algorithm: ES256 (-7) or RS256 (-257).
  public_key    bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 64 AND 2048),
  algorithm     integer NOT NULL CHECK (algorithm IN (-7, -257)),
  sign_count    bigint NOT NULL DEFAULT 0 CHECK (sign_count BETWEEN 0 AND 4294967295),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

CREATE TABLE remote_sessions (
  id           bigserial PRIMARY KEY,
  device_id    uuid NOT NULL REFERENCES remote_devices (id),
  -- sha256 of the cookie: the cookie itself is never stored.
  token_hash   bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  -- 12 hours at most from the start, whatever the core asks.
  expires_at   timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '12 hours'),
  revoked_at   timestamptz
);

CREATE INDEX remote_credentials_device_idx ON remote_credentials (device_id);
CREATE INDEX remote_sessions_device_idx ON remote_sessions (device_id);

-- What an update may change: a revocation stays, the key and the device of a
-- credential never change, its counter never goes back, a session never
-- moves its start, its end or its device.
CREATE FUNCTION remote_devices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'remote_devices_guard: a revoked device stays revoked';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'remote_devices_guard: id and created_at never change';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER remote_devices_guard BEFORE UPDATE ON remote_devices
  FOR EACH ROW EXECUTE FUNCTION remote_devices_guard();

CREATE FUNCTION remote_credentials_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'remote_credentials_guard: a revoked credential stays revoked';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
     OR NEW.public_key IS DISTINCT FROM OLD.public_key OR NEW.algorithm IS DISTINCT FROM OLD.algorithm OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'remote_credentials_guard: only the counter, the last use and the revocation change';
  END IF;
  IF NEW.sign_count < OLD.sign_count THEN
    RAISE EXCEPTION 'remote_credentials_guard: the counter never goes back';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER remote_credentials_guard BEFORE UPDATE ON remote_credentials
  FOR EACH ROW EXECUTE FUNCTION remote_credentials_guard();

CREATE FUNCTION remote_sessions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'remote_sessions_guard: a revoked session stays revoked';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'remote_sessions_guard: only the last use and the revocation change';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER remote_sessions_guard BEFORE UPDATE ON remote_sessions
  FOR EACH ROW EXECUTE FUNCTION remote_sessions_guard();

-- A credential or a session of a revoked device is born revoked: never a way back in.
CREATE FUNCTION remote_device_live() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT FROM remote_devices d WHERE d.id = NEW.device_id AND d.revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'remote_device_live: the device is unlinked';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER remote_credentials_live BEFORE INSERT ON remote_credentials
  FOR EACH ROW EXECUTE FUNCTION remote_device_live();
CREATE TRIGGER remote_sessions_live BEFORE INSERT ON remote_sessions
  FOR EACH ROW EXECUTE FUNCTION remote_device_live();

GRANT SELECT, INSERT, UPDATE ON remote_devices, remote_credentials, remote_sessions TO arianna_app;
GRANT USAGE ON SEQUENCE remote_credentials_id_seq, remote_sessions_id_seq TO arianna_app;

-- The push subscription of a paired phone knows its device: «Scollega» stops its notices too.
ALTER TABLE push_subscriptions ADD COLUMN device_id uuid REFERENCES remote_devices (id);
CREATE TRIGGER push_subscriptions_device_live BEFORE INSERT OR UPDATE OF device_id ON push_subscriptions
  FOR EACH ROW WHEN (NEW.device_id IS NOT NULL) EXECUTE FUNCTION remote_device_live();
