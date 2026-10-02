-- Task 1.13: the application role (D-046). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.
--
-- The core works as arianna_app; the owner of the schema only migrates. The
-- role reads and writes rows and nothing else: it owns nothing, cannot create
-- objects, alter a table or disable a trigger, and has no DELETE or TRUNCATE
-- anywhere. Append-only tables get SELECT and INSERT only, so a stolen
-- connection of the core cannot rewrite history even before the triggers.
-- Every new table, and the sequence of a new bigserial, must be granted in its
-- own migration: the tests and `pnpm doctor` fail on a table the role cannot
-- read or a sequence it cannot use.

-- Roles belong to the cluster, not to the schema: created once, then only
-- kept within these limits. LOGIN and the password are set by the owner at
-- each start (prepareDatabase), from the vault or the development default.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'arianna_app') THEN
    CREATE ROLE arianna_app NOLOGIN;
  END IF;
END
$$;
ALTER ROLE arianna_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

DO $$
BEGIN
  -- No temporary tables: an unqualified name in a trigger function looks in
  -- pg_temp first, so a temporary `approvals` would fool the declassification
  -- guard of label_changes. PUBLIC has TEMP by default; nothing here uses it.
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM arianna_app', current_database());
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO arianna_app', current_schema());
  -- nextval for bigserial ids and for events_chain, which runs as the caller.
  EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA %I TO arianna_app', current_schema());
END
$$;

-- Append-only.
GRANT SELECT, INSERT ON events, gateway_log, label_changes, messages, router_decisions TO arianna_app;

-- Rows that change state; their guards (triggers) still decide what may change.
-- conversations also takes the row lock of messages_within_conversation, and
-- telegram_state the table lock of the channel: both need UPDATE.
GRANT SELECT, INSERT, UPDATE ON tasks, jobs, runs, approvals, conversations, telegram_state TO arianna_app;

-- For `pnpm doctor`, which checks that every migration is applied.
GRANT SELECT ON schema_migrations TO arianna_app;
