-- The expense tracker (I-18, D-183): bank accounts, the imports of their
-- statements, the movements, the user's categories, rules and budgets; and
-- the finance mark of conversations, tasks and runs. See docs/DATA-MODEL.md
-- and docs/FINANCE-API.md. Object names are never schema-qualified.
--
-- Everything here is the user's and private (L2 at least, source finance:*):
-- it stays on this machine. The gateway refuses every cloud target for it
-- and for a context that has read it (rule finance); the database holds the
-- mark of such a context so that the core recreates it marked. The file of
-- a statement is never stored: only the movements read from it.
-- The core writes rows; what is removed (an import undone, a category, a rule,
-- a budget) goes only through finance_delete, which runs as the owner like
-- erase_conversation (D-157): arianna_app has no DELETE (D-046).

-- ---------------------------------------------------------------------------
-- Accounts, imports, movements
-- ---------------------------------------------------------------------------

CREATE TABLE finance_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 80 AND name !~ '[\r\n]'),
  currency    text NOT NULL DEFAULT 'EUR' CHECK (currency ~ '^[A-Z]{3}$'),
  -- The bank profile of the last import (BankProfile of @arianna/finance): column names and formats.
  profile     jsonb CHECK (profile IS NULL OR (jsonb_typeof(profile) = 'object' AND length(profile::text) <= 8000)),
  archived    boolean NOT NULL DEFAULT false,
  label       privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE finance_imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES finance_accounts (id),
  -- The name of the file the user chose; the file itself is not kept.
  name        text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 255 AND name !~ '[\r\n]'),
  imported    integer NOT NULL CHECK (imported >= 0),
  duplicates  integer NOT NULL CHECK (duplicates >= 0),
  rejected    integer NOT NULL CHECK (rejected >= 0),
  label       privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX finance_imports_account_idx ON finance_imports (account_id, created_at DESC);

CREATE TABLE finance_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 60 AND name !~ '[\r\n]'),
  kind        text NOT NULL CHECK (kind IN ('out', 'in')),
  label       privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX finance_categories_name_key ON finance_categories (lower(name));

CREATE TABLE finance_transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order of insertion: chronological within an import, what orders a day's rows.
  seq          bigserial NOT NULL UNIQUE,
  account_id   uuid NOT NULL REFERENCES finance_accounts (id),
  -- Undoing the import takes its rows with it.
  import_id    uuid NOT NULL REFERENCES finance_imports (id) ON DELETE CASCADE,
  booked       date NOT NULL,
  value_date   date,
  description  text NOT NULL CHECK (length(description) <= 2000),
  -- The description without case or accents, for the search of the page and of the agent.
  search       text NOT NULL CHECK (length(search) <= 4000),
  amount       bigint NOT NULL,
  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance      bigint,
  -- sha256 of account, day, amount, description and occurrence (@arianna/finance fingerprint).
  fingerprint  text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  category_id  uuid REFERENCES finance_categories (id),
  -- How it got its category: a rule of the user, or the user's own choice.
  category_by  text CHECK (category_by IN ('rule', 'user')),
  label        privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_transactions_category CHECK ((category_id IS NULL) = (category_by IS NULL)),
  -- The same movement imported twice is the same row.
  CONSTRAINT finance_transactions_fingerprint_key UNIQUE (account_id, fingerprint)
);

CREATE INDEX finance_transactions_booked_idx ON finance_transactions (account_id, booked, seq);
CREATE INDEX finance_transactions_import_idx ON finance_transactions (import_id);
CREATE INDEX finance_transactions_category_idx ON finance_transactions (category_id) WHERE category_id IS NOT NULL;

-- A movement is what the bank wrote: only its category changes.
CREATE FUNCTION finance_transactions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.id, NEW.seq, NEW.account_id, NEW.import_id, NEW.booked, NEW.value_date, NEW.description, NEW.search, NEW.amount,
      NEW.currency, NEW.balance, NEW.fingerprint, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.seq, OLD.account_id, OLD.import_id, OLD.booked, OLD.value_date, OLD.description, OLD.search, OLD.amount,
      OLD.currency, OLD.balance, OLD.fingerprint, OLD.created_at) THEN
    RAISE EXCEPTION 'finance movement %: only its category changes', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.label < OLD.label THEN
    RAISE EXCEPTION 'finance movement %: the label cannot go down', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER finance_transactions_guard BEFORE UPDATE ON finance_transactions
  FOR EACH ROW EXECUTE FUNCTION finance_transactions_guard();

-- An import is a record of what happened: it never changes.
CREATE FUNCTION finance_imports_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'finance import %: it never changes', OLD.id USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER finance_imports_frozen BEFORE UPDATE ON finance_imports
  FOR EACH ROW EXECUTE FUNCTION finance_imports_frozen();

-- An account keeps its id, currency and birth; the label only goes up.
CREATE FUNCTION finance_accounts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.id, NEW.currency, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.currency, OLD.created_at) THEN
    RAISE EXCEPTION 'finance account %: its id, currency and birth never change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.label < OLD.label THEN
    RAISE EXCEPTION 'finance account %: the label cannot go down', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER finance_accounts_guard BEFORE UPDATE ON finance_accounts
  FOR EACH ROW EXECUTE FUNCTION finance_accounts_guard();

-- ---------------------------------------------------------------------------
-- Rules and budgets of the user
-- ---------------------------------------------------------------------------

CREATE TABLE finance_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Words the normalized description must contain (matchRule of @arianna/finance).
  match        text NOT NULL CHECK (btrim(match) <> '' AND length(match) <= 200 AND match !~ '[\r\n]'),
  category_id  uuid NOT NULL REFERENCES finance_categories (id),
  label        privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE finance_budgets (
  category_id  uuid PRIMARY KEY REFERENCES finance_categories (id),
  -- Integer cents, positive.
  monthly      bigint NOT NULL CHECK (monthly > 0),
  label        privacy_label NOT NULL DEFAULT 'L2' CHECK (label >= 'L2'),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- When the default categories were written, once (the first opening of the page or of the agent).
CREATE TABLE finance_settings (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  seeded_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- finance_delete: what the user removes. Runs as the owner (arianna_app has
-- no DELETE): an import undone with its movements, a category (its movements
-- go back without one, its rules and budget go with it), a rule, the budget
-- of a category. No such row: P0002.
-- ---------------------------------------------------------------------------

CREATE FUNCTION finance_delete(p_kind text, p_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout = '5s' AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF p_kind = 'import' THEN
    PERFORM 1 FROM finance_imports WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance import % does not exist', p_id USING ERRCODE = 'no_data_found';
    END IF;
    DELETE FROM finance_transactions WHERE import_id = p_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    DELETE FROM finance_imports WHERE id = p_id;
  ELSIF p_kind = 'category' THEN
    PERFORM 1 FROM finance_categories WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance category % does not exist', p_id USING ERRCODE = 'no_data_found';
    END IF;
    UPDATE finance_transactions SET category_id = NULL, category_by = NULL WHERE category_id = p_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    DELETE FROM finance_rules WHERE category_id = p_id;
    DELETE FROM finance_budgets WHERE category_id = p_id;
    DELETE FROM finance_categories WHERE id = p_id;
  ELSIF p_kind = 'rule' THEN
    DELETE FROM finance_rules WHERE id = p_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance rule % does not exist', p_id USING ERRCODE = 'no_data_found';
    END IF;
  ELSIF p_kind = 'budget' THEN
    DELETE FROM finance_budgets WHERE category_id = p_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance budget % does not exist', p_id USING ERRCODE = 'no_data_found';
    END IF;
  ELSE
    RAISE EXCEPTION 'finance_delete: unknown kind %', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v_count;
END
$$;

-- The schema of this migration, then pg_temp last, as erase_conversation (0043).
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION finance_delete(text, uuid) SET search_path = %I, pg_temp', current_schema());
END
$$;

REVOKE ALL ON FUNCTION finance_delete(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance_delete(text, uuid) TO arianna_app;

-- ---------------------------------------------------------------------------
-- The finance mark (D-183): a conversation, task or run that has read finance
-- data. Set, it never goes back to false; it needs the private side (L2 read).
-- ---------------------------------------------------------------------------

ALTER TABLE conversations ADD COLUMN finance boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ADD CONSTRAINT conversations_finance_private
  CHECK (NOT finance OR (mode = 'private' AND effective_label = 'L2'));

ALTER TABLE tasks ADD COLUMN finance boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD CONSTRAINT tasks_finance_read CHECK (NOT finance OR effective_label = 'L2');

ALTER TABLE runs ADD COLUMN finance boolean NOT NULL DEFAULT false;
-- Defense in depth, as runs_cloud_at_most_l1: no cloud run ever works for a marked task.
ALTER TABLE runs ADD CONSTRAINT runs_finance_local CHECK (NOT finance OR locality = 'local');

CREATE FUNCTION finance_mark_only_up() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD.finance AND NOT NEW.finance THEN
    RAISE EXCEPTION '% %: the finance mark never goes away', TG_TABLE_NAME, OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER conversations_finance_only_up BEFORE UPDATE OF finance ON conversations
  FOR EACH ROW EXECUTE FUNCTION finance_mark_only_up();
CREATE TRIGGER tasks_finance_only_up BEFORE UPDATE OF finance ON tasks
  FOR EACH ROW EXECUTE FUNCTION finance_mark_only_up();
CREATE TRIGGER runs_finance_only_up BEFORE UPDATE OF finance ON runs
  FOR EACH ROW EXECUTE FUNCTION finance_mark_only_up();

-- A task born in a marked conversation, or from a marked task, is marked: it
-- reads what they read. Marked, it has read L2.
CREATE FUNCTION tasks_finance_inherit() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT NEW.finance AND (
       EXISTS (SELECT FROM conversations c WHERE c.id = NEW.conversation_id AND c.finance)
       OR EXISTS (SELECT FROM tasks p WHERE p.id = NEW.parent_id AND p.finance)) THEN
    NEW.finance := true;
  END IF;
  IF NEW.finance THEN
    NEW.effective_label := 'L2';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tasks_finance_inherit BEFORE INSERT ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_finance_inherit();

-- A task that reads finance data marks its conversation: its answer is written there.
CREATE FUNCTION tasks_finance_to_conversation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.finance AND NOT OLD.finance AND NEW.conversation_id IS NOT NULL THEN
    UPDATE conversations SET finance = true, effective_label = 'L2'
    WHERE id = NEW.conversation_id AND NOT finance;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER tasks_finance_to_conversation AFTER UPDATE OF finance ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_finance_to_conversation();

-- A system chat about a marked task (D-064) holds its question and error: marked too.
CREATE FUNCTION conversations_finance_source() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT NEW.finance AND EXISTS (SELECT FROM tasks t WHERE t.id = NEW.source_task_id AND t.finance) THEN
    NEW.finance := true;
  END IF;
  IF NEW.finance THEN
    NEW.effective_label := 'L2';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER conversations_finance_source BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_finance_source();

-- A run works for its task: marked with it.
CREATE FUNCTION runs_finance_inherit() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (SELECT FROM tasks t WHERE t.id = NEW.task_id AND t.finance) THEN
    NEW.finance := true;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER runs_finance_inherit BEFORE INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION runs_finance_inherit();

-- The core writes and reads; what goes away goes through finance_delete (D-046).
GRANT SELECT, INSERT, UPDATE ON finance_accounts, finance_transactions, finance_categories, finance_rules, finance_budgets TO arianna_app;
GRANT SELECT, INSERT ON finance_imports, finance_settings TO arianna_app;
GRANT USAGE ON SEQUENCE finance_transactions_seq_seq TO arianna_app;
