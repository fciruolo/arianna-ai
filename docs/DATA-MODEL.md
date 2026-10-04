# Modello dati (bozza PostgreSQL)

`events`, `tasks` e `jobs` esistono dal task 0.3 (`apps/core/migrations/0001_init.sql`); `approvals`, `label_changes` e `gateway_log` dal task 1.2 (`0002_gateway.sql`); `runs`, `tasks.waiting_reason` e la chiave dei job dal task 1.8 (`0003_runs.sql`); `conversations`, `messages`, `tasks.conversation_id` e la notifica degli eventi dal task 1.11 (`0004_chat.sql`); `router_decisions` dal task 1.7 (`0005_router_decisions.sql`); `telegram_state` dal task 1.15 (`0006_telegram.sql`); il ruolo `arianna_app` e i suoi permessi dal task 1.13 (`0007_app_role.sql`); `task_turns` dal task 1.10 (`0008_task_turns.sql`); `task_delegations`, `conversations.model` e `messages.agent` dalla seconda parte del 1.10 (`0009_delegations.sql`); `task_errors` e le colonne della chat di sistema da D-064 (`0013_task_errors.sql`); `messages.model` e i vincoli di Claude nella chat di sistema dalla seconda parte di D-064 (`0014_claude_direct.sql`); `calls` da D-066 (`0015_calls.sql`); `push_subscriptions` dalla terza parte di D-066 (`0016_push.sql`); `calls.rang_at` dalla sua revisione (`0017_calls_rang.sql`); `conversation_summaries` da D-077 (`0018_conversation_summaries.sql`). Per queste tabelle la definizione che fa fede è la migrazione. Le altre tabelle qui sotto sono una bozza e nascono con il task che le usa. Le migrazioni sono file SQL numerati, solo in avanti, applicati da un runner proprio (D-028): una migrazione già applicata non si modifica, se ne aggiunge una nuova.

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
  workspace       text,                                     -- nome del progetto approvato (mode = work, D-058); prima repos/<nome>
  model           text,                                     -- modello cloud scelto per i passi delegati (solo work; NULL: decide il router); in una chat di sistema chi risponde: sonnet | opus (Claude diretto) o NULL (Arianna in locale), D-064
  title           text,                                     -- una riga: dal primo messaggio o dall'utente (D-057); etichetta della conversazione
  archived_at     timestamptz,                              -- archiviata dall'utente; NULL: nella lista
  purged_at       timestamptz,                              -- testi cancellati per sempre (purge_conversation); non compare più
  origin          text NOT NULL DEFAULT 'user',             -- user | system: chat di sistema, aperta dal sistema (D-064)
  system_reason   text,                                     -- perché il sistema l'ha aperta: failure (task fallito); solo con origin = system
  source_task_id  uuid REFERENCES tasks(id),                -- il task di cui parla; una sola chat di sistema aperta per task e motivo
  question_attached boolean NOT NULL DEFAULT false,         -- l'utente ha allegato la domanda del task; da false a true, una volta
  source_error_id bigint REFERENCES task_errors(id),        -- l'ultimo errore del task raccontato nella chat; solo verso uno più recente
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Perché un task è fallito (D-064, migrazione 0013): niente testo, append-only
CREATE TABLE task_errors (
  id       bigserial PRIMARY KEY,
  task_id  uuid NOT NULL REFERENCES tasks(id),
  ts       timestamptz NOT NULL DEFAULT now(),
  origin   text NOT NULL,                                   -- local-model | claude | tool | engine
  code     text NOT NULL,                                   -- origine.tipo, es. local-model.unavailable; prefisso = origin
  details  jsonb NOT NULL DEFAULT '{}',                     -- solo valori scalari (scalar_details), lista chiusa per codice
  label    privacy_label NOT NULL DEFAULT 'L2'              -- l'etichetta effettiva del task
);

CREATE TABLE messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  ts              timestamptz NOT NULL DEFAULT now(),
  role            text NOT NULL,                            -- user | assistant | system
  channel         text NOT NULL DEFAULT 'web',              -- web | telegram | voice
  label           privacy_label NOT NULL DEFAULT 'L2',
  body            text NOT NULL,
  task_id         uuid,
  agent           text,                                     -- chi ha scritto un messaggio assistant se non è Arianna (coder); NULL: Arianna
  model           text                                      -- modello cloud che ha scritto la risposta del task (Claude in una chat di sistema, D-064); NULL: modello locale.
                                                            -- solo assistant senza agent; il trigger messages_model_work lo rifiuta fuori da una conversazione work (L1)
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
  kind        text NOT NULL,                                -- action | declassify | budget | setting | workspace (0010: cartella con modifiche non committate, D-056)
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
-- Contesto dell'orchestratore, un turno per passo completato (task 1.10, D-053). Append-only.
CREATE TABLE task_turns (
  id          bigserial PRIMARY KEY,
  task_id     uuid NOT NULL REFERENCES tasks(id),
  step        integer NOT NULL,
  run_id      uuid NOT NULL REFERENCES runs(id),           -- run locale dello stesso task e passo (trigger)
  label       privacy_label NOT NULL,                      -- massimo di ciò che il passo ha letto; <= clearance del task, mai L3
  answer      jsonb NOT NULL,                              -- {"action": ...} senza thought
  thought     text,                                        -- ragionamento (D-051): mai in chat
  result      text,                                        -- risultato o errore dello strumento, come lo legge il modello
  message_id  bigint REFERENCES messages(id),              -- risposta in chat che ha chiuso il task
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, step)
);

-- Passo delegato a un altro agente (task 1.10, seconda parte, D-055): una riga per chiamata task.delegate.
CREATE TABLE task_delegations (
  id            bigserial PRIMARY KEY,
  task_id       uuid NOT NULL REFERENCES tasks(id),
  step          integer NOT NULL,                           -- passo dell'orchestratore che ha delegato
  agent         text NOT NULL,                              -- coder
  brief         text NOT NULL,                              -- come l'ha scritto il modello
  label         privacy_label NOT NULL,                     -- del brief; scende solo con un declassamento approvato (label_changes)
  repo          text,                                       -- progetto della conversazione, o l'unico approvato (D-058)
  status        text NOT NULL DEFAULT 'pending',            -- pending | running | ok | failed | refused
  executor      text, model text,                           -- scelti dal router
  run_id        uuid REFERENCES runs(id),                   -- run cloud (ultimo tentativo)
  workspace_run uuid,                                       -- cartella data/worktrees/<id> quando si usa una copia; vuoto con D-056 (il Coder lavora nella cartella del progetto)
  session_ref   text,
  result        text, result_label privacy_label,           -- rapporto dell'agente o errore, come lo legge il passo locale successivo
  message_id    bigint REFERENCES messages(id),             -- rapporto salvato in chat (messages.agent = coder)
  created_at    timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  UNIQUE (task_id, step)
);
-- Vincoli (trigger task_delegations_guard): etichette entro la clearance del task; task, passo e brief
-- immutabili; una delega finita non cambia stato; run_id solo un run cloud dello stesso task; message_id
-- solo un messaggio dello stesso task; result_label alza effective_label del task. Mai DELETE.

-- Riassunto della storia che l'orchestratore non legge più messaggio per messaggio (D-077):
-- un pezzo per ogni salto dell'ancora, aggiunto in coda e mai riscritto. Append-only.
CREATE TABLE conversation_summaries (
  id                bigserial PRIMARY KEY,
  conversation_id   uuid NOT NULL REFERENCES conversations(id),
  first_message_id  bigint NOT NULL REFERENCES messages(id), -- primo e ultimo messaggio riassunti
  last_message_id   bigint NOT NULL REFERENCES messages(id), -- (user, assistant, system non scritti da un agente delegato)
  label             privacy_label NOT NULL,                  -- >= massimo dei messaggi riassunti; <= clearance di conversazione e task; mai L3
  body              text NOT NULL,                           -- al più 4000 caratteri (il core ne salva al più 2000); segnaposto senza contenuto se il gateway ha bloccato l'intervallo
  model             text NOT NULL,                           -- solo local-large (il modello dell'orchestratore): mai un esecutore cloud
  task_id           uuid NOT NULL REFERENCES tasks(id),      -- il passo dell'orchestratore che l'ha scritto
  run_id            uuid NOT NULL REFERENCES runs(id),       -- run locale in corso di quel task (trigger)
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, last_message_id)
);
-- Vincoli (trigger conversation_summaries_guard): conversazione non cancellata; task della conversazione
-- con il suo run locale in corso; messaggi della conversazione; il pezzo comincia subito dopo l'ultimo pezzo:
-- rifiuta sia le sovrapposizioni sia i buchi (nessun messaggio letto dall'orchestratore resta fra due pezzi);
-- etichetta come sopra; alza effective_label del task. Mai UPDATE né DELETE (solo purge_conversation).

-- Chiamate via internet (D-066): solo metadati, nessun testo. Quello che si è
-- detto sta in messages (channel 'voice'): le parole dell'utente con l'etichetta
-- della clearance, le risposte con la più alta fra la storia letta e l'etichetta
-- effettiva della conversazione (mai sopra la clearance).
-- 'in' la fa l'utente dalla chat; 'out' la fa Arianna, con il motivo ammesso
-- dalle regole di [voice.outgoing]. Una sola chiamata viva alla volta.
CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  direction text NOT NULL,          -- in | out
  reason text,                      -- solo out: waiting | task-done | scheduled
  task_id uuid REFERENCES tasks(id),-- il task che fa chiamare (out)
  status text NOT NULL,             -- scheduled | ringing | connecting | active | ended | missed | skipped | failed
  scheduled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz, ended_at timestamptz,
  end_reason text,                  -- codice chiuso: hangup, time-limit, disconnected, voice-error, core-restart, no-answer, quiet-hours, daily-limit, cancelled
  delegations integer NOT NULL DEFAULT 0,
  rang_at timestamptz               -- quando ha squillato (out): il massimo al giorno conta da qui
);
-- La cancellazione definitiva di una conversazione lascia le sue chiamate: non hanno testo.

-- Browser iscritti alle notifiche delle chiamate (Web Push, D-066): l'indirizzo è del
-- servizio push del browser (Apple, Google, Mozilla); la notifica non porta contenuto.
CREATE TABLE push_subscriptions (
  id bigserial PRIMARY KEY,
  endpoint text NOT NULL UNIQUE,   -- https, solo host dei servizi push (controllo nel core)
  p256dh text NOT NULL, auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz            -- disiscritto o indirizzo scaduto: mai cancellato (D-046)
);

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
- **Titolo e archivio (D-057):** il titolo nasce dal primo messaggio dell'utente e l'utente lo cambia; non va mai nel payload di un evento. Una conversazione archiviata esce dalla lista e non accetta nuovi messaggi dell'utente (trigger `messages_not_archived`) finché non è ripristinata; i suoi messaggi restano. La conversazione legata a Telegram non si archivia (`conversations_guard`). **Cancellazione definitiva:** solo `purge_conversation(uuid)` (migrazione `0012`, `SECURITY DEFINER`, eseguibile solo da `arianna_app`), su una conversazione archiviata i cui task non sono `ready`/`running` né hanno job attivi. Blocca solo le righe della conversazione e dei suoi task, come fa il core, mai una tabella; imposta per la transazione `arianna.purge`, che i trigger di guardia (`append_only`, `approvals_guard`, `conversations_guard`, tramite `purge_target`) rispettano solo quando chi esegue è il proprietario della tabella. Cancella messaggi, riassunti (`conversation_summaries`, dalla migrazione `0018`), turni e deleghe dei suoi task; svuota titolo della conversazione, titolo e obiettivo dei task (`Conversazione eliminata`), `detail` delle approvazioni (un declassamento resta con le etichette e un testo vuoto) e `last_error` dei job; ogni task non `done` né `failed` diventa `failed` e le sue approvazioni pendenti `expired`. Restituisce i task chiusi e le approvazioni scadute: il chiamante scrive `task.status` (causa `purge`) e `approval.decided` (stato `expired`) nella stessa transazione, poi `conversation.purged`. Restano `tasks`, `runs`, `approvals`, `jobs`, `gateway_log` (con il riassunto L1), `router_decisions`, `label_changes`, `events`. Le carte create dai task (figli con `parent_id`, senza conversazione) e le pagine della KB restano: sono oggetti a sé. Una conversazione cancellata non accetta più messaggi e non cambia più.
- **Errori leggibili e chat di sistema (D-064, migrazione `0013`):** quando un task fallisce (tentativi del job esauriti, worker morto, esito `failed` dell'esecutore) il core scrive nella stessa transazione una riga di `task_errors` e l'evento `task.failed` (L0, solo origine e codice). I dettagli sono scalari da una lista chiusa per codice (`apps/core/src/failures.ts`: endpoint, porta, stato HTTP, tentativi, codice SQL, esecutore, classe dell'errore), mai messaggi né output; il database rifiuta oggetti, liste e stringhe oltre 100 caratteri. Un task riprovato che fallisce di nuovo ha una riga nuova: vale l'ultima. `POST /api/tasks/:id/retry` riporta un task `failed` in `ready` con un job nuovo (evento `task.retried`), mai per una conversazione archiviata o eliminata. Una chat di sistema (`origin = 'system'`) prende il modo della conversazione del task (senza conversazione: privata; trigger `conversations_system_mode`), non ha progetto, ed è una sola per task finché non è eliminata (indice unico parziale); se ne apre una nuova solo per un task `failed` in quel momento. Il titolo nomina l'origine dell'errore, mai il task (il titolo del task è l'inizio della domanda). Riaperta dopo un nuovo fallimento, riceve un messaggio `system` con l'errore nuovo (`source_error_id`). Il primo messaggio, `role = 'system'`, contiene solo l'errore con l'etichetta della riga; la domanda del task entra solo con `POST /api/conversations/:id/question`, con la sua etichetta, una volta. L'orchestratore legge i messaggi `system` come messaggi dell'utente marcati. `purge_conversation` elimina prima, archiviandole, le chat di sistema sui task della conversazione (ricorsivo): una chat di sistema al lavoro blocca l'intera eliminazione. Quell'archiviazione non scrive `conversation.archived`: basta `conversation.purged` con `cause: 'source'`. `task_errors` resta: non ha testi.
- **Telegram (task 1.15, D-044):** il bot scrive in una sola conversazione `work`, legata in `telegram_state`; un messaggio da Telegram è un messaggio dell'utente con `channel = 'telegram'`, scritto nella stessa transazione che sposta `update_offset`, così un aggiornamento si applica una volta sola. Un pulsante decide un'approvazione con `decided_via = 'telegram'` nella stessa transazione dell'offset; i declassamenti restano solo web (`approvals_declassify_via_web`). Gli avvisi verso Telegram nascono dagli eventi `approval.requested` e `message.created`, letti in ordine da `event_cursor`: dopo un crollo un avviso può ripetersi, non perdersi. Ogni testo verso Telegram ha la sua riga in `gateway_log` (`target = 'telegram'`). Dopo una settimana senza update Telegram può ripartire con id più bassi: dopo due giorni di quiete (`telegram_offset_stale`; Telegram tiene un update non consegnato 24 ore) qualsiasi id è nuovo. Un update o un evento che fallisce sempre per un errore che non è di rete si salta dopo alcuni tentativi, con un evento `telegram.failed` che porta solo un codice. Gli aggiornamenti di chi non è ammesso lasciano al massimo un evento `telegram.ignored` al minuto, senza id né contenuto. Il titolo mostrato in un avviso è quello del task, la cui etichetta è `tasks.label`: un futuro aggiornamento del titolo dovrà rispettarla.
- **Delega (task 1.10, seconda parte, D-055):** una chiamata `task.delegate` scrive il turno (senza risultato) e una riga in `task_delegations` nella stessa transazione; il passo successivo del task è il run cloud (`runs.locality = cloud`, `effective_label` del run = etichetta del brief, non del task), che aggiorna la riga; il passo dopo legge `result` come risultato dello strumento. Un brief sopra L1 aspetta un'approvazione `declassify` (cercata per `detail.sha256` del brief); Fable un'approvazione `budget` (`detail.step` = passo della delega). Un rifiuto di quota rimette la delega `pending` e riaccoda lo stesso passo (`jobs.run_at`, evento `task.retry`); il run finisce `failed`. Con D-056 la cartella di lavoro è il repository stesso: modifiche non committate (`git status`) fermano il task con un'approvazione `workspace` (`detail.step` = passo della delega, `detail.files` = percorsi); i file cambiati dal run finiscono in `result`, non nel messaggio del Coder. Il rapporto del Coder è un messaggio con `agent = 'coder'`, che l'orchestratore non rilegge come storia della chat e che il controllo "task già risposto" ignora.
- **Orchestratore (task 1.10, D-053):** il contesto di un task si ricostruisce a ogni passo dai messaggi della conversazione fino a quello che l'ha aperto e dai suoi `task_turns`, mai da quelli di altri task. Dei messaggi legge il riassunto (`conversation_summaries`, pezzi con `last_message_id` fino a quel messaggio) e quelli da un'ancora in poi (D-077): l'ancora si ricalcola dai messaggi dopo l'ultimo pezzo, resta ferma fino a 30 messaggi o 24.000 caratteri e poi salta lasciandone 10; i messaggi lasciati indietro diventano un pezzo nuovo, scritto dal modello locale al primo passo del task, prima della risposta (i passi successivi leggono soltanto). Un intervallo che il gateway blocca riceve un pezzo segnaposto senza contenuto; uno sopra la clearance del task nessun pezzo. Senza il pezzo (modello fermo, conflitto, massimo di pezzi) il passo legge la finestra ancorata e basta, e il core scrive l'evento `summary.degraded` (L0, solo conversazione e motivo). Inserire un turno alza `tasks.effective_label` alla sua etichetta (trigger `task_turns_within_task`); `effective_label` di un task non scende mai (`tasks_label_only_up`). Una risposta in chat chiude il task in `done` con il messaggio come prova (`running` → `done` solo così). Un passo che trova già il suo turno non richiama il modello.
- **Notifica degli eventi:** un trigger fa `pg_notify('arianna_events:<schema>', id)` a ogni nuovo evento, consegnato al commit; chi ascolta legge l'evento dalla tabella. Il canale porta lo schema, così i test in schemi separati non si sentono fra loro.
- **Percorsi:** sempre relativi ad `ARIANNA_HOME`.
- **Ruoli (task 1.13, D-046):** il proprietario dello schema (`database.user`) applica solo le migrazioni; il core lavora come `arianna_app`, creato dalla migrazione `0007_app_role.sql`, che non possiede nulla, non crea oggetti né tabelle temporanee (`TEMPORARY` è revocato anche a `PUBLIC`), non altera tabelle né trigger e non ha `DELETE` né `TRUNCATE` su nessuna tabella. Sulle tabelle append-only (`events`, `gateway_log`, `label_changes`, `messages`, `router_decisions`, `task_turns`, `task_errors`, `conversation_summaries`) ha solo `SELECT` e `INSERT`; su `tasks`, `jobs`, `runs`, `approvals`, `conversations` e `telegram_state` anche `UPDATE`, sempre sotto i trigger di guardia; su `schema_migrations` solo `SELECT`. **Ogni tabella nuova, e la sequenza di un nuovo `bigserial`, va concessa nella sua migrazione:** i test con il database girano come `arianna_app` e `pnpm arianna:doctor` fallisce su una tabella che il ruolo non legge o una sequenza che non usa. Il ruolo riceve `LOGIN` e la password dal proprietario (`prepareDatabase`, in `pnpm db:migrate` e, con le password di sviluppo, a ogni `pnpm start`), che invia solo il verificatore SCRAM, mai la password.
- **Verifica della catena:** `verifyEventChain` (in `apps/core/src/events.ts`, eseguita anche da `pnpm arianna:doctor`) ricalcola gli hash di `events` e segnala la prima riga che non torna.
- **Limiti della catena, da chiudere più avanti:**
  - la cancellazione degli ultimi eventi non si vede dalla sola catena: serve un'ancora esterna, cioè l'ultimo hash salvato periodicamente fuori dal database (con `arianna export`, Fase 2);
  - il core lavora come `arianna_app`, che non può disattivare i trigger né modificare o cancellare eventi (D-046); il proprietario dello schema sì: chi ne ha la password può manomettere il registro, e la manomissione resta rilevabile ma non impedita. Le due password stanno nel vault;
  - le transazioni che scrivono eventi devono usare l'isolamento predefinito (READ COMMITTED). Con un altro livello la scrittura fallisce invece di biforcare la catena: lo impone il vincolo `events_single_successor`;
  - il lock della catena dura fino al commit: l'evento si scrive come ultima istruzione di una transazione breve.
- **Test con il database:** `pnpm test:db` crea uno schema usa e getta per ogni file di test e applica le migrazioni da zero (D-029).
- **Ricerca (Fase 2):** Qdrant fuori da Postgres; indice testuale con `tsvector` o BM25 dedicato. Alternativa da valutare: `pgvector` al posto di Qdrant per avere un servizio in meno (`OPEN-QUESTIONS.md`).
