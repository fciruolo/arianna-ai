-- The note of a card (task 1.10, `task.update`). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- tasks.note: the last note an agent wrote on a card with `task.update`, one
-- line or a few for the user. For a card moved to waiting_user it is also
-- waiting_reason. Its label is folded into the card's: the core raises
-- `label` and `effective_label` to the label of what the note was written
-- from, and refuses a note above the card's clearance.
--
-- Only on cards (tasks without a conversation): purge_conversation clears
-- the text of a conversation's tasks and does not know this column, so a
-- task of a conversation never holds a note. Cards outlive the purge as
-- objects of their own (0012), their note with them.
--
-- No new grant: arianna_app updates tasks at table level since 0007.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN note text;
ALTER TABLE tasks ADD CONSTRAINT tasks_note_length
  CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500);
ALTER TABLE tasks ADD CONSTRAINT tasks_note_only_cards
  CHECK (note IS NULL OR conversation_id IS NULL);
