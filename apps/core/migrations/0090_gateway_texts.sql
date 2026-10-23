-- «Cosa è uscito» (D-297): the exact text of each exit the gateway let go
-- towards the cloud, readable from the detail of «Registro del gateway»
-- (D-296). See docs/DATA-MODEL.md. Object names are never schema-qualified.
--
-- gateway_log stays as it is, append-only and without content. The text
-- lives here, apart, tied to its row by id, and it can be deleted:
--   * only exits allowed (decision = 'allow') towards the cloud with a label
--     up to Interno (L1): never a blocked one, never Privato or Segreto,
--     never a local target (it did not leave the Mac);
--   * only for a row tied to a task or a run: a row without them (the
--     browser driven by the user, a catalog) cannot be tied to a
--     conversation, so neither the incognito nor «Elimina» could reach it;
--   * never for an incognito conversation: the core does not even write it,
--     and the guard below refuses it (so closing one has no text to take);
--   * gone with the conversation: «Elimina» (erase_conversation, D-157) by
--     the cascade of gateway_log; a purge (purge_conversation: the old route
--     /purge, the side threads, system chats and Dashboard refreshes purged
--     with their conversation, the routines) by the trigger below;
--   * gone by itself after 30 days: gateway_texts_prune, run by the core at
--     start and every hour, and never read past 30 days anyway.
-- The text is the UTF-8 of each part of the exit, in the order it left (seq
-- from 1): bytes, so that a NUL or any byte stays as it left. A part over
-- 1 MiB keeps its first MiB (cut on a character boundary); `bytes` is its
-- whole size. Written by the gateway in the same statement as its row of
-- gateway_log: if this cannot be written, the row is not either, and nothing
-- leaves.
CREATE TABLE gateway_texts (
  log_id     bigint NOT NULL REFERENCES gateway_log (id) ON DELETE CASCADE,
  seq        integer NOT NULL CHECK (seq BETWEEN 1 AND 100000),
  body       bytea NOT NULL CHECK (octet_length(body) <= 1048576),
  -- The size of the whole part: more than the body when it was cut.
  bytes      integer NOT NULL CHECK (bytes >= octet_length(body)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (log_id, seq)
);

CREATE INDEX gateway_texts_created_idx ON gateway_texts (created_at);

-- Purges look rows up by run as well as by task.
CREATE INDEX gateway_log_run_id_idx ON gateway_log (run_id) WHERE run_id IS NOT NULL;

-- The conversation of a row of gateway_log, by its task or by its run (as the
-- page of D-296 ties them); a card «Piano» of a «/progetta» (D-235) belongs to
-- the conversation of its request, as purge_conversation takes it. NULL for a
-- row of the core itself or of a card.
CREATE FUNCTION gateway_log_conversation(p_task uuid, p_run uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT coalesce(t.conversation_id, CASE WHEN t.planning = 'card' THEN p.conversation_id END)
  FROM tasks t LEFT JOIN tasks p ON p.id = t.parent_id
  WHERE t.id = coalesce(p_task, (SELECT r.task_id FROM runs r WHERE r.id = p_run))
$$;

-- Only what may be kept: an allowed exit to the cloud up to L1, of no
-- incognito conversation and of no purged one.
CREATE FUNCTION gateway_texts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  g gateway_log;
BEGIN
  SELECT * INTO g FROM gateway_log WHERE id = NEW.log_id;
  IF NOT FOUND OR g.decision <> 'allow' OR g.locality <> 'cloud' OR g.label > 'L1' OR (g.task_id IS NULL AND g.run_id IS NULL) THEN
    RAISE EXCEPTION 'gateway_texts: only the text of an exit allowed to the cloud up to L1, of a task or a run' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT FROM conversations c
             WHERE c.id = gateway_log_conversation(g.task_id, g.run_id) AND (c.incognito OR c.purged_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'gateway_texts: never the text of an incognito or deleted conversation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER gateway_texts_guard BEFORE INSERT ON gateway_texts
  FOR EACH ROW EXECUTE FUNCTION gateway_texts_guard();

-- The purge of a conversation takes the texts of its exits with it: those of
-- its tasks, of the cards «Piano» of its «/progetta» (D-235, purged with it
-- since 0072), and of their runs. Side threads and system chats are purged
-- one by one by purge_conversation, so each fires this for itself.
CREATE FUNCTION gateway_texts_purge() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  WITH own AS (
    SELECT id FROM tasks WHERE conversation_id = NEW.id
    UNION
    SELECT id FROM tasks WHERE planning = 'card' AND parent_id IN (SELECT id FROM tasks WHERE conversation_id = NEW.id)
  )
  DELETE FROM gateway_texts x USING gateway_log g
  WHERE x.log_id = g.id
    AND (g.task_id IN (SELECT id FROM own) OR g.run_id IN (SELECT r.id FROM runs r WHERE r.task_id IN (SELECT id FROM own)));
  RETURN NULL;
END
$$;
CREATE TRIGGER gateway_texts_purge AFTER UPDATE OF purged_at ON conversations
  FOR EACH ROW WHEN (OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL)
  EXECUTE FUNCTION gateway_texts_purge();

-- After 30 days a text goes by itself. The core holds no DELETE (D-046):
-- this is its only way to delete one, and only the old ones.
CREATE FUNCTION gateway_texts_prune() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout = '5s' AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM gateway_texts WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION gateway_texts_prune() SET search_path = %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON FUNCTION gateway_texts_prune() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gateway_texts_prune() TO arianna_app;

GRANT SELECT, INSERT ON gateway_texts TO arianna_app;
