-- An error with no other way (D-250): a line of activity `stop`, which the chat
-- writes as «Errore: …» without «provo un'altra strada». It is the error of a
-- step that ends the task: the direct chat with an agent and the card of an
-- agent, where no model takes another step after it. See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

ALTER TABLE task_activities DROP CONSTRAINT task_activities_kind_check;
ALTER TABLE task_activities ADD CONSTRAINT task_activities_kind_check
  CHECK (kind IN ('search', 'read', 'write', 'card', 'plan', 'error', 'stop', 'delegate', 'tool', 'wait'));
