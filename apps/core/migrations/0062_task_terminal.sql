-- The terminal of a run of the Coder, saved (D-095, tappa 1; the user's choice
-- of 2026-10-14 during the test: "Salva comandi e uscite"). See
-- docs/DATA-MODEL.md. Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- task_terminal: the commands the Coder runs with Bash and what they print,
-- as the "Computer" panel of the chat shows them live (apps/core/src/
-- live-terminal.ts): already cut by @arianna/executors (200 lines or 16 KiB),
-- a line holding a value revealed by the vault replaced, a value split over
-- lines refusing the whole text (empty text, refused). The values of a
-- project's own `.env` are not known to the vault: those stay, as on the page.
-- Label: the project's, or the brief's when higher; only L0 and L1, never
-- above the clearance of the conversation. Never for an incognito
-- conversation (D-136). At most 400 rows per delegation.
-- Rows hang on their delegation: when a purge deletes the delegation
-- (purge_conversation, purge_incognito), the cascade deletes them, so no purge
-- function changes. The application role only inserts and reads; there is no
-- append_only trigger, which would need an exception of purge_target for the
-- cascade: arianna_app has no UPDATE nor DELETE, and that is enough.
-- ---------------------------------------------------------------------------

CREATE TABLE task_terminal (
  id             bigserial PRIMARY KEY,
  delegation_id  bigint NOT NULL REFERENCES task_delegations (id) ON DELETE CASCADE,
  ts             timestamptz NOT NULL DEFAULT now(),
  call_id        text NOT NULL CHECK (call_id <> '' AND char_length(call_id) <= 128 AND call_id !~ '[[:cntrl:]]'),
  part           text NOT NULL CHECK (part IN ('command', 'output')),
  label          privacy_label NOT NULL CHECK (label IN ('L0', 'L1')),
  text           text NOT NULL CHECK (octet_length(text) <= 65536),
  truncated      boolean NOT NULL,
  hidden         integer NOT NULL CHECK (hidden >= 0),
  refused        boolean NOT NULL DEFAULT false,
  error          boolean NOT NULL DEFAULT false,
  CONSTRAINT task_terminal_refused_empty CHECK (NOT refused OR text = '')
);

CREATE INDEX task_terminal_delegation_idx ON task_terminal (delegation_id, id);

-- A row of a delegation of a live, not incognito conversation, within its
-- clearance, under the cap.
CREATE FUNCTION task_terminal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  d task_delegations;
  c conversations;
BEGIN
  SELECT * INTO d FROM task_delegations WHERE id = NEW.delegation_id;
  IF NOT FOUND THEN
    -- The foreign key reports it with its own message.
    RETURN NEW;
  END IF;
  SELECT c2.* INTO c FROM tasks t JOIN conversations c2 ON c2.id = t.conversation_id WHERE t.id = d.task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_terminal: delegation % has no conversation', d.id USING ERRCODE = 'check_violation';
  END IF;
  IF c.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'task_terminal: conversation % was deleted', c.id USING ERRCODE = 'check_violation';
  END IF;
  IF c.incognito THEN
    RAISE EXCEPTION 'task_terminal: conversation % is incognito', c.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.label > c.clearance THEN
    RAISE EXCEPTION 'task_terminal: label % is above the clearance of conversation %', NEW.label, c.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- One writer at a time per delegation, so that the cap holds.
  -- The cap of 400 is MAX_SAVED_TERMINAL in apps/core/src/live-terminal.ts too: change both together.
  PERFORM pg_advisory_xact_lock(hashtext('task_terminal:' || d.id::text));
  IF (SELECT count(*) FROM task_terminal WHERE delegation_id = d.id) >= 400 THEN
    RAISE EXCEPTION 'task_terminal: delegation % has 400 rows already', d.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER task_terminal_guard BEFORE INSERT ON task_terminal
  FOR EACH ROW EXECUTE FUNCTION task_terminal_guard();

-- Insert and read only for the application role (D-046); the cascade of a purge deletes.
GRANT SELECT, INSERT ON task_terminal TO arianna_app;
GRANT USAGE ON SEQUENCE task_terminal_id_seq TO arianna_app;
