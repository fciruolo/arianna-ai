-- Nothing is written for a task of a deleted conversation (D-136, review of
-- I-4). See docs/DATA-MODEL.md. Object names are never schema-qualified.
--
-- A step still at work when its conversation is purged (an incognito closed
-- while the Coder ran, or a step that ignored the stop) could write its brief,
-- its report or its turn after the purge: messages, summaries and activity
-- lines already refuse a deleted conversation (0012, 0018, 0021), delegations
-- and turns did not. Now they do, on insert and on update. The purge deletes
-- their rows: a delete is not affected.

CREATE FUNCTION task_text_not_purged() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (
    SELECT FROM tasks t JOIN conversations c ON c.id = t.conversation_id
    WHERE t.id = NEW.task_id AND c.purged_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION '%: the conversation of task % was deleted', TG_TABLE_NAME, NEW.task_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER task_delegations_not_purged BEFORE INSERT OR UPDATE ON task_delegations
  FOR EACH ROW EXECUTE FUNCTION task_text_not_purged();

-- Insert only: task_turns is append-only (0008, task_turns_append_only refuses an update).
CREATE TRIGGER task_turns_not_purged BEFORE INSERT ON task_turns
  FOR EACH ROW EXECUTE FUNCTION task_text_not_purged();
