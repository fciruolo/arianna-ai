-- The style and the skills chosen in the Studio (I-19, D-184): a message of
-- the direct chat with the Designer carries them on its task, as a Designer
-- card does (D-163). See docs/DATA-MODEL.md. Object names are never
-- schema-qualified.
--
-- 0046 allowed design_style and design_skills only on a card (no
-- conversation). Now also on a task of a conversation whose agent is the
-- Designer: a CHECK cannot read conversations, so a trigger does, and
-- conversations.agent never changes (conversations_agent_fixed of 0027).
-- That a card is the Designer's stays a rule of the code, as before.

ALTER TABLE tasks DROP CONSTRAINT tasks_design_only_cards;

CREATE FUNCTION tasks_design_only_designer() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.design_style IS NOT NULL OR cardinality(NEW.design_skills) > 0)
     AND NEW.conversation_id IS NOT NULL
     AND NOT EXISTS (SELECT FROM conversations c WHERE c.id = NEW.conversation_id AND c.agent = 'designer') THEN
    RAISE EXCEPTION 'tasks_design_only_designer: a style or skills only on a card or in the direct chat with the Designer'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tasks_design_only_designer BEFORE INSERT OR UPDATE OF design_style, design_skills, conversation_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_design_only_designer();
