-- conversations.series_character (D-225, tappa B): the person of the series
-- the user chose in «Nuova conversazione» to chat with. Such a conversation is
-- the plain chat with Claude (0063: agent 'claude', work, no project) played
-- by that character; NULL in every other conversation. Only the id of the
-- character (a key of SERIES_PERSONAS of @arianna/agents, as the ids of the
-- packs, D-060), never content. See docs/DATA-MODEL.md. Object names are never
-- schema-qualified.
--
-- A private conversation never has it, whatever the core does: Claude answers
-- only a work conversation (L1), and the character is chosen at creation and
-- never changes (as who answers, conversations_agent_fixed of 0027): switching
-- in the middle would let the session of one character go on as another.
--
-- No new grant: arianna_app inserts and updates conversations at table level
-- since 0007; this trigger freezes the column.

ALTER TABLE conversations ADD COLUMN series_character text;
ALTER TABLE conversations ADD CONSTRAINT conversations_series_character_id
  CHECK (series_character IS NULL OR series_character ~ '^[a-z0-9][a-z0-9_-]{0,63}$');
ALTER TABLE conversations ADD CONSTRAINT conversations_series_character_claude
  CHECK (series_character IS NULL OR (agent IS NOT DISTINCT FROM 'claude' AND mode = 'work' AND workspace IS NULL AND origin = 'user' AND NOT incognito));

CREATE FUNCTION conversations_series_character_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.series_character IS DISTINCT FROM OLD.series_character THEN
    RAISE EXCEPTION 'conversation %: the character is chosen at creation and never changes', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversations_series_character_fixed BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_series_character_fixed();
