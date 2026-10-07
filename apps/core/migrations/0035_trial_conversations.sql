-- The trial chat of a local model (D-142): "Prova in chat" in the card of a
-- model of the Modelli page opens a private incognito conversation where every
-- message goes to that model only, without Arianna, her tools or the archive.
-- conversations.trial_model is the catalog id (L0), chosen at creation and
-- never changed; only an incognito private conversation of the user has one.
ALTER TABLE conversations ADD COLUMN trial_model text CHECK (trial_model ~ '^[a-z0-9][a-z0-9._-]{0,254}$');
ALTER TABLE conversations ADD CONSTRAINT conversations_trial_fields
  CHECK (trial_model IS NULL OR (incognito AND mode = 'private' AND agent IS NULL));

CREATE FUNCTION conversations_trial_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.trial_model IS DISTINCT FROM OLD.trial_model THEN
    RAISE EXCEPTION 'conversation %: the model under trial is chosen at creation and never changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER conversations_trial_frozen BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_trial_frozen();
