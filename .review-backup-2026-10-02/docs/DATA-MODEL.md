# Modello dati (bozza PostgreSQL)

Bozza da rifinire nel task 0.3; migrazioni con uno strumento a scelta (voce in `DECISIONS.md`).

```sql
CREATE TYPE privacy_label AS ENUM ('L0','L1','L2','L3');
CREATE TYPE task_status AS ENUM ('inbox','ready','running','waiting_user','to_verify','done','failed');

-- Registro eventi append-only: fonte per HUD, ufficio pixel, audit
CREATE TABLE events (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  task_id     uuid,
  agent       text,
  kind        text NOT NULL,           -- es. step.started, gateway.blocked, approval.requested
  label       privacy_label NOT NULL DEFAULT 'L2',
  payload     jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   uuid REFERENCES tasks(id),
  title       text NOT NULL,
  goal        text,
  status      task_status NOT NULL DEFAULT 'inbox',   -- colonne cardwall
  label       privacy_label NOT NULL DEFAULT 'L2',
  contaminated boolean NOT NULL DEFAULT false,        -- ha letto L2
  agent       text,
  due_at      timestamptz,
  limits      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks(id),
  action      text NOT NULL,
  detail      jsonb NOT NULL,
  state       text NOT NULL DEFAULT 'pending',        -- pending|approved|rejected
  decided_at  timestamptz
);

-- Cosa è uscito verso il cloud (dal gateway)
CREATE TABLE gateway_log (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  task_id     uuid,
  target      text NOT NULL,
  decision    text NOT NULL,                          -- allow|block
  reason      text NOT NULL,
  bytes_out   integer,
  summary     text
);

CREATE TABLE router_decisions (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  task_id     uuid, step integer,
  difficulty  text, executor text, model text,
  reason      text, escalated_from text
);

-- Fase 2
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 text UNIQUE NOT NULL, path text NOT NULL,
  kind text, label privacy_label NOT NULL DEFAULT 'L2',
  extracted jsonb, ingested_at timestamptz NOT NULL DEFAULT now()
);
```

Code: tabella `jobs` o DBOS (decisione D-004 in `DECISIONS.md`). Ricerca: Qdrant fuori da Postgres; indice testuale con `tsvector` o BM25 dedicato.
