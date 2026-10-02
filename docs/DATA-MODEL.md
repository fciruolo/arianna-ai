# Modello dati (bozza PostgreSQL)

`events`, `tasks` e `jobs` esistono dal task 0.3 (`apps/core/migrations/0001_init.sql`); `approvals`, `label_changes` e `gateway_log` dal task 1.2 (`0002_gateway.sql`); `runs`, `tasks.waiting_reason` e la chiave dei job dal task 1.8 (`0003_runs.sql`); `conversations`, `messages`, `tasks.conversation_id` e la notifica degli eventi dal task 1.11 (`0004_chat.sql`). Per queste tabelle la definizione che fa fede è la migrazione. Le altre tabelle qui sotto sono una bozza e nascono con il task che le usa. Le migrazioni sono file SQL numerati, solo in avanti, applicati da un runner proprio (D-028): una migrazione già applicata non si modifica, se ne aggiunge una nuova.

```sql
CREATE TYPE privacy_label AS ENUM ('L0','L1','L2','L3');
CREATE TYPE task_status AS ENUM ('inbox','ready','running','waiting_user','to_verify','done','failed');

-- Registro eventi append-only con catena di hash: fonte per HUD, ufficio pixel, audit.
-- Si scrive con un normale INSERT: il trigger events_chain prende un advisory lock,
-- legge l'ultimo hash e assegna id, ts, prev_hash e hash = sha256(prev_hash || riga
-- canonica), ignorando i valori passati da chi scrive. UPDATE, DELETE e TRUNCATE sono
-- bloccati da trigger. verify_event_chain() restituisce l'id del primo evento che
-- non torna, NULL se la catena è integra.
CREATE TABLE events (
  id          bigint PRIMARY KEY,      -- da events_id_seq, assegnato dal trigger
  ts          timestamptz NOT NULL,    -- assegnato dal trigger
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
  conversation_id uuid REFERENCES conversations(id),        -- clearance <= quella della conversazione, immutabile
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
  CHECK (status <> 'done' OR evidence <> '[]'::jsonb OR assignee = 'user'),
  CHECK (effective_label <= clearance)                      -- sopra il tetto non si legge
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

-- Si decide una volta sola; poi la riga è congelata (trigger), e non si cancella.
CREATE TABLE approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid REFERENCES tasks(id),                    -- facoltativo: impostazioni e declassamenti
  kind        text NOT NULL,                                -- action | declassify | budget | setting
  action      text NOT NULL,
  detail      jsonb NOT NULL,                               -- per declassify: text, sha256, from, to
  state       text NOT NULL DEFAULT 'pending',              -- pending|approved|rejected|expired
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,                                  -- presente se e solo se non è pending
  decided_via text                                          -- web | telegram | phone; solo approved/rejected
  -- declassify: L2 -> L1/L0 o L1 -> L0, mai da L3; sha256 = hash di text; si decide solo da web
);

-- Ogni cambio di etichetta, append-only. Abbassare richiede un'approvazione declassify
-- approvata per lo stesso testo (subject = content:<sha256>) e le stesse etichette (trigger).
CREATE TABLE label_changes (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  subject     text NOT NULL,                                -- es. content:<sha256>, document:<id>, task:<id>
  from_label  privacy_label NOT NULL,
  to_label    privacy_label NOT NULL,
  approval_id uuid UNIQUE REFERENCES approvals(id),          -- un'approvazione si usa una volta
  CHECK (to_label <> from_label),
  CHECK (to_label > from_label OR approval_id IS NOT NULL)
);

-- Ogni decisione del gateway, consentita o bloccata, scritta prima dell'invio. Append-only.
-- Vincoli: nessuna uscita consentita di L3; verso il cloud al massimo L1; summary solo se allow e <= L1.
CREATE TABLE gateway_log (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  task_id     uuid, run_id uuid,
  target_kind text NOT NULL,                                -- executor | channel | web
  target      text NOT NULL,
  locality    text NOT NULL,                                -- local | cloud
  label       privacy_label NOT NULL,                       -- massimo del payload
  decision    text NOT NULL,                                -- allow|block
  rule        text NOT NULL,                                -- regola che ha deciso
  reason      text NOT NULL,
  bytes_out   integer,
  payload_sha256 text,
  summary     text                                          -- mai contenuto L2
);

-- Task 1.7 (0005_router_decisions.sql, D-040): append-only
CREATE TABLE router_decisions (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  task_id     uuid, run_id uuid, step integer,
  label       privacy_label NOT NULL,                       -- effective_label del run
  difficulty  text NOT NULL,                                -- trivial|normal|hard|critical
  decision    text NOT NULL,                                -- route|wait
  executor text, model text, locality text,                 -- solo per route; model è un alias
  next text, retry_at timestamptz,                          -- solo per wait: retry-later|wait-user
  approval    text,                                         -- budget (Fable)
  candidates  jsonb NOT NULL,                               -- ogni candidato con esito: chosen o motivo d'esclusione
  reason      text NOT NULL,                                -- etichette, regole e candidati, mai contenuto
  escalated_from text
);
-- Vincoli: route verso il cloud solo fino a L1; claude e codex sempre cloud; mai L3 instradato;
-- alias coerente con l'esecutore; per wait niente esecutore né approvazione; retry_at solo con retry-later.

-- Task 1.15 (0006_telegram.sql, D-044): una sola riga
CREATE TABLE telegram_state (
  id              boolean PRIMARY KEY DEFAULT true,         -- sempre true: una riga
  conversation_id uuid NOT NULL REFERENCES conversations,   -- solo una conversazione work; non cambia
  update_offset   bigint NOT NULL DEFAULT 0,                -- offset di getUpdates; sale, salvo dopo due giorni senza update
  last_update_at  timestamptz,                              -- ultimo update gestito
  event_cursor    bigint NOT NULL DEFAULT 0,                -- ultimo evento trasformato in avvisi; sale soltanto
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- Vincoli: CHECK (id) per la riga unica; un trigger ammette solo una conversazione work, ne vieta il
-- cambio e vieta di abbassare i contatori (l'offset si può abbassare solo se telegram_offset_stale).

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

- **Ripresa dopo riavvio (task 1.8, D-035):** un worker tiene un job aggiornando `locked_at` (heartbeat a un terzo del timeout); all'avvio e poi a ogni timeout il core rimette in coda i job `running` con lock scaduto (o li segna `failed` se i tentativi sono finiti). Il passo riparte: il run rimasto `running` diventa `interrupted` e il nuovo run ha `resumed_from` e riceve il suo `session_ref` per `resume`. I passi devono essere idempotenti. Un solo run `running` per task (indice unico) e un solo job attivo per chiave (`task:<id>`).
- **Motore dei task (`apps/core/src/engine.ts`):** un job `task.step` per passo; prima di ogni passo si controllano i tetti (passi, minuti di lavoro dei run, euro oltre gli abbonamenti) e, se raggiunti, il task va in "Attende te" con il motivo in `waiting_reason`. Esiti del passo: continua, finito (con prove → "Da verificare"), approvazione (riga in `approvals` di tipo `action`, solo per azioni elencate nella scheda), attesa dell'utente, fallito. Stato, run, job ed evento si scrivono nella stessa transazione. Negli eventi va solo la causa di un cambio di stato, mai il motivo testuale, che può contenere dati dell'esecutore; `jobs.last_error` contiene solo un codice d'errore. Nessun passo senza tetto di passi e di tempo (il più stretto fra scheda e task). Un run eredita `effective_label` del task, e un'approvazione chiesta da un passo ne porta l'etichetta in `approvals.label`: un canale esterno la deve controllare prima di mostrarne `detail`; Telegram (1.15, D-044) non lo mostra mai.
- **Chat (task 1.11, D-039):** la clearance di una conversazione segue la modalità (`work` L1, `private` L2) e non cambia; `effective_label` sale soltanto, alzata da un trigger a ogni messaggio. Un messaggio non supera la clearance della sua conversazione, non è mai L3, e il suo task deve essere della stessa conversazione; i messaggi non si modificano né si cancellano. Ogni messaggio dell'utente nasce insieme al suo task (prima il task, poi il messaggio con `task_id`, stessa transazione). La risposta dell'assistente si salva solo dopo una riga `allow` in `gateway_log` verso `channel:web`. I frammenti della risposta in streaming non si salvano: viaggiano con `pg_notify` sul canale `arianna_deltas:<schema>`.
- **Telegram (task 1.15, D-044):** il bot scrive in una sola conversazione `work`, legata in `telegram_state`; un messaggio da Telegram è un messaggio dell'utente con `channel = 'telegram'`, scritto nella stessa transazione che sposta `update_offset`, così un aggiornamento si applica una volta sola. Un pulsante decide un'approvazione con `decided_via = 'telegram'` nella stessa transazione dell'offset; i declassamenti restano solo web (`approvals_declassify_via_web`). Gli avvisi verso Telegram nascono dagli eventi `approval.requested` e `message.created`, letti in ordine da `event_cursor`: dopo un crollo un avviso può ripetersi, non perdersi. Ogni testo verso Telegram ha la sua riga in `gateway_log` (`target = 'telegram'`). Dopo una settimana senza update Telegram può ripartire con id più bassi: dopo due giorni di quiete (`telegram_offset_stale`; Telegram tiene un update non consegnato 24 ore) qualsiasi id è nuovo. Un update o un evento che fallisce sempre per un errore che non è di rete si salta dopo alcuni tentativi, con un evento `telegram.failed` che porta solo un codice. Gli aggiornamenti di chi non è ammesso lasciano al massimo un evento `telegram.ignored` al minuto, senza id né contenuto. Il titolo mostrato in un avviso è quello del task, la cui etichetta è `tasks.label`: un futuro aggiornamento del titolo dovrà rispettarla.
- **Notifica degli eventi:** un trigger fa `pg_notify('arianna_events:<schema>', id)` a ogni nuovo evento, consegnato al commit; chi ascolta legge l'evento dalla tabella. Il canale porta lo schema, così i test in schemi separati non si sentono fra loro.
- **Percorsi:** sempre relativi ad `ARIANNA_HOME`.
- **Verifica della catena:** `verifyEventChain` (in `apps/core/src/events.ts`, poi dentro `arianna doctor`) ricalcola gli hash di `events` e segnala la prima riga che non torna.
- **Limiti della catena, da chiudere più avanti:**
  - la cancellazione degli ultimi eventi non si vede dalla sola catena: serve un'ancora esterna, cioè l'ultimo hash salvato periodicamente fuori dal database (con `arianna export`, Fase 2);
  - oggi c'è un solo ruolo di database, proprietario delle tabelle, che può disattivare i trigger: la manomissione resta rilevabile ma non impedita. Un ruolo applicativo senza diritti di modifica dello schema arriva con la password non predefinita (task 1.13), che il vault (task 1.14, D-042) può custodire;
  - le transazioni che scrivono eventi devono usare l'isolamento predefinito (READ COMMITTED). Con un altro livello la scrittura fallisce invece di biforcare la catena: lo impone il vincolo `events_single_successor`;
  - il lock della catena dura fino al commit: l'evento si scrive come ultima istruzione di una transazione breve.
- **Test con il database:** `pnpm test:db` crea uno schema usa e getta per ogni file di test e applica le migrazioni da zero (D-029).
- **Ricerca (Fase 2):** Qdrant fuori da Postgres; indice testuale con `tsvector` o BM25 dedicato. Alternativa da valutare: `pgvector` al posto di Qdrant per avere un servizio in meno (`OPEN-QUESTIONS.md`).
