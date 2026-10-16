-- Cruscotto personale (D-248, idea 6 of OpenWork, the user's choice of
-- 2026-10-16 «Fisso + Aggiorna a mano»): an answer of the chat pinned to the
-- page «Cruscotto», with a title the user changes, the question that
-- «Aggiorna» asks again, the label of the answer and the conversation it came
-- from. «Aggiorna» asks the question again on the local model only, in a
-- conversation of its own born for that one refresh (`dashboard_of`): private,
-- hidden from the list and the search, answered by the local model of «Con chi
-- parli» or by the agent of the Finances, erased for good (erase_conversation)
-- once its answer is copied in the tile. See docs/DATA-MODEL.md. Object names are never schema-qualified.
--
-- Erasing the conversation a tile came from (D-157) takes the tile with it:
-- ON DELETE CASCADE, inside erase_conversation, which is not redefined here.
-- The core erases the refresh conversations still alive first (erase.ts) and
-- removes the tiles before purge_conversation (conversations.ts).

-- ---------------------------------------------------------------------------
-- The refresh conversations: `dashboard_of` is the conversation the tile came
-- from. Not a foreign key: a purged refresh conversation keeps its skeleton
-- (and a purged conversation never changes, conversations_guard), while the
-- conversation it names may be erased for good. Checked at birth by the guard
-- below, and never changed.
-- ---------------------------------------------------------------------------

ALTER TABLE conversations ADD COLUMN dashboard_of uuid;

-- Private (L2: nothing of it may leave for the cloud, the gateway refuses it), the user's, never incognito,
-- the secretary's, a trial chat, a side thread nor pinned; answered by the local model or the agent of the Finances.
ALTER TABLE conversations ADD CONSTRAINT conversations_dashboard_fields
  CHECK (dashboard_of IS NULL OR (
    mode = 'private' AND clearance = 'L2' AND origin = 'user' AND NOT incognito AND NOT secretary
    AND trial_model IS NULL AND side_of IS NULL AND pinned_at IS NULL AND workspace IS NULL AND model IS NULL
    AND (coalesce(agent, '') = 'local-chat' OR (finance AND agent IS NOT NULL))));
CREATE INDEX conversations_dashboard_of_idx ON conversations (dashboard_of) WHERE dashboard_of IS NOT NULL;

CREATE FUNCTION conversations_dashboard_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.dashboard_of IS DISTINCT FROM OLD.dashboard_of THEN
      RAISE EXCEPTION 'conversation %: the conversation a refresh is for never changes', OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.dashboard_of IS NOT NULL AND NOT EXISTS (
    SELECT FROM conversations WHERE id = NEW.dashboard_of AND purged_at IS NULL AND NOT incognito AND dashboard_of IS NULL
  ) THEN
    RAISE EXCEPTION 'conversation: a refresh is for a conversation that exists, never an incognito one nor another refresh'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER conversations_dashboard_guard BEFORE INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_dashboard_guard();

-- ---------------------------------------------------------------------------
-- The tiles.
-- ---------------------------------------------------------------------------

CREATE TABLE dashboard_tiles (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                    text NOT NULL CHECK (btrim(title) <> '' AND length(title) <= 80),
  -- What «Aggiorna» asks, complete without the conversation (rewritten by the local model at «Fissa», checked by the user).
  question                 text NOT NULL CHECK (btrim(question) <> '' AND length(question) <= 2000),
  -- The label of the user's text in the conversation the answer is in: its clearance (Privato for the finances), never below the answer.
  question_label           privacy_label NOT NULL,
  body                     text NOT NULL CHECK (length(body) <= 32000),
  -- The label of the tile: never below the question's nor below a label it had (it only goes up).
  label                    privacy_label NOT NULL,
  source_conversation_id   uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  -- Not a foreign key: purge_conversation deletes the messages (and the core removes the tiles first).
  source_message_id        bigint NOT NULL,
  -- Who wrote the body now: Claude or ChatGPT for an answer of the cloud, the local model after a refresh.
  answered_by              text NOT NULL CHECK (answered_by IN ('local', 'claude', 'codex')),
  -- The first answer came from the cloud: the tile says that «Aggiorna» asks the local model instead.
  origin_cloud             boolean NOT NULL,
  width                    text NOT NULL DEFAULT 'narrow' CHECK (width IN ('narrow', 'wide')),
  position                 integer NOT NULL DEFAULT 0,
  refreshed_at             timestamptz NOT NULL DEFAULT now(),
  refresh_state            text NOT NULL DEFAULT 'idle' CHECK (refresh_state IN ('idle', 'running', 'failed')),
  refresh_error            text CHECK (refresh_error IN ('failed', 'timeout', 'question', 'empty', 'lost')),
  refresh_conversation_id  uuid REFERENCES conversations (id) ON DELETE SET NULL,
  refresh_started_at       timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dashboard_tiles_label_over_question CHECK (label >= question_label),
  CONSTRAINT dashboard_tiles_error_when_failed CHECK ((refresh_state = 'failed') = (refresh_error IS NOT NULL)),
  CONSTRAINT dashboard_tiles_started_when_running CHECK (refresh_state <> 'running' OR refresh_started_at IS NOT NULL),
  -- No model reads Segreto: such a tile is never refreshed.
  CONSTRAINT dashboard_tiles_secret_never_refreshed CHECK (label < 'L3' OR refresh_state = 'idle'),
  -- An answer is pinned once.
  CONSTRAINT dashboard_tiles_one_per_answer UNIQUE (source_message_id)
);
CREATE INDEX dashboard_tiles_source_idx ON dashboard_tiles (source_conversation_id);
CREATE INDEX dashboard_tiles_running_idx ON dashboard_tiles (refresh_state) WHERE refresh_state = 'running';

CREATE FUNCTION dashboard_tiles_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  c conversations;
  m messages;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO c FROM conversations WHERE id = NEW.source_conversation_id;
    IF NOT FOUND OR c.purged_at IS NOT NULL OR c.incognito OR c.dashboard_of IS NOT NULL OR c.trial_model IS NOT NULL
       OR c.side_of IS NOT NULL OR c.origin <> 'user' THEN
      RAISE EXCEPTION 'dashboard_tiles: an answer of an incognito conversation, a trial chat, a side thread, a system chat or a refresh is never pinned'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO m FROM messages WHERE id = NEW.source_message_id AND conversation_id = NEW.source_conversation_id;
    IF NOT FOUND OR m.role <> 'assistant' THEN
      RAISE EXCEPTION 'dashboard_tiles: only an answer of the conversation is pinned' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.label < m.label THEN
      RAISE EXCEPTION 'dashboard_tiles: the tile is at least as protected as the answer (%)', m.label USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.refresh_state <> 'idle' THEN
      RAISE EXCEPTION 'dashboard_tiles: a tile is born idle' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.question, NEW.question_label, NEW.source_conversation_id, NEW.source_message_id, NEW.origin_cloud, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.question, OLD.question_label, OLD.source_conversation_id, OLD.source_message_id, OLD.origin_cloud, OLD.created_at) THEN
    RAISE EXCEPTION 'dashboard_tiles %: only title, body, label, width, position and the refresh change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.label < OLD.label THEN
    RAISE EXCEPTION 'dashboard_tiles %: the label only goes up', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  -- The refresh conversation is private and its own: never another tile's, never one already purged at the start.
  IF NEW.refresh_conversation_id IS NOT NULL AND NEW.refresh_conversation_id IS DISTINCT FROM OLD.refresh_conversation_id
     AND (NOT EXISTS (SELECT FROM conversations WHERE id = NEW.refresh_conversation_id AND dashboard_of = NEW.source_conversation_id AND purged_at IS NULL)
          OR EXISTS (SELECT FROM dashboard_tiles d WHERE d.refresh_conversation_id = NEW.refresh_conversation_id AND d.id <> NEW.id)) THEN
    RAISE EXCEPTION 'dashboard_tiles %: a refresh runs in a conversation born for this tile', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER dashboard_tiles_guard BEFORE INSERT OR UPDATE ON dashboard_tiles
  FOR EACH ROW EXECUTE FUNCTION dashboard_tiles_guard();

-- The core reads, pins and changes tiles; it never deletes one by hand (D-046, D-157): «Togli» goes through the function below.
GRANT SELECT, INSERT, UPDATE ON dashboard_tiles TO arianna_app;

-- ---------------------------------------------------------------------------
-- «Togli dal Cruscotto»: one tile, never while it is being refreshed. The
-- conversation it came from stays as it is.
-- ---------------------------------------------------------------------------

CREATE FUNCTION remove_dashboard_tile(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout = '5s' AS $$
DECLARE
  t dashboard_tiles;
BEGIN
  SELECT * INTO t FROM dashboard_tiles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF t.refresh_state = 'running' THEN
    RAISE EXCEPTION 'dashboard tile %: it is being refreshed', p_id USING ERRCODE = 'object_in_use';
  END IF;
  DELETE FROM dashboard_tiles WHERE id = p_id;
  RETURN true;
END
$$;

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION remove_dashboard_tile(uuid) SET search_path = %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON FUNCTION remove_dashboard_tile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION remove_dashboard_tile(uuid) TO arianna_app;
