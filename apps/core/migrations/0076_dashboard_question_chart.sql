-- Dashboard (D-248, after the user's trial of 2026-10-17): the tile's
-- question is edited from the Dashboard (its label stays: it is the user's
-- text in the same conversation, and the tile's label only goes up), and a
-- tile is a text or a chart. A chart is data the local model writes in a
-- closed shape at every refresh, checked by the core (dashboard-chart.ts)
-- before it is stored; the page draws it. The answer in words stays in `body`.
-- See docs/DATA-MODEL.md. Object names are never schema-qualified.

ALTER TABLE dashboard_tiles
  ADD COLUMN kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'chart')),
  ADD COLUMN chart jsonb CHECK (chart IS NULL OR (jsonb_typeof(chart) = 'object' AND octet_length(chart::text) <= 16000));

-- No model reads Segreto: such a tile is never a chart.
ALTER TABLE dashboard_tiles ADD CONSTRAINT dashboard_tiles_secret_never_chart CHECK (kind = 'text' OR label < 'L3');

-- A refresh of a chart whose data the model could not give in the closed shape: `chart`.
ALTER TABLE dashboard_tiles DROP CONSTRAINT dashboard_tiles_refresh_error_check;
ALTER TABLE dashboard_tiles ADD CONSTRAINT dashboard_tiles_refresh_error_check
  CHECK (refresh_error IN ('failed', 'timeout', 'question', 'empty', 'lost', 'chart'));

CREATE OR REPLACE FUNCTION dashboard_tiles_guard() RETURNS trigger
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
  -- The question changes (the user edits it in the Dashboard), its label never: it is the user's text in the same conversation.
  IF (NEW.id, NEW.question_label, NEW.source_conversation_id, NEW.source_message_id, NEW.origin_cloud, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.question_label, OLD.source_conversation_id, OLD.source_message_id, OLD.origin_cloud, OLD.created_at) THEN
    RAISE EXCEPTION 'dashboard_tiles %: only title, question, kind, body, chart, label, width, position and the refresh change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.question IS DISTINCT FROM OLD.question AND OLD.refresh_state = 'running' THEN
    RAISE EXCEPTION 'dashboard_tiles %: the question does not change while it is asked', OLD.id USING ERRCODE = 'restrict_violation';
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
