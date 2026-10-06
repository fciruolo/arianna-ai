-- The direct chat with any agent (D-111d), not only the Coder: who answers
-- is any agent id but Arianna. See docs/DATA-MODEL.md. Object names are
-- never schema-qualified.
--
-- Mode and project now follow the agent's card, which only the code reads: an
-- agent on Claude needs a work conversation on a project (it works in its
-- folder), a local one may also answer in a private conversation when its card
-- may read L2. The database keeps what holds for every agent: an agent id,
-- never Arianna, only in a conversation the user opened. Chosen at creation
-- and never changed (conversations_agent_fixed of 0027 stays).

ALTER TABLE conversations DROP CONSTRAINT conversations_agent_known;
ALTER TABLE conversations DROP CONSTRAINT conversations_agent_work_project;
ALTER TABLE conversations ADD CONSTRAINT conversations_agent_known
  CHECK (agent IS NULL OR (agent ~ '^[a-z][a-z0-9-]{0,63}$' AND agent <> 'arianna'));
ALTER TABLE conversations ADD CONSTRAINT conversations_agent_user
  CHECK (agent IS NULL OR origin = 'user');
