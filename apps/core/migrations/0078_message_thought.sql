-- The thinking before an answer, kept with it (D-249, which changes D-051):
-- what the model thought while it worked, shown live in the chat and then
-- folded into «Ha ragionato per N s» above the answer. It lives in the row of
-- the answer, so it has the answer's label (the highest of what the call
-- read), and it goes wherever the answer goes: purge_conversation,
-- erase_conversation and purge_incognito delete the row. Never stored in an
-- incognito conversation (D-136): there it is live only. The core never puts
-- it in a brief, in the history a model reads or in an eval report. See
-- docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

ALTER TABLE messages ADD COLUMN thought text;
ALTER TABLE messages ADD COLUMN thought_ms integer;
ALTER TABLE messages ADD CONSTRAINT messages_thought_answer
  CHECK (thought IS NULL OR role = 'assistant');
ALTER TABLE messages ADD CONSTRAINT messages_thought_length
  CHECK (thought IS NULL OR length(thought) <= 32000);
-- The time comes with the thinking: a model that thought without showing it has an empty text and a time.
ALTER TABLE messages ADD CONSTRAINT messages_thought_ms
  CHECK ((thought IS NULL) = (thought_ms IS NULL) AND (thought_ms IS NULL OR thought_ms >= 0));

-- In an incognito the thinking is dropped, whatever the core sends: the answer is still stored.
CREATE FUNCTION messages_thought_not_incognito() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.thought IS NOT NULL AND EXISTS (SELECT FROM conversations WHERE id = NEW.conversation_id AND incognito) THEN
    NEW.thought := NULL;
    NEW.thought_ms := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER messages_thought_not_incognito BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_thought_not_incognito();

-- The time of the thinking of each step of the local orchestrator, next to its thought (0008):
-- the answer's «Ha ragionato per» adds up the steps since the last answer of the task.
ALTER TABLE task_turns ADD COLUMN thought_ms integer CHECK (thought_ms IS NULL OR thought_ms >= 0);
