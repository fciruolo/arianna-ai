-- Task 1.7: every decision of the router, with the candidates it excluded and
-- why. See docs/DATA-MODEL.md and docs/ROUTER-SPEC.md. Object names are never
-- schema-qualified. The checks repeat rules of packages/router and
-- packages/policy as defense in depth.

CREATE TABLE router_decisions (
  id             bigserial PRIMARY KEY,
  ts             timestamptz NOT NULL DEFAULT now(),
  task_id        uuid REFERENCES tasks (id),
  run_id         uuid REFERENCES runs (id),
  step           integer CHECK (step > 0),
  -- Effective label of the run the decision was made for.
  label          privacy_label NOT NULL,
  difficulty     text NOT NULL CHECK (difficulty IN ('trivial', 'normal', 'hard', 'critical')),
  decision       text NOT NULL CHECK (decision IN ('route', 'wait')),
  executor       text CHECK (executor IN ('local', 'claude', 'codex')),
  -- An alias of arianna.toml, never the real model name.
  model          text CHECK (model IN ('local-small', 'local-large', 'sonnet', 'opus', 'fable', 'codex')),
  locality       text CHECK (locality IN ('local', 'cloud')),
  next           text CHECK (next IN ('retry-later', 'wait-user')),
  retry_at       timestamptz,
  approval       text CHECK (approval IN ('budget')),
  -- Every configured candidate: {executor, model, outcome}.
  candidates     jsonb NOT NULL CHECK (jsonb_typeof(candidates) = 'array'),
  -- Labels, rules and candidate names only, never content.
  reason         text NOT NULL CHECK (reason <> ''),
  escalated_from text,
  -- NULL in a CHECK lets the row through: IS NOT DISTINCT FROM and IS NULL keep
  -- every expression true or false.
  CONSTRAINT router_decisions_route_target CHECK (
    CASE decision
      WHEN 'route' THEN executor IS NOT NULL AND model IS NOT NULL AND locality IS NOT NULL
      ELSE executor IS NULL AND model IS NULL AND locality IS NULL
    END
  ),
  CONSTRAINT router_decisions_wait_next CHECK ((decision = 'wait') = (next IS NOT NULL)),
  CONSTRAINT router_decisions_retry_at CHECK ((next IS NOT DISTINCT FROM 'retry-later') = (retry_at IS NOT NULL)),
  -- The same pairs as EXECUTOR_OF in packages/router/src/config.ts.
  CONSTRAINT router_decisions_model_of_executor CHECK (
    model IS NULL OR (executor, model) IN (
      ('local', 'local-small'), ('local', 'local-large'),
      ('claude', 'sonnet'), ('claude', 'opus'), ('claude', 'fable'),
      ('codex', 'codex')
    )
  ),
  CONSTRAINT router_decisions_approval_on_route CHECK (approval IS NULL OR decision = 'route'),
  CONSTRAINT router_decisions_approval_only_fable CHECK (approval IS NULL OR model = 'fable'),
  CONSTRAINT router_decisions_cloud_binaries CHECK (executor NOT IN ('claude', 'codex') OR locality = 'cloud'),
  CONSTRAINT router_decisions_cloud_up_to_l1 CHECK (decision <> 'route' OR locality = 'local' OR label <= 'L1'),
  CONSTRAINT router_decisions_no_l3 CHECK (decision <> 'route' OR label <> 'L3')
);

CREATE INDEX router_decisions_task_id_idx ON router_decisions (task_id) WHERE task_id IS NOT NULL;

CREATE TRIGGER router_decisions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON router_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();
