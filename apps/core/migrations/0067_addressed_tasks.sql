-- The chat with more agents, tappa B2 (D-107, D-219). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.
--
-- A message the user addresses to the agents instead of Arianna: «@designer
-- …» (mention) to one, «/giro …» (round) to every agent in the conversation,
-- one after the other. The task answers with their reports, without a step of
-- Arianna's model: the core writes each delegation itself, with every rule of
-- a delegation of Arianna's (gateway, declassification, the user's choice of
-- the executor, the entrance in the chat). `addressed_agents` holds names of
-- agents in the order they speak, in the form of an agent's name: no text of
-- the user. Only a task of a conversation is addressed.
ALTER TABLE tasks ADD COLUMN addressed text CHECK (addressed IN ('mention', 'round'));
ALTER TABLE tasks ADD COLUMN addressed_agents text[];
ALTER TABLE tasks ADD CONSTRAINT tasks_addressed_agents CHECK (
  (addressed IS NULL AND addressed_agents IS NULL)
  OR (addressed = 'mention' AND cardinality(addressed_agents) = 1)
  OR (addressed = 'round' AND cardinality(addressed_agents) BETWEEN 1 AND 6)
);
ALTER TABLE tasks ADD CONSTRAINT tasks_addressed_names CHECK (
  addressed_agents IS NULL
  OR coalesce(array_to_string(addressed_agents, ',') ~ '^[a-z][a-z0-9-]{0,40}(,[a-z][a-z0-9-]{0,40})*$', false)
);
ALTER TABLE tasks ADD CONSTRAINT tasks_addressed_conversation CHECK (addressed IS NULL OR conversation_id IS NOT NULL);
