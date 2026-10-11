-- GOD (D-127, I-5 G2-G4): Arianna developed from inside Arianna.
-- god_plans: a plan GOD proposed in its chat (a block of its answer) and the
-- user approved; god_subtasks: its subtasks, each in a clone of its own
-- (repos/arianna/<part>, branch god/<part>) with the direct chat of the Coder
-- that does it and of the Reviewer that reviews it; god_carries: what a new
-- conversation with GOD reads from the one it restarts from ("Riassumi e
-- riparti", G4). Work data of Arianna's own code: L1 at most, never private.
-- The core never deletes (D-046): a subtask is discarded, not removed.
-- Deleting a conversation (purge_conversation, 0026; erase_conversation,
-- 0043): the plans and subtasks born there stay, unlinked from its chats and
-- messages, as the cards of D-157 (they describe clones that are still on
-- the disk); the summaries a restarted conversation carries go with either
-- conversation. See docs/DATA-MODEL.md.

CREATE TABLE god_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL once the conversation is erased (the plan stays, unlinked).
  conversation_id  uuid REFERENCES conversations (id) ON DELETE SET NULL,
  -- The answer of GOD that holds the plan: approved once. NULL once the message is deleted.
  message_id       bigint UNIQUE REFERENCES messages (id) ON DELETE SET NULL,
  title            text NOT NULL CHECK (btrim(title) <> '' AND length(title) <= 120),
  -- The model of GOD's conversation when the user approved: the subtasks start on it (Claude or Codex).
  model            text CHECK (model ~ '^[a-z][a-z0-9-]{0,31}$'),
  label            privacy_label NOT NULL DEFAULT 'L1' CHECK (label <= 'L1'),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE god_subtasks (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id                 uuid NOT NULL REFERENCES god_plans (id),
  position                integer NOT NULL CHECK (position BETWEEN 1 AND 6),
  -- The folder of its clone in repos/arianna and the last segment of its branch.
  part                    text NOT NULL UNIQUE CHECK (part ~ '^g[0-9]{3}-[a-z0-9][a-z0-9-]{0,40}$'),
  title                   text NOT NULL CHECK (btrim(title) <> '' AND length(title) <= 120),
  goal                    text NOT NULL CHECK (btrim(goal) <> '' AND length(goal) <= 2000),
  -- The files it owns: paths of the repository, a folder ending with '/'.
  files                   jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array'),
  -- The positions of earlier subtasks of the plan it waits for.
  blocked_by              integer[] NOT NULL DEFAULT '{}',
  state                   text NOT NULL DEFAULT 'queued'
                          CHECK (state IN ('queued', 'working', 'reviewing', 'reviewed', 'attention', 'stopped', 'branch', 'discarded')),
  -- Why it waits or needs the user: our text, never one of the cloud.
  reason                  text CHECK (length(reason) <= 300),
  -- The Reviewer's verdict: approved, changes asked, or not said.
  review                  text CHECK (review IN ('ok', 'changes', 'unknown')),
  -- The chats of the Coder and of the Reviewer; NULL once erased (the subtask asks for the user).
  conversation_id         uuid REFERENCES conversations (id) ON DELETE SET NULL,
  review_conversation_id  uuid REFERENCES conversations (id) ON DELETE SET NULL,
  -- The commit of "Prepara il ramo" on god/<part>.
  commit_sha              text CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, position)
);

CREATE INDEX god_subtasks_open_idx ON god_subtasks (state) WHERE state IN ('queued', 'working', 'reviewing', 'reviewed', 'attention');

CREATE TABLE god_carries (
  -- The new conversation with GOD, and the one it restarts from.
  conversation_id       uuid PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
  from_conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  body                  text NOT NULL CHECK (btrim(body) <> '' AND length(body) <= 12000),
  label                 privacy_label NOT NULL DEFAULT 'L1' CHECK (label <= 'L1'),
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- A conversation deleted from the list (purge_conversation keeps its row,
-- with purged_at): the summaries it carries or that quote it go with its texts.
CREATE FUNCTION god_carries_purge() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  DELETE FROM god_carries WHERE conversation_id = NEW.id OR from_conversation_id = NEW.id;
  RETURN NEW;
END
$$;
CREATE TRIGGER god_carries_purge AFTER UPDATE OF purged_at ON conversations
  FOR EACH ROW WHEN (OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL) EXECUTE FUNCTION god_carries_purge();

GRANT SELECT, INSERT, UPDATE ON god_plans, god_subtasks TO arianna_app;
GRANT SELECT, INSERT ON god_carries TO arianna_app;
