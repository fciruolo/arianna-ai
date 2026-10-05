-- Pinned conversations (D-089): the user pins a conversation at the top of
-- the list, with no limit on how many. See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- conversations.pinned_at: when the user pinned it; NULL when it is not
-- pinned. The list shows the pinned ones first, the latest pin on top.
-- Only a conversation in the list is pinned: pinning an archived one is
-- refused by the core, and archiving a pinned one unpins it (trigger below),
-- so the system that archives a system chat inside purge_conversation never
-- trips on a pin. Restoring does not pin it again.
--
-- No new grant: arianna_app updates conversations at table level since 0007,
-- and conversations_guard, which freezes the other columns, leaves this one
-- free. A purged conversation never changes, pin included (the guard).
-- ---------------------------------------------------------------------------

ALTER TABLE conversations ADD COLUMN pinned_at timestamptz;
ALTER TABLE conversations ADD CONSTRAINT conversations_pinned_listed
  CHECK (pinned_at IS NULL OR archived_at IS NULL);

CREATE INDEX conversations_pinned_idx ON conversations (pinned_at) WHERE pinned_at IS NOT NULL;

CREATE FUNCTION conversations_unpin_archived() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL THEN
    NEW.pinned_at := NULL;
  END IF;
  RETURN NEW;
END
$$;

-- Fires after conversations_guard (BEFORE triggers run in name order): the
-- guard sees the row as the statement wrote it.
CREATE TRIGGER conversations_unpin_archived BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_unpin_archived();
