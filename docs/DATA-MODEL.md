# Modello dati (bozza PostgreSQL)

`events`, `tasks` e `jobs` esistono dal task 0.3 (`apps/core/migrations/0001_init.sql`); `approvals`, `label_changes` e `gateway_log` dal task 1.2 (`0002_gateway.sql`); `runs`, `tasks.waiting_reason` e la chiave dei job dal task 1.8 (`0003_runs.sql`); `conversations`, `messages`, `tasks.conversation_id` e la notifica degli eventi dal task 1.11 (`0004_chat.sql`); `router_decisions` dal task 1.7 (`0005_router_decisions.sql`); `telegram_state` dal task 1.15 (`0006_telegram.sql`); il ruolo `arianna_app` e i suoi permessi dal task 1.13 (`0007_app_role.sql`); `task_turns` dal task 1.10 (`0008_task_turns.sql`); `task_delegations`, `conversations.model` e `messages.agent` dalla seconda parte del 1.10 (`0009_delegations.sql`); `task_errors` e le colonne della chat di sistema da D-064 (`0013_task_errors.sql`); `messages.model` e i vincoli di Claude nella chat di sistema dalla seconda parte di D-064 (`0014_claude_direct.sql`); `calls` da D-066 (`0015_calls.sql`); `push_subscriptions` dalla terza parte di D-066 (`0016_push.sql`); `calls.rang_at` dalla sua revisione (`0017_calls_rang.sql`); `conversation_summaries` da D-077 (`0018_conversation_summaries.sql`); `model_evals` da D-081 (`0019_model_evals.sql`); `task_delegations.files` da D-082 (`0020_delegation_files.sql`); `task_activities` da D-083 (`0021_task_activities.sql`); `conversations.pinned_at` da D-089 (`0022_conversation_pins.sql`); `tasks.note` da `task.update` del task 1.10 (`0023_task_notes.sql`); `task_delegations.base_commit` da D-117 (`0024_delegation_base_commit.sql`); il run locale di una delega da D-119 tappa T3 (`0025_local_delegations.sql`); `conversation_participants` da D-125 (`0026_conversation_participants.sql`); `conversations.agent` da D-111 tappa A (`0027_conversation_agent.sql`); `task_delegations.context_tokens` da D-111 tappa A2 (`0028_delegation_context.sql`); `conversations.agent` per ogni agente da D-111d (`0029_conversation_any_agent.sql`); `project_hidden_consents` da D-135 (`0030_project_hidden_consents.sql`); `conversations.incognito` e `purge_incognito` da D-136 (`0031_incognito.sql`); il rifiuto di deleghe e turni per una conversazione cancellata dalla revisione di D-136 (`0032_incognito_delegations.sql`); `conversations.trial_model` da D-142 (`0035_trial_conversations.sql`); `commitments`, `conversations.secretary` e le approvazioni `commitment` da D-144 (`0036_commitments.sql`); `conversations.secretary_session_at` da D-146 (`0037_secretary_sessions.sql`); l'azione `commitment.move` delle approvazioni `commitment` da D-148 (`0038_commitment_move.sql`); `commitments.rescheduled_from`, l'azione `commitment.report` e l'indice `events_schedule_fired_idx` da D-151 (`0039_commitment_report.sql`); `tasks.project` e `task_dependencies` da D-152 (`0040_cardwall.sql`); `tasks.planned_on`, il vincolo su `tasks.priority`, `card_links`, `card_checklist` e `card_files` dalla card ricca di D-152 (`0041_card_details.sql`); la destinazione `link` di `gateway_log` (indirizzo di un link verso il suo sito, L2 ammesso solo lì, `target` `link-list` o `link-click`, senza riassunto) da D-154 (`0042_link_fetch.sql`); il motivo `agent-off` di `calls.end_reason` da D-158 (`0044_calls_agent_off.sql`). Per queste tabelle la definizione che fa fede è la migrazione. Le altre tabelle qui sotto sono una bozza e nascono con il task che le usa. Le migrazioni sono file SQL numerati, solo in avanti, applicati da un runner proprio (D-028): una migrazione già applicata non si modifica, se ne aggiunge una nuova.

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

-- Chat: stesso storico per web e Telegram (Telegram spento per ora, D-110)
CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode            text NOT NULL DEFAULT 'private',          -- work | private
  clearance       privacy_label NOT NULL DEFAULT 'L2',      -- tetto di lettura
  effective_label privacy_label NOT NULL DEFAULT 'L0',      -- massimo letto finora, solo crescente
  workspace       text,                                     -- nome del progetto approvato (mode = work, D-058); prima repos/<nome>
  model           text,                                     -- modello cloud scelto per i passi delegati (solo work; NULL: decide il router); in una chat di sistema chi risponde: sonnet | opus (Claude diretto) o NULL (Arianna in locale), D-064
  title           text,                                     -- una riga: dal primo messaggio o dall'utente (D-057); etichetta della conversazione
  archived_at     timestamptz,                              -- archiviata dall'utente; NULL: nella lista
  pinned_at       timestamptz,                              -- fissata in cima alla lista (D-089); NULL: non fissata; mai insieme ad archived_at
  agent           text,                                     -- chi risponde (D-111, D-111d): NULL Arianna, altrimenti l'id dell'agente della chat diretta (mai arianna, solo origin user); modo e progetto dalla scheda, nel codice; immutabile
  purged_at       timestamptz,                              -- testi cancellati per sempre (purge_conversation o purge_incognito); non compare più
  incognito       boolean NOT NULL DEFAULT false,           -- conversazione incognita (D-136): scelta alla creazione, immutabile; senza titolo, mai archiviata né fissata
  trial_model     text,                                     -- "Prova in chat" (D-142): id del catalogo del modello locale che risponde da solo; solo in un'incognita privata senza agente, immutabile
  secretary       boolean NOT NULL DEFAULT false,           -- la conversazione del pulsante "Segretaria" (D-144): una sola non cancellata (indice unico), privata, dell'utente, di Arianna, mai incognita né archiviata, titolo "Segretaria" dalla nascita; immutabile; mai nella lista
  secretary_session_at timestamptz,                         -- inizio della sessione corrente della segretaria (D-146): l'ultimo clic sul pulsante, o il primo promemoria di oggi ancora senza risposta a quel clic (D-151, `from` nell'evento); solo sulla sua conversazione, solo in avanti; ogni clic è anche un evento `secretary.session`; un task legge i messaggi dall'ultimo clic prima della sua (dal suo `from`, se c'è) nascita, senza riassunti
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

-- Righe di attività dei task, salvate dove si pubblicano (D-083, migrazione 0021): append-only
CREATE TABLE task_activities (
  id       bigserial PRIMARY KEY,
  task_id  uuid NOT NULL REFERENCES tasks(id),               -- solo task di una conversazione non cancellata
  step     integer NOT NULL,
  ts       timestamptz NOT NULL DEFAULT now(),
  kind     text NOT NULL,                                   -- search | read | write | card | plan | error | delegate | tool | wait (mai thinking)
  detail   text NOT NULL,                                   -- lo stesso testo breve della riga dal vivo, ≤ 300 caratteri
  label    privacy_label NOT NULL                           -- ≥ etichetta effettiva del task, ≤ clearance della conversazione
);

-- Agenti entrati nella conversazione come colleghi (D-125, migrazione 0026): solo id, nomi e ore
CREATE TABLE conversation_participants (
  id               bigserial PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations(id),   -- mai una conversazione cancellata
  agent            text NOT NULL,                                -- nome dell'agente; mai arianna
  added_by         text NOT NULL,                                -- arianna (con la sua prima delega) | user
  task_id          uuid REFERENCES tasks(id),                    -- il task che l'ha portato dentro (obbligatorio con arianna)
  delegation_id    bigint REFERENCES task_delegations(id),       -- la delega che l'ha portato dentro, allo stesso agente
  added_at         timestamptz NOT NULL DEFAULT now(),
  removed_at       timestamptz                                   -- l'utente l'ha tolto; si imposta una volta sola
);
-- Al massimo una riga attiva (removed_at NULL) per agente e conversazione.

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
  note            text,                                     -- ultima nota di task.update, solo sulle carte (senza conversazione), al massimo 500 caratteri
  project         text,                                     -- 0040, D-152: progetto della carta (nome di un [[project]]), solo sulle carte; NULL: generale
  planned_on      date,                                     -- 0041, D-152: "Data esecuzione" della card; priority 0-4 (nessuna, Bassa, Media, Alta, Altissima)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'done' OR evidence <> '[]'::jsonb OR assignee = 'user'),
  CHECK (effective_label <= clearance)                      -- sopra il tetto non si legge
);

-- D-152: "aspetta": task_id non parte finché depends_on non è done. Solo fra carte,
-- mai su sé stessa, mai un ciclo (trigger); si toglie con removed_at, mai cancellata.
CREATE TABLE task_dependencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks(id),
  depends_on  uuid NOT NULL REFERENCES tasks(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz                                   -- unica modifica ammessa, una volta
);

-- 0041, D-152: le parti di una card (solo carte; tolte con removed_at, mai cancellate)
CREATE TABLE card_links     (id uuid, task_id uuid, url text /* http(s) */, title text, created_at timestamptz, removed_at timestamptz);
CREATE TABLE card_checklist (id uuid, task_id uuid, body text, done boolean, position integer, created_at timestamptz, removed_at timestamptz);
CREATE TABLE card_files     (id uuid, task_id uuid, name text, media_type text, size integer, sha256 text,
                             label privacy_label /* >= L2 */, created_at timestamptz, removed_at timestamptz);
                             -- i byte in data/cards/<task_id>/<id>, fuori da git

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
  kind        text NOT NULL,                                -- action | declassify | budget | setting | workspace (0010: cartella con modifiche non committate, D-056) | commitment (0036: conferma della segretaria, D-144)
  action      text NOT NULL,                                -- per commitment: commitment.add | commitment.done | commitment.move (0038, D-148) | commitment.report (0039, D-151)
  detail      jsonb NOT NULL,                               -- per declassify: text, sha256, from, to; per commitment: op, text, day, time, dayText, step (e commitmentId per done; commitmentId, fromDay e fromTime per move); per il resoconto (D-151) op = report, step ed entries[]: commitmentId, text, day, time, dayText, outcome (done | not_done | postponed), reason, e per un rinvio toDay, toTime, toDayText
  -- commitment: etichetta almeno L2, sempre con un task, si decide solo da web; approvata, scrive o chiude l'impegno nella stessa transazione
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
-- Vincoli: nessuna uscita consentita di L3; verso il cloud al massimo L1, tranne l'indirizzo di un link (target_kind 'link', D-154);
-- summary solo se allow e <= L1; una riga 'link' ha target link-list o link-click, località cloud, niente summary e, se allow, regola 'link'
-- (gateway_log_link_fields, 0042).
CREATE TABLE gateway_log (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  task_id     uuid, run_id uuid,
  target_kind text NOT NULL,                                -- executor | channel | web | link (0042, D-154)
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
  files         jsonb,                                      -- D-082: [{path, change, from?}] dei file cambiati dal run; NULL = non registrati, [] = nessuno
  base_commit   text,                                       -- D-117: HEAD del progetto quando sono stati elencati i file; NULL = non registrato o repository senza commit
  context_tokens integer,                                   -- D-111 A2: token nella sessione dell'agente dopo il run (ultima risposta del modello); solo un numero, indicatore del contesto della chat diretta
  created_at    timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  UNIQUE (task_id, step)
);
-- Vincoli (trigger task_delegations_guard): etichette entro la clearance del task; task, passo e brief
-- immutabili; una delega finita non cambia stato; run_id solo un run cloud dello stesso task; message_id
-- solo un messaggio dello stesso task; result_label alza effective_label del task. Mai DELETE.
-- files (D-082, vincolo task_delegations_files e trigger task_delegations_files_frozen): solo percorsi
-- relativi al progetto (non vuoti, non assoluti, niente segmenti di risalita né caratteri di controllo,
-- al massimo 1024 caratteri) e tipo di cambio (added | modified | deleted | renamed, `from` solo per
-- renamed), al massimo 500 voci, mai contenuti; scritta una volta sola, solo con run_id e repo, mai
-- all'inserimento. Confronto con l'ultimo commit, senza i file che l'utente aveva già cambiato prima del
-- run. Sparisce con la delega in purge_conversation. I permessi di tabella di 0009 la coprono.
-- base_commit (D-117, vincolo task_delegations_base_commit e trigger task_delegations_base_commit_frozen):
-- solo un id di commit (40 o 64 cifre esadecimali minuscole), mai contenuti; scritto nello stesso UPDATE
-- che scrive files, mai all'inserimento, poi immutabile. Serve al diff della chat (GET
-- /api/delegations/:id/diff), calcolato a richiesta: versione vecchia dal commit con git cat-file, senza
-- filtri; versione attuale dalla cartella con i controlli di D-082.

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
-- In una chat diretta (D-158) risponde l'agente di conversations.agent: la riga
-- non lo copia, l'API locale lo legge dalla conversazione (campo agent),
-- mai negli eventi (L0: il nome di un agente dell'utente è L1).
-- Se l'agente non può rispondere, la chiamata in uscita è skipped con
-- end_reason 'agent-off' (migrazione 0044).
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

-- Prove di un modello del catalogo con gli eval dell'orchestratore (D-081). Tutta L0:
-- casi finti, e la riga tiene solo id, esiti, tempi e codici, mai le risposte del modello.
CREATE TABLE model_evals (
  id bigserial PRIMARY KEY,
  job_id bigint REFERENCES jobs (id),   -- coda model.eval, chiave model-eval:<modello>, un solo tentativo
  model_id text NOT NULL,               -- id del catalogo
  role text NOT NULL CHECK (role = 'orchestrator'),
  weights_sha256 text,                  -- sha256 delle righe ordinate "path sha256\n" del catalogo: "secondo il catalogo"
  catalog_status text NOT NULL,         -- verified | experimental al momento della richiesta
  cases_sha256 text, prompt_sha256 text, -- casi di evals/orchestrator e prompt di Arianna usati
  status text NOT NULL DEFAULT 'queued', -- queued | running | passed | failed | error | cancelled
  requested_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  total integer, passed integer,
  measures jsonb,                       -- [{name, total, passed, rate, threshold}]
  latency_median_ms integer, latency_max_ms integer,
  reasons jsonb,                        -- motivi del runner (testi fissi con id dei casi)
  cases jsonb,                          -- [{id, passed, ms, error?}], error = codice
  preemptions integer NOT NULL DEFAULT 0, -- casi rifatti per dare precedenza a chiamate e task
  error text                            -- codice chiuso: user, preempted, interrupted, files-missing, ...
);
-- Indice (model_id, requested_at desc); una sola prova aperta (queued/running) per modello.
-- Trigger model_evals_guard: modello, ruolo, data della richiesta e pesi non cambiano; una
-- riga finita non si riapre; running non torna queued. arianna_app: SELECT, INSERT, UPDATE.

CREATE TABLE project_hidden_consents (   -- D-135: "Mostra nascosti" della pagina Progetti
  project text PRIMARY KEY,              -- nome del progetto approvato
  folder text NOT NULL,                  -- la cartella per cui vale: un progetto spostato riparte spento
  shown boolean NOT NULL DEFAULT true,  -- acceso adesso
  changed_at timestamptz NOT NULL DEFAULT now()
);
-- Spegnere mette shown a false: il core non cancella mai (D-046). Niente testo. Accensione, spegnimento
-- e ogni "Mostra" di un segreto sono eventi (project.hidden_shown, project.hidden_closed,
-- project.secret_revealed) con progetto e percorso, mai il contenuto. arianna_app: SELECT,
-- INSERT, UPDATE.

CREATE TABLE commitments (   -- D-144: gli impegni della segretaria (I-12, tappa S1)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body text NOT NULL,                    -- il testo dell'utente, una riga, fino a 500 caratteri; immutabile
  day date NOT NULL,                     -- il giorno calcolato dal codice (ora locale della macchina) e confermato dall'utente
  at_time time,                          -- l'ora, solo se detta
  status text NOT NULL DEFAULT 'open',   -- open | done | not_done | postponed | cancelled
  reason text,                           -- il motivo detto nel resoconto (D-151): perché non fatto o rinviato
  label privacy_label NOT NULL DEFAULT 'L2',  -- almeno L2, solo crescente: mai verso il cloud
  conversation_id uuid REFERENCES conversations(id),  -- la conversazione d'origine
  task_id uuid REFERENCES tasks(id),
  approval_id uuid UNIQUE REFERENCES approvals(id),   -- la conferma che l'ha creato: una volta sola
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,                   -- presente se e solo se status = done
  rescheduled_from uuid UNIQUE REFERENCES commitments(id)  -- 0039, D-151: l'impegno rinviato che questo continua
);
-- Trigger commitments_guard: testo e origine (rescheduled_from compreso) non cambiano, l'etichetta non scende.
-- Resoconto (D-151, 0039): una conferma commitment.report chiude più impegni ancora aperti e
-- dove la scheda li mostrava (done, not_done o postponed, con reason); un rinvio lascia
-- l'impegno nel suo giorno come postponed e ne scrive uno nuovo, aperto, con lo stesso testo
-- e rescheduled_from. Indice parziale events_schedule_fired_idx su events per schedule.fired. Gli elenchi
-- ("cosa ho domani?") li scrive il codice da questa tabella, mai il modello. Evento
-- commitment.changed con id e stato (con approvalId per una conferma, moved per uno spostamento, rescheduledFrom per l'impegno nato da un rinvio), mai il testo né il motivo. arianna_app: SELECT, INSERT, UPDATE.
-- I promemoria della segretaria (D-149, tappa S2) non hanno tabella: un momento scritto è un
-- messaggio di Arianna (role assistant, senza task, etichetta almeno L2) nella conversazione della
-- segretaria, con l'evento message.created che porta anche reminder = morning|afternoon|evening;
-- "una volta per giorno e momento" è l'evento schedule.fired (L0, payload schedule = 'secretary',
-- day, slot, written), scritto nella stessa transazione sotto un advisory lock. Lo stesso evento
-- servirà alle routine di D-110 con un altro schedule.

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
- **Titolo e archivio (D-057):** il titolo nasce dal primo messaggio dell'utente e l'utente lo cambia; non va mai nel payload di un evento. Una conversazione archiviata esce dalla lista e non accetta nuovi messaggi dell'utente (trigger `messages_not_archived`) finché non è ripristinata; i suoi messaggi restano. La conversazione legata a Telegram non si archivia (`conversations_guard`). **Cancellazione definitiva:** solo `purge_conversation(uuid)` (migrazione `0012`, `SECURITY DEFINER`, eseguibile solo da `arianna_app`), su una conversazione archiviata i cui task non sono `ready`/`running` né hanno job attivi. Blocca solo le righe della conversazione e dei suoi task, come fa il core, mai una tabella; imposta per la transazione `arianna.purge`, che i trigger di guardia (`append_only`, `approvals_guard`, `conversations_guard`, tramite `purge_target`) rispettano solo quando chi esegue è il proprietario della tabella. Cancella messaggi, riassunti (`conversation_summaries`, dalla migrazione `0018`), turni, righe di attività (`task_activities`, dalla `0021`), partecipanti (`conversation_participants`, dalla `0026`) e deleghe dei suoi task; svuota titolo della conversazione, titolo e obiettivo dei task (`Conversazione eliminata`), `detail` delle approvazioni (un declassamento resta con le etichette e un testo vuoto) e `last_error` dei job; ogni task non `done` né `failed` diventa `failed` e le sue approvazioni pendenti `expired`. Restituisce i task chiusi e le approvazioni scadute: il chiamante scrive `task.status` (causa `purge`) e `approval.decided` (stato `expired`) nella stessa transazione, poi `conversation.purged`. Restano `tasks`, `runs`, `approvals`, `jobs`, `gateway_log` (con il riassunto L1), `router_decisions`, `label_changes`, `events`. Le carte create dai task (figli con `parent_id`, senza conversazione) e le pagine della KB restano: sono oggetti a sé. Una conversazione cancellata non accetta più messaggi e non cambia più. *Superata da D-157 per scelta dell'utente (2026-10-10): la chat non usa più questa cancellazione, che resta nel database e nella rotta `/purge`; "Elimina" chiama `erase_conversation`, sotto.*
- **Eliminazione per sempre di una conversazione (D-157, migrazione `0043`, scelta dell'utente che supera D-046 e D-057 in questo punto):** solo `erase_conversation(uuid)` (`SECURITY DEFINER`, solo `arianna_app`, `search_path` fisso, `lock_timeout` di 5 s), su una conversazione non cancellata che non sia della segretaria, di Telegram né incognita (55000), per la conversazione e le chat di sistema sui suoi task a ogni profondità. Rifiuta (55006) se un job dei suoi task è `running` (un passo preso da un worker) o una chiamata è `ringing`/`connecting`/`active`: il core (`apps/core/src/erase.ts`) ferma prima i passi col segnale `stop` del worker, causa `erase` (il job fallisce con `last_error = 'erase'`), aspetta fino a 15 s, poi riprova una volta; altrimenti 409 e i job fermati tornano in coda (`queued`, come il rilascio del worker): nulla cambia. Una chiamata viva risponde 409 prima di qualunque stop. Rifiuta (55000) se un id delle sue righe (conversazioni, task, run, approvazioni, chiamate) è anche l'id di una riga di un'altra tabella con chiave `id uuid` (un id scelto dal core per prendere gli eventi di un'altra riga). Prende i lock di riga (conversazioni, task, run, approvazioni, chiamate, job per chiave e per payload), poi il lock advisory della catena (dopo cancella solo righe di tabelle append-only, che nessuno scrittore aggiorna), e imposta per la transazione `arianna.erase`, che `append_only`, `events_append_only`, `conversation_participants_guard` e `commitments_guard` rispettano solo quando chi esegue è il proprietario della tabella (`erase_target`, come `purge_target`). **Cancella** ogni riga che nomina la conversazione, i suoi task, i loro run, approvazioni e chiamate: `messages`, `tasks`, `task_turns`, `task_delegations` (con `files`), `task_activities`, `task_errors`, `conversation_summaries`, `conversation_participants`, `approvals`, `label_changes` (per approvazione o per `subject`), `runs`, `router_decisions`, `gateway_log`, `jobs` (per chiave o payload), `calls`, `task_dependencies` e parti di card che li nominassero (difensivo: esistono solo su card, che non hanno conversazione), ed `events` (per `task_id`, `run_id` o uno di quegli id nel payload); infine la conversazione. **Restano** le carte create dai suoi task (task senza conversazione, D-152), con `parent_id` a NULL, e un impegno detto lì (`commitments`) senza `conversation_id`, `task_id` né `approval_id`; i `runs.resumed_from` di altri task verso questi run vanno a NULL. **Catena:** dalla prima riga di `events` tolta in avanti ogni `prev_hash` e `hash` si riscrive in ordine con `event_hash`, nella stessa transazione, poi una sola riga `events.rewoven` (L0, payload `{}`, nessun task, run o agente: dice solo quando) segna la ricucitura; `verify_event_chain`, che usa il doctor, la dà integra. Gli id degli eventi restano quelli (con buchi): `telegram_state.event_cursor` e il feed dal vivo continuano. Nessun evento nomina la conversazione eliminata. Il doctor ammette `erase_conversation` fra le funzioni `SECURITY DEFINER` e ne controlla `search_path` e permessi; `arianna_app` continua a non avere `DELETE` né `UPDATE` su `events`. Dopo il commit il core cancella le cartelle `data/worktrees/<runId>` dei run tolti. **Limiti noti (revisione del 2026-10-10):** restano le righe del gateway delle chiamate vocali, che non portano il task (ora, etichetta e impronta sha256 di ciò che è stato detto, senza testo), e quelle dei link scaricati (`target_kind = 'link'`, impronta dell'indirizzo), che non appartengono a una conversazione; la ricucitura riscrive ogni evento successivo al primo tolto tenendo il lock della catena, quindi eliminare una conversazione vecchia ferma per qualche istante la scrittura degli eventi.
- **Conversazioni incognite (D-136, migrazione `0031`):** `conversations.incognito` si sceglie alla creazione e `conversations_guard` rifiuta ogni cambio. Il vincolo `conversations_incognito_fields` la vuole aperta dall'utente (`origin = 'user'`), senza chat diretta (`agent IS NULL`), senza titolo, mai archiviata né fissata; `conversations_purged_archived_untitled` ammette una cancellata non archiviata solo se incognita. Il trigger `conversations_incognito_source` rifiuta una chat di sistema su un task di un'incognita, `telegram_state_not_incognito` il canale di Telegram legato a un'incognita, `tasks_incognito_title` un task di un'incognita con un titolo diverso da `Incognito` (dalla nascita: l'inizio del messaggio non diventa mai un titolo). **Chiusura:** `purge_incognito(uuid)` (`SECURITY DEFINER`, solo `arianna_app`, `search_path` fisso, come `purge_conversation`) su un'incognita non cancellata, senza chiederne l'archiviazione; rifiuta se un task è `ready`/`running`, un run è `running` o un job è attivo (il core li chiude prima). Cancella e svuota come `purge_conversation`, tiene il titolo `Incognito` dei task, azzera anche `runs.session_ref` e `runs.workspace` e restituisce i conteggi (`tasks`, `messages`, `summaries`) per la scheda di chiusura, più task chiusi e approvazioni scadute come `purge_conversation`. La riga resta come scheletro (`purged_at`, `incognito`, `archived_at` NULL). Il doctor ammette solo queste due funzioni `SECURITY DEFINER` e `lock_incognito` (dalla `0033`). Il test del canarino (`apps/core/test-db/incognito-schema.test.ts`) scrive una stringa unica ovunque e la cerca, dopo la chiusura, in ogni colonna di testo, json e jsonb dello schema. Il core (`apps/core/src/incognito.ts`) chiude un'incognita con "Termina" (`POST /api/conversations/:id/end`), dopo 10 minuti senza pagina e all'avvio prima che il worker riprenda i run: ferma il passo in corso col segnale `stop` del worker (il job fallisce con `last_error = 'incognito'`, mai di nuovo in coda), mette `failed` (causa `incognito`) i task `ready`/`running`, chiude i run rimasti `running`, legge file cambiati (`task_delegations.files`) e invii al cloud (`gateway_log` con il modello del run) per la scheda di chiusura, poi chiama `purge_incognito` e scrive `conversation.incognito-closed` (L0, causa `user`, `idle` o `restart`) e `conversation.purged`. Nella stessa transazione annulla le chiamate ancora `scheduled` della conversazione (`skipped`, `cancelled`) e segna chiusa nel solo database una chiamata viva su di lei (non dovrebbe esistere); le rotte delle chiamate rifiutano comunque un'incognita (409). Se la chiusura fallisce (lock, lavoro che non si ferma: 409 `busy`), `haltIncognito` ferma lo stesso il lavoro in una transazione sua: job `failed`, run chiusi, task `ready`/`running` `failed`. **Migrazione `0032`:** il trigger `task_text_not_purged` rifiuta l'inserimento e la modifica di `task_delegations` e l'inserimento di `task_turns` per un task di una conversazione cancellata, come già facevano messaggi, riassunti e righe di attività: un passo tardivo non scrive più nulla dopo il purge. **Migrazione `0033`:** `lock_incognito(uuid)` (`SECURITY DEFINER`, solo `arianna_app`, `search_path` fisso, `lock_timeout` di 5 s) prende per primi, nell'ordine del purge, i lock di riga che serviranno, anche sulle tabelle dove `arianna_app` non ha UPDATE; la chiusura la chiama prima del primo evento, perché scrivere un evento tiene il lock advisory della catena (`0001_init.sql`) fino al commit e un'attesa dopo fermerebbe ogni altro evento di Arianna.
- **Chat diretta con il Coder (D-111 tappa A, migrazione `0027`):** `conversations.agent` vale `coder` quando nella conversazione risponde il Coder al posto di Arianna. Ammesso solo da `conversations_agent_known` (`NULL` o `coder`) e da `conversations_agent_work_project` (`mode = 'work'`, `origin = 'user'`, `workspace` presente); si sceglie alla creazione (`POST /api/conversations` con `agent`) e il trigger `conversations_agent_fixed` rifiuta ogni cambio. Ogni messaggio dell'utente scrive nella stessa transazione il task (`assignee = 'coder'`) e la sua riga di `task_delegations` al passo 1, con il messaggio come brief; un messaggio nuovo è rifiutato (409) finché un task della conversazione è in coda, al lavoro o in attesa di un'approvazione. Nessuna tabella nuova.
- **Conversazioni fissate (D-089, migrazione `0022`):** `pinned_at` è l'ora in cui l'utente l'ha fissata; `GET /api/conversations` mette prima le fissate (l'ultima in alto), poi le altre per attività. Nessun limite di numero. Il vincolo `conversations_pinned_listed` vieta una fissata archiviata e il trigger `conversations_unpin_archived` toglie la fissatura quando una conversazione si archivia (anche quella di sistema archiviata da `purge_conversation`); fissare un'archiviata è rifiutato dal core (409), ripristinarla non la rifissa. Nessun permesso nuovo: `arianna_app` aggiorna `conversations` a livello di tabella e `conversations_guard` blocca le altre colonne. Evento `conversation.pinned` con il solo id. **Messaggi salvati in inbox (D-089):** non sono nel database: la nota di `kb/inbox/` scrive `source: message:<id>` e il core la cerca lì (un salvataggio per messaggio, `GET /api/conversations/:id/saved`).
- **Righe di attività salvate (D-083, migrazione `0021`):** `postActivity` (`apps/core/src/reply.ts`) salva in `task_activities` la stessa riga che manda alla chat dal vivo, dopo gli stessi filtri (valori del vault rifiutati, spazi e caratteri di controllo compattati, al massimo 300 caratteri), con l'etichetta effettiva del task in quel momento; non salva `thinking` né una riga uguale all'ultima del task; un salvataggio fallito non ferma la riga dal vivo. Il trigger `task_activities_guard` rifiuta un task senza conversazione o di una conversazione cancellata, un'etichetta sotto quella del task o sopra la clearance della conversazione e la riga oltre la duecentesima del task (con un lock consultivo per task, nessuna riga di `tasks` bloccata). La chat le legge con `GET /api/tasks/:id/activities` (righe ≤ clearance della conversazione) e conta le righe per task con `GET /api/conversations/:id/activity-counts`. `purge_conversation` le cancella con i turni.
- **Errori leggibili e chat di sistema (D-064, migrazione `0013`):** quando un task fallisce (tentativi del job esauriti, worker morto, esito `failed` dell'esecutore) il core scrive nella stessa transazione una riga di `task_errors` e l'evento `task.failed` (L0, solo origine e codice). I dettagli sono scalari da una lista chiusa per codice (`apps/core/src/failures.ts`: endpoint, porta, stato HTTP, tentativi, codice SQL, esecutore, classe dell'errore), mai messaggi né output; il database rifiuta oggetti, liste e stringhe oltre 100 caratteri. Un task riprovato che fallisce di nuovo ha una riga nuova: vale l'ultima. `POST /api/tasks/:id/retry` riporta un task `failed` in `ready` con un job nuovo (evento `task.retried`), mai per una conversazione archiviata o eliminata. Una chat di sistema (`origin = 'system'`) prende il modo della conversazione del task (senza conversazione: privata; trigger `conversations_system_mode`), non ha progetto, ed è una sola per task finché non è eliminata (indice unico parziale); se ne apre una nuova solo per un task `failed` in quel momento. Il titolo nomina l'origine dell'errore, mai il task (il titolo del task è l'inizio della domanda). Riaperta dopo un nuovo fallimento, riceve un messaggio `system` con l'errore nuovo (`source_error_id`). Il primo messaggio, `role = 'system'`, contiene solo l'errore con l'etichetta della riga; la domanda del task entra solo con `POST /api/conversations/:id/question`, con la sua etichetta, una volta. L'orchestratore legge i messaggi `system` come messaggi dell'utente marcati. `purge_conversation` elimina prima, archiviandole, le chat di sistema sui task della conversazione (ricorsivo): una chat di sistema al lavoro blocca l'intera eliminazione. Quell'archiviazione non scrive `conversation.archived`: basta `conversation.purged` con `cause: 'source'`. `task_errors` resta: non ha testi.
- **Telegram (task 1.15, D-044; spento per ora, D-110):** il bot scrive in una sola conversazione `work`, legata in `telegram_state`; un messaggio da Telegram è un messaggio dell'utente con `channel = 'telegram'`, scritto nella stessa transazione che sposta `update_offset`, così un aggiornamento si applica una volta sola. Un pulsante decide un'approvazione con `decided_via = 'telegram'` nella stessa transazione dell'offset; i declassamenti restano solo web (`approvals_declassify_via_web`). Gli avvisi verso Telegram nascono dagli eventi `approval.requested` e `message.created`, letti in ordine da `event_cursor`: dopo un crollo un avviso può ripetersi, non perdersi. Ogni testo verso Telegram ha la sua riga in `gateway_log` (`target = 'telegram'`). Dopo una settimana senza update Telegram può ripartire con id più bassi: dopo due giorni di quiete (`telegram_offset_stale`; Telegram tiene un update non consegnato 24 ore) qualsiasi id è nuovo. Un update o un evento che fallisce sempre per un errore che non è di rete si salta dopo alcuni tentativi, con un evento `telegram.failed` che porta solo un codice. Gli aggiornamenti di chi non è ammesso lasciano al massimo un evento `telegram.ignored` al minuto, senza id né contenuto. Il titolo mostrato in un avviso è quello del task, la cui etichetta è `tasks.label`: un futuro aggiornamento del titolo dovrà rispettarla.
- **Delega (task 1.10, seconda parte, D-055):** una chiamata `task.delegate` scrive il turno (senza risultato) e una riga in `task_delegations` nella stessa transazione; il passo successivo del task è il run cloud (`runs.locality = cloud`, `effective_label` del run = etichetta del brief, non del task), che aggiorna la riga; il passo dopo legge `result` come risultato dello strumento. Un brief sopra L1 aspetta un'approvazione `declassify` (cercata per `detail.sha256` del brief); Fable un'approvazione `budget` (`detail.step` = passo della delega). Un rifiuto di quota rimette la delega `pending` e riaccoda lo stesso passo (`jobs.run_at`, evento `task.retry`); il run finisce `failed`. Con D-056 la cartella di lavoro è il repository stesso: modifiche non committate (`git status`) fermano il task con un'approvazione `workspace` (`detail.step` = passo della delega, `detail.files` = percorsi); i file cambiati dal run finiscono in `result`, non nel messaggio del Coder, e (D-082) in `task_delegations.files` con il tipo di cambio, prima che il rapporto sia salvato. Il rapporto del Coder è un messaggio con `agent = 'coder'`, che l'orchestratore non rilegge come storia della chat e che il controllo "task già risposto" ignora. Dopo un crash fra il salvataggio del rapporto e la chiusura della delega, il passo riprende il rapporto dell'agente scritto dopo `task_delegations.created_at` e non collegato ad altre deleghe (`message_id`), senza rilanciare il run: mai il rapporto di una delega precedente dello stesso task. **Agenti utente (D-119, tappa T3, migrazione `0025`):** `task.delegate` nomina il Coder o un agente utente attivo che un esecutore può far girare. Un agente `code` segue la strada del Coder; un agente senza strumenti (modello `answer`) lavora sul modello locale: il passo dopo la chiamata è un run `locality = local` con `executor = 'local'` sulla delega (`repo` vuoto), una sola chiamata con il prompt dell'agente (L1 per dichiarazione) e il brief, passati dal gateway verso `local`; il rapporto è un messaggio con `agent` = nome dell'agente e porta l'etichetta più alta fra brief e prompt. Il vincolo `task_delegations_guard` vuole un run locale per `executor = 'local'` e un run cloud per gli altri. Un brief sopra la clearance dell'agente (L1 per un agente `answer` creato dall'utente) aspetta un'approvazione `declassify` verso quella etichetta.
- **Partecipanti (D-125, migrazione `0026`):** `task.delegate` porta anche `reason`, una riga breve scritta da Arianna. Alla delega verso un agente che non è partecipante attivo della conversazione, nella stessa transazione del turno e della delega, il core inserisce la riga in `conversation_participants` (`added_by = 'arianna'`, con task e delega; `ON CONFLICT` sull'indice parziale: due task insieme lo aggiungono una volta), l'evento `participant.added` (L1, solo id) e due messaggi `role = 'system'` con `task_id`: "Arianna aggiunge <agente>: <reason>" (etichetta = più alta fra quella del turno e quella del nome; il `reason` passa prima il gateway verso `channel:web`, e se è fermato la riga dice solo chi entra) e "<agente> è stato aggiunto" (etichetta del nome: L0 per un agente di `agents/`, L1 per uno dell'utente). Un messaggio di sistema con task è solo per l'utente: né l'orchestratore né i riassunti lo leggono (`conversationView`), e da questa migrazione nemmeno `conversation_summaries_guard` lo conta come buco fra due pezzi o nell'etichetta di un pezzo. Il run della delega che ha portato dentro l'agente, se l'agente è ancora attivo, riceve la frase fissa d'ingresso (`ENTRY_TEXT`, L0): fra prompt dell'agente e brief verso Claude, in coda al prompt di sistema sul modello locale; dalla seconda delega niente righe né frase. Arianna legge i partecipanti attivi all'inizio del task come nota di sistema dopo la chat ("In this conversation: …", mai nel prompt di sistema). L'utente toglie un partecipante (`POST /api/conversations/:id/participants/:agent/remove`): `removed_at`, evento `participant.removed` (L1) e la riga "Hai tolto <agente>" con il task che l'aveva portato dentro; alla delega seguente rientra con una riga nuova. `GET /api/conversations/:id/participants` dà i partecipanti attivi con l'esecutore. Il trigger `conversation_participants_guard` rifiuta una conversazione cancellata, una riga che nasce tolta, un task di un'altra conversazione o una delega di un altro task o agente, ogni modifica che non sia impostare `removed_at` una volta, e la cancellazione fuori da `purge_conversation`, che cancella le righe prima delle deleghe. `arianna_app` ha `SELECT`, `INSERT` e `UPDATE`.
- **Orchestratore (task 1.10, D-053):** il contesto di un task si ricostruisce a ogni passo dai messaggi della conversazione fino a quello che l'ha aperto e dai suoi `task_turns`, mai da quelli di altri task. Dei messaggi legge il riassunto (`conversation_summaries`, pezzi con `last_message_id` fino a quel messaggio) e quelli da un'ancora in poi (D-077): l'ancora si ricalcola dai messaggi dopo l'ultimo pezzo, resta ferma fino a 30 messaggi o 24.000 caratteri e poi salta lasciandone 10; i messaggi lasciati indietro diventano un pezzo nuovo, scritto dal modello locale al primo passo del task, prima della risposta (i passi successivi leggono soltanto). Un intervallo che il gateway blocca riceve un pezzo segnaposto senza contenuto; uno sopra la clearance del task nessun pezzo. Senza il pezzo (modello fermo, conflitto, massimo di pezzi) il passo legge la finestra ancorata e basta, e il core scrive l'evento `summary.degraded` (L0, solo conversazione e motivo). Inserire un turno alza `tasks.effective_label` alla sua etichetta (trigger `task_turns_within_task`); `effective_label` di un task non scende mai (`tasks_label_only_up`). Una risposta in chat chiude il task in `done` con il messaggio come prova (`running` → `done` solo così). Un passo che trova già il suo turno non richiama il modello.
- **`task.update` dell'orchestratore (task 1.10, D-101 proposta, migrazione `0023`):** sposta una carta e ci scrive una nota. Carte ammesse: le figlie aperte (`inbox`, `ready`, `waiting_user`, `to_verify`) dei task della stessa conversazione (senza conversazione: del task stesso), con etichetta entro la clearance del task, senza job attivo né approvazione pendente; un id sconosciuto o di un'altra conversazione dà lo stesso errore, con le carte aggiornabili elencate; un prefisso di almeno 8 caratteri vale se indica una carta sola. Le mosse sono quelle di `task-status.ts`, più l'autonomia: A0 non sposta carte; A1 non mette carte in `ready`, salvo chiudere un'attesa aperta da un agente (ultimo `task.status` verso `waiting_user` con causa `agent`). `waiting_user` vuole la nota, che diventa anche `waiting_reason`. La nota porta l'etichetta del contesto del passo: rifiutata sopra la clearance della carta, alza `label` ed `effective_label`. Eventi: `task.status` (causa `agent`), `task.updated` (etichetta della nota, solo id, stati e se c'è una nota) e, una volta per task, `task.offer` (L0, `{update}`: se lo strumento è offerto, deciso al primo passo e tenuto per tutto il task). La nota resta in locale, come il titolo: niente gateway; sopravvive a `purge_conversation` con la carta. Una carta in `waiting_user` compare in `GET /api/tasks/waiting` (senza conversazione, motivo `other`); una in Pronti non parte da sola (nessun job).
- **Attese superate e "Chiudi" (D-109, da confermare; nessuna migrazione):** quando l'utente scrive in una conversazione, nella stessa transazione del messaggio (`writeUserMessage`, dopo i controlli di archivio e scanner) i task di quella conversazione in `waiting_user` senza un'approvazione `pending` (né quella di `waiting_approval_id` né un'altra del task) passano a `done`: evento `task.status` con `cause: 'superseded'` (payload solo `from`, `to`, `cause`) e prova accodata `{kind: 'superseded', ref: <id della riga di sistema>}` (il vincolo `tasks_done_needs_evidence` vuole una prova). La conversazione riceve una riga `role = 'system'`, L0, testo fisso "Attesa chiusa: la conversazione è andata avanti.", con `task_id` del (primo) task chiuso, prima del messaggio nuovo; una sola riga per messaggio. Un messaggio `system` con `task_id` è solo per l'utente: `conversationView` lo esclude, quindi né l'orchestratore né i riassunti lo leggono (i messaggi `system` delle chat di sistema, D-064, non hanno task e restano letti). Le carte senza conversazione (D-101) non sono toccate. `POST /api/tasks/:id/dismiss` (corpo `{}`, "Chiudi" in "Decisioni in attesa"): blocca prima le approvazioni pendenti del task, poi il task (l'ordine di `recordDecisionIn` e `resumeTask`); le approvazioni scadono (`expired`, evento `approval.decided` con `via: null`) e il task passa a `done` con `cause: 'user'` e prova `{kind: 'dismissed', by: 'user'}`. 404 per un task inesistente; 409 per un task non in attesa o di una conversazione eliminata; ammessa per una archiviata. Una decisione arrivata dopo trova l'approvazione scaduta (409).
- **Notifica degli eventi:** un trigger fa `pg_notify('arianna_events:<schema>', id)` a ogni nuovo evento, consegnato al commit; chi ascolta legge l'evento dalla tabella. Il canale porta lo schema, così i test in schemi separati non si sentono fra loro.
- **Percorsi:** sempre relativi ad `ARIANNA_HOME`.
- **Ruoli (task 1.13, D-046):** il proprietario dello schema (`database.user`) applica solo le migrazioni; il core lavora come `arianna_app`, creato dalla migrazione `0007_app_role.sql`, che non possiede nulla, non crea oggetti né tabelle temporanee (`TEMPORARY` è revocato anche a `PUBLIC`), non altera tabelle né trigger e non ha `DELETE` né `TRUNCATE` su nessuna tabella (l'unica cancellazione che il core chiede passa da `purge_conversation`, `purge_incognito` ed `erase_conversation`, D-157). Sulle tabelle append-only (`events`, `gateway_log`, `label_changes`, `messages`, `router_decisions`, `task_turns`, `task_errors`, `conversation_summaries`, `task_activities`) ha solo `SELECT` e `INSERT`; su `tasks`, `jobs`, `runs`, `approvals`, `conversations`, `telegram_state`, `calls`, `push_subscriptions`, `model_evals` e `conversation_participants` anche `UPDATE`, sempre sotto i trigger di guardia; su `schema_migrations` solo `SELECT`. **Ogni tabella nuova, e la sequenza di un nuovo `bigserial`, va concessa nella sua migrazione:** i test con il database girano come `arianna_app` e `pnpm arianna:doctor` fallisce su una tabella che il ruolo non legge o una sequenza che non usa. Il ruolo riceve `LOGIN` e la password dal proprietario (`prepareDatabase`, in `pnpm db:migrate` e, con le password di sviluppo, a ogni `pnpm start`), che invia solo il verificatore SCRAM, mai la password.
- **Verifica della catena:** `verifyEventChain` (in `apps/core/src/events.ts`, eseguita anche da `pnpm arianna:doctor`) ricalcola gli hash di `events` e segnala la prima riga che non torna.
- **Limiti della catena, da chiudere più avanti:**
  - la cancellazione degli ultimi eventi non si vede dalla sola catena: serve un'ancora esterna, cioè l'ultimo hash salvato periodicamente fuori dal database (con `arianna export`, Fase 2);
  - il core lavora come `arianna_app`, che non può disattivare i trigger né modificare o cancellare eventi (D-046); il proprietario dello schema sì: chi ne ha la password può manomettere il registro, e la manomissione resta rilevabile ma non impedita. Le due password stanno nel vault;
  - le transazioni che scrivono eventi devono usare l'isolamento predefinito (READ COMMITTED). Con un altro livello la scrittura fallisce invece di biforcare la catena: lo impone il vincolo `events_single_successor`;
  - il lock della catena dura fino al commit: l'evento si scrive come ultima istruzione di una transazione breve.
- **Test con il database:** `pnpm test:db` crea uno schema usa e getta per ogni file di test e applica le migrazioni da zero (D-029).
- **Ricerca (Fase 2):** Qdrant fuori da Postgres; indice testuale con `tsvector` o BM25 dedicato. Alternativa da valutare: `pgvector` al posto di Qdrant per avere un servizio in meno (`OPEN-QUESTIONS.md`).
