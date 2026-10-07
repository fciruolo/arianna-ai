-- Codex has three models like Claude (D-141): the aliases luna, sol and astra
-- take the place of the single alias codex, which ran the binary's default
-- model. Old decisions keep their codex rows (history is not rewritten); new
-- ones name the alias the router chose. A conversation that had chosen codex
-- now has sol, the model of the tier codex stood on.
ALTER TABLE router_decisions DROP CONSTRAINT router_decisions_model_check;
ALTER TABLE router_decisions ADD CONSTRAINT router_decisions_model_check
  CHECK (model IN ('local-small', 'local-large', 'sonnet', 'opus', 'fable', 'luna', 'sol', 'astra', 'codex'));

-- The same pairs as EXECUTOR_OF in packages/router/src/config.ts, and codex for the rows from before.
ALTER TABLE router_decisions DROP CONSTRAINT router_decisions_model_of_executor;
ALTER TABLE router_decisions ADD CONSTRAINT router_decisions_model_of_executor CHECK (
  model IS NULL OR (executor, model) IN (
    ('local', 'local-small'), ('local', 'local-large'),
    ('claude', 'sonnet'), ('claude', 'opus'), ('claude', 'fable'),
    ('codex', 'luna'), ('codex', 'sol'), ('codex', 'astra'),
    ('codex', 'codex')
  )
);

UPDATE conversations SET model = 'sol' WHERE model = 'codex';
