-- The card in full (I-13, D-152, request of the user of 2026-10-10): priority,
-- the day it is done on, links, a checklist and attached files. The body and
-- the criteria are `goal` and `done_criteria` of 0001. See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- tasks.priority: 0 none, 1 Bassa, 2 Media, 3 Alta, 4 Altissima (the user's
-- Notion board). tasks.planned_on: the day the user means to do it
-- ("Data esecuzione"), apart from the due day.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD CONSTRAINT tasks_priority_range CHECK (priority BETWEEN 0 AND 4);
ALTER TABLE tasks ADD COLUMN planned_on date;
ALTER TABLE tasks ADD CONSTRAINT tasks_planned_only_cards CHECK (planned_on IS NULL OR conversation_id IS NULL);

-- Between a card and its links, checklist and files: only cards, and a
-- removal that is set once (the core never deletes, D-046).
CREATE FUNCTION card_parts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT FROM tasks WHERE id = NEW.task_id AND conversation_id IS NOT NULL) THEN
      RAISE EXCEPTION '%: only on cards', TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.task_id <> OLD.task_id OR NEW.created_at <> OLD.created_at OR OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION '% %: its card and birth never change, and a removed one stays removed', TG_TABLE_NAME, OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- card_links: a link the user put on a card. http(s) only.
-- ---------------------------------------------------------------------------

CREATE TABLE card_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks (id),
  url         text NOT NULL CHECK (url ~ '^https?://' AND length(url) <= 2000),
  title       text CHECK (title IS NULL OR (btrim(title) <> '' AND length(title) <= 200)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz
);
CREATE INDEX card_links_task_idx ON card_links (task_id) WHERE removed_at IS NULL;
CREATE TRIGGER card_links_guard BEFORE INSERT OR UPDATE ON card_links FOR EACH ROW EXECUTE FUNCTION card_parts_guard();

-- ---------------------------------------------------------------------------
-- card_checklist: the items to tick on a card, in order.
-- ---------------------------------------------------------------------------

CREATE TABLE card_checklist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks (id),
  body        text NOT NULL CHECK (btrim(body) <> '' AND length(body) <= 300 AND strpos(body, chr(10)) = 0),
  done        boolean NOT NULL DEFAULT false,
  position    integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz
);
CREATE INDEX card_checklist_task_idx ON card_checklist (task_id, position) WHERE removed_at IS NULL;
CREATE TRIGGER card_checklist_guard BEFORE INSERT OR UPDATE ON card_checklist FOR EACH ROW EXECUTE FUNCTION card_parts_guard();

-- ---------------------------------------------------------------------------
-- card_files: a file attached to a card. The bytes are a copy in
-- data/cards/<task>/<id> (outside git, private): here only the name the user
-- gave, the type, the size and the sha256. At least L2: a file is the user's
-- and nothing of it leaves this machine.
-- ---------------------------------------------------------------------------

CREATE TABLE card_files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks (id),
  name        text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200 AND strpos(name, '/') = 0 AND strpos(name, chr(10)) = 0),
  media_type  text NOT NULL CHECK (media_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'),
  size        integer NOT NULL CHECK (size >= 0),
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  label       privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz
);
CREATE INDEX card_files_task_idx ON card_files (task_id) WHERE removed_at IS NULL;
CREATE TRIGGER card_files_guard BEFORE INSERT OR UPDATE ON card_files FOR EACH ROW EXECUTE FUNCTION card_parts_guard();

-- The core adds, ticks and takes away; it never deletes (D-046).
GRANT SELECT, INSERT, UPDATE ON card_links, card_checklist, card_files TO arianna_app;
