-- The calls Arianna makes (D-066, third part). See docs/DATA-MODEL.md.
-- Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- push_subscriptions: the browsers that asked to be told "Arianna ti chiama"
-- when the chat is closed (Web Push). The endpoint is a URL of the browser's
-- push service (Apple, Google, Mozilla); the notification carries no content,
-- so the keys are kept only as the browser gave them.
-- ---------------------------------------------------------------------------

CREATE TABLE push_subscriptions (
  id         bigserial PRIMARY KEY,
  endpoint   text NOT NULL UNIQUE CHECK (endpoint LIKE 'https://%' AND char_length(endpoint) <= 2048),
  p256dh     text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{1,128}$'),
  auth       text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The browser unsubscribed or its push service said the address is gone.
  -- Never deleted: the application role deletes nothing (D-046).
  removed_at timestamptz
);

GRANT SELECT, INSERT, UPDATE ON push_subscriptions TO arianna_app;
GRANT USAGE ON SEQUENCE push_subscriptions_id_seq TO arianna_app;

-- The calls about a task: a task waiting for the user rings once per wait.
CREATE INDEX calls_task_idx ON calls (task_id, created_at) WHERE task_id IS NOT NULL;
