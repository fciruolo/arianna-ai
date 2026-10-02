-- Task 1.15: state of the Telegram channel (D-044). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- telegram_state: one row. The work conversation the bot is bound to, the
-- next update to ask Telegram for, and the last event the channel handled.
-- ---------------------------------------------------------------------------

CREATE TABLE telegram_state (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  conversation_id uuid NOT NULL REFERENCES conversations (id),
  -- `offset` of getUpdates: the first update_id not handled yet.
  update_offset   bigint NOT NULL DEFAULT 0 CHECK (update_offset >= 0),
  -- When the last update was handled. After a week without updates Telegram
  -- may restart the ids at random, possibly lower: see telegram_offset_stale.
  last_update_at  timestamptz,
  -- Id of the last event turned into notices (0: none).
  event_cursor    bigint NOT NULL DEFAULT 0 CHECK (event_cursor >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- True when no update was handled for two days. Telegram keeps an update it
-- could not deliver for 24 hours, so none handled before can come back: the
-- offset may start again from whatever id Telegram sends next.
CREATE FUNCTION telegram_offset_stale(last_update_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT last_update_at IS NULL OR last_update_at < now() - interval '2 days'
$$;

-- Telegram passes through its servers, so it gets at most L1 (D-016): the
-- bound conversation is a work one, and stays the same. Both counters only
-- go up (going back would handle an update or an event twice), except the
-- offset after two quiet days.
CREATE FUNCTION telegram_state_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  v_mode text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'telegram_state: the conversation cannot change' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.update_offset < OLD.update_offset AND NOT telegram_offset_stale(OLD.last_update_at))
       OR NEW.event_cursor < OLD.event_cursor THEN
      RAISE EXCEPTION 'telegram_state: offsets cannot go back' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT mode INTO v_mode FROM conversations WHERE id = NEW.conversation_id;
  IF v_mode IS DISTINCT FROM 'work' THEN
    RAISE EXCEPTION 'telegram_state: the bot is bound to a work conversation only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER telegram_state_guard BEFORE INSERT OR UPDATE ON telegram_state
  FOR EACH ROW EXECUTE FUNCTION telegram_state_guard();
