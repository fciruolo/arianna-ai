-- «Cosa era» (D-297, second stage): what each exit of the gateway was, so
-- that the «Registro del gateway» groups the exits of one run and tells
-- them apart. See docs/DATA-MODEL.md. Object names are never schema-qualified.
--
-- Two parts, with different rules:
--   * gateway_log.what: a closed code written by the code (`brief`,
--     `mcp-kb-read`, `mcp-kb-read-denied`…), L0: the name of the tool, never
--     what it read. gateway_log stays append-only; existing rows have none.
--   * gateway_subjects: the subject of one exit (the path of a note, the text
--     of a search, the id of a skill, the site of a page), free text that may
--     be private, also for a blocked exit (the path of a Privato note it
--     refused). The same rules as gateway_texts (0090): only for a row tied to
--     a task or a run, never for an incognito or deleted conversation, read
--     only from the Mac, gone with the conversation (the cascade of «Elimina»,
--     the trigger of the purges) and after 30 days (gateway_texts_prune).
--     Unlike the text, it is kept for a blocked exit and for any label: it
--     never leaves the Mac, and it is the subject, never the content.
ALTER TABLE gateway_log ADD COLUMN what text CHECK (what IS NULL OR what ~ '^[a-z][a-z0-9-]{0,47}$');

CREATE TABLE gateway_subjects (
  log_id     bigint PRIMARY KEY REFERENCES gateway_log (id) ON DELETE CASCADE,
  subject    text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX gateway_subjects_created_idx ON gateway_subjects (created_at);

-- Only a row tied to a task or a run, of no incognito and no deleted conversation.
CREATE FUNCTION gateway_subjects_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  g gateway_log;
BEGIN
  SELECT * INTO g FROM gateway_log WHERE id = NEW.log_id;
  IF NOT FOUND OR (g.task_id IS NULL AND g.run_id IS NULL) THEN
    RAISE EXCEPTION 'gateway_subjects: only the subject of an exit of a task or a run' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT FROM conversations c
             WHERE c.id = gateway_log_conversation(g.task_id, g.run_id) AND (c.incognito OR c.purged_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'gateway_subjects: never the subject of an incognito or deleted conversation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER gateway_subjects_guard BEFORE INSERT ON gateway_subjects
  FOR EACH ROW EXECUTE FUNCTION gateway_subjects_guard();

-- The purge takes the subjects with the texts (as in 0090).
CREATE OR REPLACE FUNCTION gateway_texts_purge() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  v_rows bigint[];
BEGIN
  WITH own AS (
    SELECT id FROM tasks WHERE conversation_id = NEW.id
    UNION
    SELECT id FROM tasks WHERE planning = 'card' AND parent_id IN (SELECT id FROM tasks WHERE conversation_id = NEW.id)
  )
  SELECT coalesce(array_agg(g.id), '{}') INTO v_rows FROM gateway_log g
  WHERE g.task_id IN (SELECT id FROM own) OR g.run_id IN (SELECT r.id FROM runs r WHERE r.task_id IN (SELECT id FROM own));
  DELETE FROM gateway_texts WHERE log_id = ANY (v_rows);
  DELETE FROM gateway_subjects WHERE log_id = ANY (v_rows);
  RETURN NULL;
END
$$;

-- After 30 days the subjects go with the texts: the same function, so the
-- doctor's list of the functions that run as their owner does not change.
CREATE OR REPLACE FUNCTION gateway_texts_prune() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout = '5s' AS $$
DECLARE
  v_texts integer;
  v_subjects integer;
BEGIN
  DELETE FROM gateway_texts WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS v_texts = ROW_COUNT;
  DELETE FROM gateway_subjects WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS v_subjects = ROW_COUNT;
  RETURN v_texts + v_subjects;
END
$$;

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION gateway_texts_prune() SET search_path = %I, pg_temp', current_schema());
END
$$;

GRANT SELECT, INSERT ON gateway_subjects TO arianna_app;
