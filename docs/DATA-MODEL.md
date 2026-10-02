# Modello dati (bozza PostgreSQL)

Bozza da rifinire task per task; migrazioni con uno strumento a scelta (voce in `DECISIONS.md`). Il task 0.3 crea `events`, `tasks` e `jobs`; le altre tabelle nascono con il task che le usa.

```sql
CREATE TYPE privacy_label AS ENUM ('L0','L1','L2','L3');
CREATE TYPE task_status AS ENUM ('inbox','ready','running','waiting_user','to_verify','done','failed');

-- Registro eventi append-only con catena di hash: fonte per HUD, ufficio pixel, audit.
-- Si scrive solo con append_event(), che prende un advisory lock, legge l'ultimo hash
-- e calcola hash = sha256(prev_hash || riga canonica). UPDATE e DELETE sono negati
-- al ruolo applicativo e bloccati da un trigger.
CREATE TABLE events (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  task_id     uuid,
  run_id      uuid,
  agent       text,
  kind        text NOT NULL,           -- es. step.started, gateway.blocked, approval.requested
  label       privacy_label NOT NULL DEFAULT 'L2',
  payload     jsonb NOT NULL DEFAULT '{}',   -- con label >= L2: solo riferimenti, mai contenuto
  prev_hash   bytea,
  hash        bytea NOT NULL
);

-- Chat: stesso storico per web e Telegram
CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode            text NOT NULL DEFAULT 'private',          -- work | private
  clearance       privacy_label NOT NULL DEFAULT 'L2',      -- tetto di lettura
  effective_label privacy_label NOT NULL DEFAULT 'L0',      -- massimo letto finora, solo crescente
  workspace       text,                                     -- repository in allowlist (mode = work)
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  ts              timestamptz NOT NULL DEFAULT now(),
  role            text NOT NULL,                            -- user | assistant | system
  channel         text NOT NULL DEFAULT 'web',              -- web | telegram | voice
  label           privacy_label NOT NULL DEFAULT 'L2',
  body            text NOT NULL,
  task_id         uuid
);

CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id       uuid REFERENCES tasks(id),
  conversation_id uuid REFERENCES conversations(id),
  title           text NOT NULL,
  goal            text,
  done_criteria   text,
  status          task_status NOT NULL DEFAULT 'inbox',     -- colonne cardwall
  label           privacy_label NOT NULL DEFAULT 'L2',
  clearance       privacy_label NOT NULL DEFAULT 'L2',
  effective_label privacy_label NOT NULL DEFAULT 'L0',      -- sostituisce il booleano "contaminated"
  assignee        text NOT NULL DEFAULT 'user',             -- 'user' oppure nome dell'agente
  area            text,
  priority        integer NOT NULL DEFAULT 0,
  due_at          timestamptz,
  limits          jsonb NOT NULL DEFAULT '{}',              -- max_steps, max_minutes, max_cost
  evidence        jsonb NOT NULL DEFAULT '[]',              -- prove: diff, test, documento
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'done' OR evidence <> '[]'::jsonb OR assignee = 'user')
);

-- Una sessione di un esecutore su un passo di un task
CREATE TABLE runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid NOT NULL REFERENCES tasks(id),
  step            integer NOT NULL,
  agent           text NOT NULL,
  executor        text NOT NULL,
  model           text,
  locality        text NOT NULL,                            -- local | cloud
  session_ref     text,                                     -- id per --resume; mai credenziali
  workspace       text,                                     -- worktree, relativo ad ARIANNA_HOME
  effective_label privacy_label NOT NULL DEFAULT 'L0',
  status          text NOT NULL DEFAULT 'running',          -- running|ok|failed|cancelled|limit
  steps_used      integer NOT NULL DEFAULT 0,
  tokens_in       bigint, tokens_out bigint, cost_estimate numeric,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  CHECK (locality = 'local' OR effective_label <= 'L1')     -- difesa in profondità nel database
);

CREATE TABLE approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid REFERENCES tasks(id),                    -- facoltativo: impostazioni e declassamenti
  kind        text NOT NULL,                                -- action | declassify | budget | setting
  action      text NOT NULL,
  detail      jsonb NOT NULL,                               -- per declassify: testo esatto e suo sha256
  state       text NOT NULL DEFAULT 'pending',              -- pending|approved|rejected|expired
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  decided_via text                                          -- web | telegram | phone
);

-- Ogni cambio di etichetta; abbassare richiede un'approvazione
CREATE TABLE label_changes (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  subject     text NOT NULL,                                -- es. document:<id>, task:<id>, brief:<sha256>
  from_label  privacy_label NOT NULL,
  to_label    privacy_label NOT NULL,
  approval_id uuid REFERENCES approvals(id),
  CHECK (to_label >= from_label OR approval_id IS NOT NULL)
);

-- Cosa è uscito (o è stato bloccato) dal gateway
CREATE TABLE gateway_log (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  task_id     uuid, run_id uuid,
  target_kind text NOT NULL,                                -- executor | channel | web
  target      text NOT NULL,
  label       privacy_label NOT NULL,                       -- massimo del payload
  decision    text NOT NULL,                                -- allow|block
  rule        text NOT NULL,                                -- regola che ha deciso
  reason      text NOT NULL,
  bytes_out   integer,
  payload_sha256 text,
  summary     text                                          -- mai contenuto L2
);

CREATE TABLE router_decisions (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  task_id     uuid, run_id uuid, step integer,
  label       privacy_label NOT NULL,
  difficulty  text, executor text, model text,
  candidates  jsonb,                                        -- esclusi e perché
  reason      text, escalated_from text
);

-- Coda e scheduler (D-004): FOR UPDATE SKIP LOCKED, dietro l'interfaccia JobQueue
CREATE TABLE jobs (
  id          bigserial PRIMARY KEY,
  queue       text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  run_at      timestamptz NOT NULL DEFAULT now(),           -- anche per i job pianificati
  attempts    integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  locked_at   timestamptz, locked_by text,
  status      text NOT NULL DEFAULT 'queued',               -- queued|running|done|failed
  last_error  text
);

-- Fase 2
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 text UNIQUE NOT NULL, path text NOT NULL,
  kind text, label privacy_label NOT NULL DEFAULT 'L2',
  extracted jsonb, ingested_at timestamptz NOT NULL DEFAULT now()
);
```

## Note

- **Ripresa dopo riavvio:** all'avvio il core rimette in coda i job `running` con lock scaduto; un run interrotto riparte con `resume(session_ref)` se l'esecutore lo consente, altrimenti dal passo. I passi devono essere idempotenti.
- **Percorsi:** sempre relativi ad `ARIANNA_HOME`.
- **Verifica della catena:** `arianna doctor` ricalcola gli hash di `events` e segnala la prima riga che non torna.
- **Ricerca (Fase 2):** Qdrant fuori da Postgres; indice testuale con `tsvector` o BM25 dedicato. Alternativa da valutare: `pgvector` al posto di Qdrant per avere un servizio in meno (`OPEN-QUESTIONS.md`).
