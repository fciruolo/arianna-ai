-- task_delegations.read_chat (D-107, tappa B2, D-220): the agent read the
-- chat of the conversation besides the brief, as Arianna reads it, up to the
-- message that opened the task. Only an agent that answers on the local model
-- (executor 'local') and only within its clearance: the page says «Ha visto
-- la chat e il brief» instead of «Ha visto solo il brief». Only a flag, never
-- content. See docs/DATA-MODEL.md. Object names are never schema-qualified.
-- The table permissions of 0009 cover it.

ALTER TABLE task_delegations ADD COLUMN read_chat boolean NOT NULL DEFAULT false;
ALTER TABLE task_delegations ADD CONSTRAINT task_delegations_read_chat
  CHECK (NOT read_chat OR coalesce(executor = 'local', false));
