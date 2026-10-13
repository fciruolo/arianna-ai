-- I-18, D-183: corrections of the finance mark after the review of 0056.
--
-- 1. A task born marked (in a marked conversation, or from a marked parent)
--    marks its conversation too, not only a task marked later: the trigger
--    runs AFTER INSERT as well.
-- 2. The system chats about a task (D-064, origin 'system', source_task_id)
--    are marked with it: one opened before the task read finance data holds
--    its question and its errors, and is reopened by openFailureChat.

CREATE OR REPLACE FUNCTION tasks_finance_to_conversation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.finance AND (TG_OP = 'INSERT' OR NOT OLD.finance) THEN
    UPDATE conversations SET finance = true, effective_label = 'L2'
    WHERE NOT finance AND (id = NEW.conversation_id OR source_task_id = NEW.id);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER tasks_finance_to_conversation_insert AFTER INSERT ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_finance_to_conversation();
