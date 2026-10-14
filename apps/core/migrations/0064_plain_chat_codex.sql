-- ChatGPT without a project and the context indicator of the plain chats
-- (D-212, the rest of D-111 tappa B). See docs/DATA-MODEL.md. Object names
-- are never schema-qualified.
--
-- The model of the plain chat with ChatGPT (`agent = 'codex'`, a work
-- conversation without a project, 0063): one of the aliases of Codex (D-141),
-- or NULL, which is Sol. None of them asks for a budget approval.
ALTER TABLE conversations ADD CONSTRAINT conversations_agent_codex_model
  CHECK (agent IS DISTINCT FROM 'codex' OR model IS NULL OR model IN ('luna', 'sol', 'astra'));

-- runs.context_tokens: how full the session was after the run, as tokens of
-- its latest model response (input with the cached ones, and output). Only a
-- number, never content: the plain chats with Claude or ChatGPT have no
-- delegation row (0028 holds it there for the direct chat with an agent) and
-- show it as the context indicator. NULL when the binary did not say it, and
-- for every other run. The table permissions of 0007 cover it.
ALTER TABLE runs ADD COLUMN context_tokens integer;
ALTER TABLE runs ADD CONSTRAINT runs_context_tokens
  CHECK (context_tokens IS NULL OR context_tokens BETWEEN 0 AND 100000000);
