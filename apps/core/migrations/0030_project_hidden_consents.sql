-- The consent to see hidden files in the page "Progetti" (D-135).
-- See docs/DATA-MODEL.md. Object names are never schema-qualified.

-- ---------------------------------------------------------------------------
-- project_hidden_consents: one row per project whose "Mostra nascosti" the
-- user ever turned on (hidden entries: a dot in front, node_modules, the
-- inside of .git); `shown` says whether it is on now. The row holds the
-- folder the project had when the user said yes: a project taken out and
-- added again with the same name in another folder does not inherit it (the
-- core compares the folder). Turning it off sets `shown` to false: the core
-- never deletes (D-046).
-- No text: a project name, a folder, a time. Turning it on and off are
-- events in the chain, written by the core (apps/core/src/project-browser.ts).
-- ---------------------------------------------------------------------------

CREATE TABLE project_hidden_consents (
  project     text PRIMARY KEY CHECK (project ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$'),
  folder      text NOT NULL CHECK (folder <> '' AND length(folder) <= 4096),
  shown       boolean NOT NULL DEFAULT true,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

-- The core says yes, says yes again for a moved project, and turns it off; it never deletes (D-046).
GRANT SELECT, INSERT, UPDATE ON project_hidden_consents TO arianna_app;
