-- The Private chat of the agent's browser after an access made by the user
-- (D-281, D-276): when the user gives the browser back in a work
-- conversation with an access, the core opens a Private conversation that
-- takes the browser; the work conversation stays as it is. The modes never
-- change (conversations_guard, conversations_clearance_follows_mode stay):
-- here only the link between the two, and two constraints of the gateway
-- log and of the approvals made wider. See docs/DATA-MODEL.md and
-- docs/PRIVACY-POLICY-SPEC.md. Object names are never schema-qualified.
--
-- No new grant: arianna_app inserts and updates conversations, approvals and
-- gateway_log at table level since 0007.

-- browser_of: the work conversation the browser came from. Not a foreign key
-- (as side_message_id): erase_conversation deletes the work conversation
-- without touching this one, which holds the user's own data of the site.
-- Checked at birth by the guard below, and it never changes.
ALTER TABLE conversations ADD COLUMN browser_of uuid;

-- The Private chat of an access is the user's, answered by Arianna on the
-- local model: no agent, no project, no cloud model, never incognito, the
-- secretary's, a trial chat, a side thread or a refresh of the Dashboard.
ALTER TABLE conversations ADD CONSTRAINT conversations_browser_fields
  CHECK (browser_of IS NULL OR (
    mode = 'private' AND clearance = 'L2' AND origin = 'user' AND agent IS NULL AND workspace IS NULL AND model IS NULL
    AND NOT incognito AND NOT secretary AND trial_model IS NULL AND side_of IS NULL AND dashboard_of IS NULL AND series_character IS NULL
  ));

CREATE INDEX conversations_browser_of_idx ON conversations (browser_of) WHERE browser_of IS NOT NULL;

CREATE FUNCTION conversations_browser_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  w conversations;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.browser_of IS DISTINCT FROM OLD.browser_of THEN
      RAISE EXCEPTION 'conversation %: the conversation a browser came from is chosen at creation and never changes', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.browser_of IS NULL THEN
    RETURN NEW;
  END IF;
  -- Born from an open work conversation of the user, never an incognito one (its browser tools are off).
  SELECT * INTO w FROM conversations WHERE id = NEW.browser_of;
  IF NOT FOUND OR w.purged_at IS NOT NULL OR w.mode <> 'work' OR w.incognito OR w.origin <> 'user' THEN
    RAISE EXCEPTION 'browser chat: conversation % is not an open work conversation of the user', NEW.browser_of USING ERRCODE = 'check_violation';
  END IF;
  -- It reads only the site and the user: never born marked by finance data.
  IF NEW.finance THEN
    RAISE EXCEPTION 'browser chat: born without finance data' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER conversations_browser_guard BEFORE INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_browser_guard();

-- The text Arianna types in a field of the site of the access from that chat
-- (`web-typed-session`, rule `typed`): L2, towards that site only (checked by
-- the gateway), never L3 (gateway_log_no_secret_out).
ALTER TABLE gateway_log DROP CONSTRAINT gateway_log_cloud_up_to_l1;
ALTER TABLE gateway_log ADD CONSTRAINT gateway_log_cloud_up_to_l1 CHECK (
  decision = 'block' OR locality = 'local' OR label <= 'L1' OR target_kind = 'link'
  OR (target_kind = 'web' AND target IN ('web-session', 'web-form') AND rule IN ('session', 'form'))
  OR (target_kind = 'web' AND target = 'web-typed-session' AND rule = 'typed')
);

ALTER TABLE gateway_log DROP CONSTRAINT gateway_log_session_fields;
ALTER TABLE gateway_log ADD CONSTRAINT gateway_log_session_fields CHECK (
  (target NOT IN ('web-session', 'web-form') OR (target_kind = 'web' AND locality = 'cloud' AND summary IS NULL))
  AND (target <> 'web-typed-session' OR (target_kind = 'web' AND locality = 'cloud'))
  AND (rule <> 'session' OR target = 'web-session')
  AND (rule <> 'form' OR target = 'web-form')
);

-- «Invia / No» (D-281): before Arianna sends data to the site of the access
-- (a form, or a POST of the page's scripts after her click) the user decides.
-- An approval of kind `browser`, action `browser.send`: the site, the label of
-- the element she clicked and the step, at the label of the chat (L2).
ALTER TABLE approvals DROP CONSTRAINT approvals_browser_fields;
ALTER TABLE approvals ADD CONSTRAINT approvals_browser_fields
  CHECK (kind <> 'browser' OR (
    task_id IS NOT NULL AND (
      coalesce(detail -> 'purged' = 'true'::jsonb, false)
      OR (action = 'browser.click' AND label <= 'L1'
          AND coalesce(jsonb_typeof(detail -> 'url') = 'string', false)
          AND coalesce(jsonb_typeof(detail -> 'site') = 'string', false)
          AND coalesce(jsonb_typeof(detail -> 'step') = 'number', false))
      OR (action = 'browser.send' AND label = 'L2'
          AND coalesce(jsonb_typeof(detail -> 'site') = 'string', false)
          AND coalesce(jsonb_typeof(detail -> 'element') = 'string', false)
          AND coalesce(jsonb_typeof(detail -> 'step') = 'number', false))
    )
    AND action IN ('browser.click', 'browser.send')
    AND (action <> 'browser.click' OR label <= 'L1')
  ));
