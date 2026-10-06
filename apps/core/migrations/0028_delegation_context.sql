-- task_delegations.context_tokens (D-111, tappa A2): how full the session of
-- the agent was after the run, as tokens of its latest model response (input,
-- cache reads and writes, output). Only a number, never content: the direct
-- chat with the Coder shows it as the context indicator. NULL when the binary
-- did not say it. See docs/DATA-MODEL.md. Object names are never
-- schema-qualified. The table permissions of 0009 cover it.

ALTER TABLE task_delegations ADD COLUMN context_tokens integer;
ALTER TABLE task_delegations ADD CONSTRAINT task_delegations_context_tokens
  CHECK (context_tokens IS NULL OR context_tokens BETWEEN 0 AND 100000000);
