-- Trials of a catalog model with the orchestrator evals, in the background
-- (D-081). See docs/DATA-MODEL.md. Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- model_evals: one row per trial. All L0: the cases are invented (evals/),
-- and a row holds only ids, outcomes, numbers and closed codes, never what the
-- model answered. The weights are named by the sha256 of the catalog's file
-- list ("according to the catalog", not recomputed). A trial runs on the
-- `model.eval` queue of jobs; the promotion of the catalog entry is never
-- written by the core (the catalog is in git).
-- ---------------------------------------------------------------------------

CREATE TABLE model_evals (
  id               bigserial PRIMARY KEY,
  job_id           bigint REFERENCES jobs (id),
  model_id         text NOT NULL CHECK (model_id ~ '^[a-z0-9][a-z0-9._-]*$' AND char_length(model_id) <= 200),
  role             text NOT NULL CHECK (role = 'orchestrator'),
  weights_sha256   text CHECK (weights_sha256 ~ '^[0-9a-f]{64}$'),
  catalog_status   text NOT NULL CHECK (catalog_status IN ('verified', 'experimental')),
  cases_sha256     text CHECK (cases_sha256 ~ '^[0-9a-f]{64}$'),
  prompt_sha256    text CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'passed', 'failed', 'error', 'cancelled')),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  total            integer CHECK (total >= 0),
  passed           integer CHECK (passed >= 0 AND passed <= total),
  -- [{name, total, passed, rate, threshold}] of the group.
  measures         jsonb CHECK (measures IS NULL OR jsonb_typeof(measures) = 'array'),
  latency_median_ms integer CHECK (latency_median_ms >= 0),
  latency_max_ms   integer CHECK (latency_max_ms >= 0),
  -- Why the group failed: fixed texts of the runner with case ids.
  reasons          jsonb CHECK (reasons IS NULL OR jsonb_typeof(reasons) = 'array'),
  -- [{id, passed, ms, error?}]: the id of the case, its outcome, its time, an error code.
  cases            jsonb CHECK (cases IS NULL OR jsonb_typeof(cases) = 'array'),
  -- Cases started again because a call or a task needed the machine.
  preemptions      integer NOT NULL DEFAULT 0 CHECK (preemptions >= 0),
  -- A closed code (class name and code, or a word of the core), never a message.
  error            text CHECK (error ~ '^[\w.:-]{1,100}$'),
  -- Cancelled or refused while queued, a trial never started.
  CONSTRAINT model_evals_started CHECK (
    (status <> 'queued' OR started_at IS NULL) AND (status NOT IN ('running', 'passed', 'failed') OR started_at IS NOT NULL)
  ),
  CONSTRAINT model_evals_finished CHECK ((status IN ('queued', 'running')) = (finished_at IS NULL)),
  CONSTRAINT model_evals_result CHECK (status NOT IN ('passed', 'failed') OR (total IS NOT NULL AND passed IS NOT NULL AND measures IS NOT NULL AND cases IS NOT NULL))
);

CREATE INDEX model_evals_model_idx ON model_evals (model_id, requested_at DESC);
-- One open trial per model: a second request waits for the first to end.
CREATE UNIQUE INDEX model_evals_one_open ON model_evals (model_id) WHERE status IN ('queued', 'running');

-- Who was tried, when, on which weights stays as written; a finished trial
-- is not reopened.
CREATE FUNCTION model_evals_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.model_id IS DISTINCT FROM OLD.model_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.weights_sha256 IS DISTINCT FROM OLD.weights_sha256
     OR NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'model_evals: model, role, request time and weights of trial % do not change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('passed', 'failed', 'error', 'cancelled') THEN
    RAISE EXCEPTION 'model_evals: trial % is finished (%)', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'running' AND NEW.status = 'queued' THEN
    RAISE EXCEPTION 'model_evals: trial % does not go back to the queue', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER model_evals_guard BEFORE UPDATE ON model_evals
  FOR EACH ROW EXECUTE FUNCTION model_evals_guard();

-- Rows only, never deleted (D-046).
GRANT SELECT, INSERT, UPDATE ON model_evals TO arianna_app;
GRANT USAGE ON SEQUENCE model_evals_id_seq TO arianna_app;
