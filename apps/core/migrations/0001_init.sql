-- Phase 0 schema: append-only event log with a hash chain, tasks, job queue.
-- See docs/DATA-MODEL.md. Object names are never schema-qualified: tests apply
-- this file inside a throwaway schema.

CREATE TYPE privacy_label AS ENUM ('L0', 'L1', 'L2', 'L3');
CREATE TYPE task_status AS ENUM ('inbox', 'ready', 'running', 'waiting_user', 'to_verify', 'done', 'failed');

-- ---------------------------------------------------------------------------
-- events: source of truth for HUD, pixel office and audit.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE events_id_seq;

CREATE TABLE events (
  -- id, ts, prev_hash and hash are always assigned by the events_chain trigger.
  id        bigint PRIMARY KEY,
  ts        timestamptz NOT NULL,
  task_id   uuid,
  run_id    uuid,
  agent     text,
  kind      text NOT NULL CHECK (kind <> ''),
  label     privacy_label NOT NULL DEFAULT 'L2',
  -- With label >= L2 the payload holds references (ids, paths, hashes), never content.
  payload   jsonb NOT NULL DEFAULT '{}',
  prev_hash bytea,
  hash      bytea NOT NULL,
  -- Each event has exactly one successor: a fork of the chain (two writers on the
  -- same snapshot, e.g. outside READ COMMITTED) fails instead of passing unnoticed.
  CONSTRAINT events_single_successor UNIQUE NULLS NOT DISTINCT (prev_hash)
);

ALTER SEQUENCE events_id_seq OWNED BY events.id;

CREATE INDEX events_task_id_idx ON events (task_id) WHERE task_id IS NOT NULL;

-- hash = sha256(previous hash || canonical row). The row is serialized as a JSON
-- array, which is unambiguous; the timestamp is rendered in UTC so the result
-- does not depend on session settings.
CREATE FUNCTION event_hash(prev bytea, e events) RETURNS bytea
LANGUAGE sql STABLE AS $$
  SELECT sha256(
    coalesce(prev, ''::bytea) ||
    convert_to(
      jsonb_build_array(
        e.id,
        to_char(e.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        e.task_id,
        e.run_id,
        e.agent,
        e.kind,
        e.label,
        e.payload
      )::text,
      'UTF8'
    )
  );
$$;

-- SET search_path FROM CURRENT pins the schema this migration runs in, so the
-- function finds its own table and sequence whatever the caller's search_path is.
CREATE FUNCTION events_chain() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  v_prev bytea;
BEGIN
  -- One writer at a time, so ids and hashes are assigned in the same order.
  -- Callers cannot choose id, ts or hashes: they are overwritten here.
  -- The lock is held until commit: write the event last, in a short transaction.
  PERFORM pg_advisory_xact_lock(hashtext('arianna.events'));
  SELECT hash INTO v_prev FROM events ORDER BY id DESC LIMIT 1;
  NEW.id := nextval('events_id_seq');
  NEW.ts := clock_timestamp();
  NEW.prev_hash := v_prev;
  NEW.hash := event_hash(v_prev, NEW);
  RETURN NEW;
END
$$;

CREATE TRIGGER events_chain BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION events_chain();

CREATE FUNCTION events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- Statement-level, so it also fires when the statement would touch no rows.
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_append_only();

-- Returns the id of the first event that breaks the chain, NULL when it is intact.
CREATE FUNCTION verify_event_chain() RETURNS bigint
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  v_prev bytea;
  e events;
BEGIN
  FOR e IN SELECT * FROM events ORDER BY id LOOP
    IF e.prev_hash IS DISTINCT FROM v_prev OR e.hash IS DISTINCT FROM event_hash(v_prev, e) THEN
      RETURN e.id;
    END IF;
    v_prev := e.hash;
  END LOOP;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------
-- tasks: one row per card of the cardwall.
-- ---------------------------------------------------------------------------

CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id       uuid REFERENCES tasks (id),
  title           text NOT NULL CHECK (title <> ''),
  goal            text,
  done_criteria   text,
  status          task_status NOT NULL DEFAULT 'inbox',
  label           privacy_label NOT NULL DEFAULT 'L2',
  clearance       privacy_label NOT NULL DEFAULT 'L2',
  -- Highest label actually read so far; only ever goes up.
  effective_label privacy_label NOT NULL DEFAULT 'L0',
  -- 'user' or the name of an agent.
  assignee        text NOT NULL DEFAULT 'user',
  area            text,
  priority        integer NOT NULL DEFAULT 0,
  due_at          timestamptz,
  limits          jsonb NOT NULL DEFAULT '{}',
  evidence        jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- An agent's card cannot be closed without attached evidence. Checks run in
  -- name order, so tasks_done_needs_evidence must not fail on a non-array itself.
  CONSTRAINT tasks_evidence_is_list CHECK (jsonb_typeof(evidence) = 'array'),
  CONSTRAINT tasks_done_needs_evidence
    CHECK (status <> 'done' OR assignee = 'user'
           OR (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) > 0)),
  -- No model reads L3, so no task can be cleared for it.
  CONSTRAINT tasks_clearance_below_secret CHECK (clearance <> 'L3'),
  CONSTRAINT tasks_effective_within_clearance CHECK (effective_label <= clearance)
);

CREATE INDEX tasks_status_idx ON tasks (status);

-- ---------------------------------------------------------------------------
-- jobs: queue and scheduler (D-004), consumed with FOR UPDATE SKIP LOCKED.
-- ---------------------------------------------------------------------------

CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  queue        text NOT NULL CHECK (queue <> ''),
  payload      jsonb NOT NULL DEFAULT '{}',
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  locked_at    timestamptz,
  locked_by    text,
  status       text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed')),
  last_error   text
);

CREATE INDEX jobs_ready_idx ON jobs (queue, run_at) WHERE status = 'queued';
