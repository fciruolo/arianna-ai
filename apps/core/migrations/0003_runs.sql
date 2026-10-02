-- Task 1.8: runs, the reason a task waits for the user, and job queue guards.
-- See docs/DATA-MODEL.md. Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- tasks: "Attende te" always says why, in one line.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN waiting_reason text;
ALTER TABLE tasks ADD CONSTRAINT tasks_waiting_has_reason
  CHECK ((status = 'waiting_user') = (waiting_reason IS NOT NULL AND waiting_reason <> ''));
-- The approval a waiting task waits for: only its decision resumes the task.
ALTER TABLE tasks ADD COLUMN waiting_approval_id uuid REFERENCES approvals (id);
ALTER TABLE tasks ADD CONSTRAINT tasks_waiting_approval_only_waiting
  CHECK (waiting_approval_id IS NULL OR status = 'waiting_user');

-- ---------------------------------------------------------------------------
-- approvals: the detail comes from the task's context and carries its label,
-- so that a channel (Telegram, phone) can tell what it may show.
-- ---------------------------------------------------------------------------

ALTER TABLE approvals ADD COLUMN label privacy_label NOT NULL DEFAULT 'L2';

CREATE FUNCTION approvals_label_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.label IS DISTINCT FROM OLD.label THEN
    RAISE EXCEPTION 'approvals.label cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER approvals_label_frozen BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION approvals_label_frozen();

-- ---------------------------------------------------------------------------
-- runs: one session of an executor on one step of a task.
-- ---------------------------------------------------------------------------

CREATE TABLE runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid NOT NULL REFERENCES tasks (id),
  step            integer NOT NULL CHECK (step > 0),
  agent           text NOT NULL CHECK (agent <> ''),
  executor        text NOT NULL CHECK (executor <> ''),
  model           text,
  locality        text NOT NULL CHECK (locality IN ('local', 'cloud')),
  -- Id for --resume returned by the binary; never a credential.
  session_ref     text,
  -- The run this one resumes, after an interruption.
  resumed_from    uuid REFERENCES runs (id),
  -- Worktree, relative to ARIANNA_HOME.
  workspace       text,
  effective_label privacy_label NOT NULL DEFAULT 'L0',
  status          text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'ok', 'failed', 'cancelled', 'limit', 'interrupted')),
  steps_used      integer NOT NULL DEFAULT 0 CHECK (steps_used >= 0),
  tokens_in       bigint CHECK (tokens_in >= 0),
  tokens_out      bigint CHECK (tokens_out >= 0),
  -- Euro beyond the subscriptions (docs/AGENT-CARDS.md, max_cost).
  -- 'NaN' is >= 0 for numeric: refused, or the sum would switch the cost cap off.
  cost_estimate   numeric NOT NULL DEFAULT 0 CHECK (cost_estimate >= 0 AND cost_estimate <> 'NaN'),
  started_at      timestamptz NOT NULL DEFAULT now(),
  -- Last heartbeat of the worker: a run interrupted by a crash ends here, so
  -- that the time the core was down does not count as work.
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  CONSTRAINT runs_ended CHECK ((status = 'running') = (ended_at IS NULL)),
  -- Defense in depth: a cloud executor never works on more than L1.
  CONSTRAINT runs_cloud_at_most_l1 CHECK (locality = 'local' OR effective_label <= 'L1')
);

-- One running run per task: two workers can never process the same task.
CREATE UNIQUE INDEX runs_one_running_per_task ON runs (task_id) WHERE status = 'running';
CREATE INDEX runs_task_idx ON runs (task_id, step);

-- ---------------------------------------------------------------------------
-- jobs: the lock columns follow the status, and a key keeps one active job
-- per subject (for instance one step job per task).
-- ---------------------------------------------------------------------------

ALTER TABLE jobs ADD COLUMN key text CHECK (key <> '');
ALTER TABLE jobs ADD CONSTRAINT jobs_lock_follows_status
  CHECK ((status = 'running') = (locked_at IS NOT NULL AND locked_by IS NOT NULL));
CREATE UNIQUE INDEX jobs_one_active_per_key ON jobs (key) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_running_idx ON jobs (locked_at) WHERE status = 'running';
