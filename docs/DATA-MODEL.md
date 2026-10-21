# Modello dati (bozza PostgreSQL)

`events`, `tasks` e `jobs` esistono dal task 0.3 (`apps/core/migrations/0001_init.sql`); `approvals`, `label_changes` e `gateway_log` dal task 1.2 (`0002_gateway.sql`); `runs`, `tasks.waiting_reason` e la chiave dei job dal task 1.8 (`0003_runs.sql`); `conversations`, `messages`, `tasks.conversation_id` e la notifica degli eventi dal task 1.11 (`0004_chat.sql`); `router_decisions` dal task 1.7 (`0005_router_decisions.sql`); `telegram_state` dal task 1.15 (`0006_telegram.sql`); il ruolo `arianna_app` e i suoi permessi dal task 1.13 (`0007_app_role.sql`); `task_turns` dal task 1.10 (`0008_task_turns.sql`); `task_delegations`, `conversations.model` e `messages.agent` dalla seconda parte del 1.10 (`0009_delegations.sql`); `task_errors` e le colonne della chat di sistema da D-064 (`0013_task_errors.sql`); `messages.model` e i vincoli di Claude nella chat di sistema dalla seconda parte di D-064 (`0014_claude_direct.sql`); `calls` da D-066 (`0015_calls.sql`); `push_subscriptions` dalla terza parte di D-066 (`0016_push.sql`); `calls.rang_at` dalla sua revisione (`0017_calls_rang.sql`); `conversation_summaries` da D-077 (`0018_conversation_summaries.sql`); `model_evals` da D-081 (`0019_model_evals.sql`); `task_delegations.files` da D-082 (`0020_delegation_files.sql`); `task_activities` da D-083 (`0021_task_activities.sql`); `conversations.pinned_at` da D-089 (`0022_conversation_pins.sql`); `tasks.note` da `task.update` del task 1.10 (`0023_task_notes.sql`); `task_delegations.base_commit` da D-117 (`0024_delegation_base_commit.sql`); il run locale di una delega da D-119 tappa T3 (`0025_local_delegations.sql`); `conversation_participants` da D-125 (`0026_conversation_participants.sql`); `conversations.agent` da D-111 tappa A (`0027_conversation_agent.sql`); `task_delegations.context_tokens` da D-111 tappa A2 (`0028_delegation_context.sql`); `conversations.agent` per ogni agente da D-111d (`0029_conversation_any_agent.sql`); `project_hidden_consents` da D-135 (`0030_project_hidden_consents.sql`); `conversations.incognito` e `purge_incognito` da D-136 (`0031_incognito.sql`); il rifiuto di deleghe e turni per una conversazione cancellata dalla revisione di D-136 (`0032_incognito_delegations.sql`); `conversations.trial_model` da D-142 (`0035_trial_conversations.sql`); `commitments`, `conversations.secretary` e le approvazioni `commitment` da D-144 (`0036_commitments.sql`); `conversations.secretary_session_at` da D-146 (`0037_secretary_sessions.sql`); l'azione `commitment.move` delle approvazioni `commitment` da D-148 (`0038_commitment_move.sql`); `commitments.rescheduled_from`, l'azione `commitment.report` e l'indice `events_schedule_fired_idx` da D-151 (`0039_commitment_report.sql`); `tasks.project` e `task_dependencies` da D-152 (`0040_cardwall.sql`); `tasks.planned_on`, il vincolo su `tasks.priority`, `card_links`, `card_checklist` e `card_files` dalla card ricca di D-152 (`0041_card_details.sql`); la destinazione `link` di `gateway_log` (indirizzo di un link verso il suo sito, L2 ammesso solo lì, `target` `link-list` o `link-click`, senza riassunto) da D-154 (`0042_link_fetch.sql`); il motivo `agent-off` di `calls.end_reason` da D-158 (`0044_calls_agent_off.sql`); le approvazioni `plan` ed `executor` e `approvals.choice` da D-159 (`0045_card_plans.sql`); `tasks.design_style` e `tasks.design_skills` da D-163 (`0046_card_design.sql`); `im_closings` da D-167 (`0047_im_closings.sql`); `clients`, `client_contacts` e `client_projects` da D-168 (`0048_clients.sql`); `im_prices`, `im_invoices` e `im_billing` da D-169 (`0049_im_billing.sql`), con il denaro di un IM in fattura fermo anche nel database (`0050_im_billing_invoiced.sql`); `im_invoices.document_cents` e `im_invoices.due_on` da D-170 (`0051_invoice_document.sql`); `client_documents` da D-171 (`0052_client_documents.sql`); `god_plans`, `god_subtasks` e `god_carries` da D-127 (`0053_god.sql`: i piani di GOD approvati, i sottocompiti con il loro clone, le chat del Coder e del Reviewer, lo stato e il commit del ramo; il riassunto da cui riparte una conversazione con GOD); `god_carries.from_changelog`, con `from_conversation_id` facoltativa e una sola delle due, da D-178 (`0054_god_changelog.sql`: una conversazione con GOD che parte da una voce delle Novità); `finance_accounts`, `finance_imports`, `finance_transactions`, `finance_categories`, `finance_rules`, `finance_budgets`, `finance_settings`, la funzione `finance_delete` e il segno `finance` di `conversations`, `tasks` e `runs` da D-183 (`0056_finance.sql`: il tracker delle spese, I-18); il segno che passa alla conversazione anche da un task nato segnato e alle chat di sistema del task (`0057_finance_fixes.sql`); `tasks.design_style` e `tasks.design_skills` anche sui task della chat diretta col Designer, scelti nello Studio, con il trigger `tasks_design_only_designer` al posto del vincolo `tasks_design_only_cards` da D-184 (`0058_designer_chat_design.sql`); `conversations.direct_session_at` e `conversations.direct_session_open` da D-185 (`0059_direct_sessions.sql`: «Nuova sessione» della chat diretta col Designer); la velocità, la copia della voce del catalogo e le risposte dei casi in valori chiusi di `model_evals` da D-199 (`0060_model_evals_compare.sql`: «Confronto dei modelli»); `user_facts` e la funzione `user_fact_delete` da D-114 (`0061_user_facts.sql`: il profilo «Su di te», tappa A); i vincoli di «Con chi parli» su `conversations.agent` da D-111 tappa B, D-209 (`0063_conversation_interlocutor.sql`: `local-chat` solo in privata, `claude` e `codex` solo di lavoro senza progetto, `coder` solo di lavoro con progetto, il modello di `claude` solo Sonnet o Opus); il modello della chat semplice con ChatGPT (`conversations_agent_codex_model`) e `runs.context_tokens` da D-212 (`0064_plain_chat_codex.sql`: `luna`, `sol` o `astra`, `NULL` è Sol; quanto è piena la sessione dopo la risposta di una chat semplice, solo un numero); `task_terminal` da D-095 (`0062_task_terminal.sql`: comandi e uscite del Coder salvati con la loro delega, solo L0 e L1, mai in incognito, al massimo 400 righe per delega, solo inserimento e lettura per `arianna_app`, cancellati a cascata con la delega da `purge_conversation`, `erase_conversation` e `purge_incognito`); `queued_messages` e `message_queue_pauses` da D-218 (`0066_message_queue.sql`: i messaggi scritti mentre una risposta lavora, con l'etichetta della conversazione e lo stile e le skill dello Studio, al massimo 16000 caratteri, mai L3; la pausa dopo «Ferma»; il trigger `message_queue_purge` li cancella quando la conversazione è cancellata, `queued_messages_live` rifiuta una coda su una conversazione cancellata, «Elimina» li porta via a cascata con la conversazione; `arianna_app` legge e scrive, e toglie un messaggio solo con `queued_message_delete(bigint)` (`SECURITY DEFINER`, ammessa dal doctor come `user_fact_delete`); la pausa si spegne con `paused = false`, mai cancellando). `tasks.addressed` e `tasks.addressed_agents` da D-219 (`0067_addressed_tasks.sql`: un messaggio con «@nome» (`mention`, un agente) o «/giro» (`round`, da 1 a 6 agenti nell'ordine in cui rispondono), solo nomi di agenti, mai testo dell'utente); `task_delegations.read_chat` da D-220 (`0068_delegation_read_chat.sql`: l'agente ha letto la chat oltre al brief, solo un sì/no, solo con esecutore `local`); `conversations.character_on` da D-225 (`0069_conversation_character.sql`: l'interruttore «Personaggio» della chat, acceso per default, solo un sì/no; nessun permesso nuovo, `conversations_guard` la lascia libera e ferma una conversazione cancellata); `conversations.series_character` da D-225 tappa B (`0070_conversation_series_character.sql`: il personaggio delle serie con cui l'utente chatta, solo l'id, ammesso solo nella chat semplice con Claude di lavoro senza progetto, mai in incognito; scelto alla creazione, il trigger `conversations_series_character_fixed` non lo fa cambiare); `dashboard_tiles.kind`, `dashboard_tiles.chart` e l'errore `chart` da D-248 dopo la prova (`0076_dashboard_question_chart.sql`: un riquadro «Testo» o «Grafico», i dati del grafico come oggetto JSON di al più 16000 byte controllato dal core prima di salvarlo; `dashboard_tiles_guard` riscritta perché la domanda si modifichi, mai mentre si aggiorna, con la sua etichetta ferma); card_returns` da D-235 (`0073_card_returns.sql`: le note di «Rimanda», una riga per volta che una card di un agente torna da Da verificare al lavoro, con il passo dopo cui l'agente le legge e l'etichetta scelta dall'utente, solo L1 o L2, al massimo 2000 caratteri; solo sulle card, mai cambiate: `arianna_app` legge e inserisce; la stessa migrazione riscrive `task_activities_guard` perché anche le card salvino i loro passi, almeno all'etichetta della card ed entro la sua clearance); `conversations.side_of` e `conversations.side_message_id` da D-232 (`0071_side_threads.sql`: «Chiedi a lato», il filo a lato è una conversazione nata da una risposta di un'altra, solo id; il trigger `conversations_side_guard` la vuole aperta, dell'utente, con Arianna, il modello locale o una chat semplice, e copia nel filo modo, clearance, interlocutore, modello e progetto della madre, con l'etichetta effettiva almeno uguale a quella della madre e della risposta; una sola viva per risposta, mai fissata, immutabile; `purge_conversation` ed `erase_conversation` riscritte per portare via i fili con la madre); `conversations.dashboard_of`, `dashboard_tiles` e la funzione `remove_dashboard_tile` da D-248 (`0074_dashboard_tiles.sql`: il Cruscotto, le risposte fissate dalla chat come riquadri e le conversazioni nate per aggiornarne uno col modello locale); `tasks.plan_approval_id`, `tasks.complexity`, `tasks.planning` e la modifica di un piano in attesa in `approvals_guard` da D-235 (`0072_card_plans_c5.sql`: il piano da cui nasce una card, la sua complessità S/M/L e la card «Piano» di «/progetta» con il task della chat che la chiede, solo id e valori chiusi; il `detail` di un'approvazione `plan` ancora `pending` si può sostituire, nient'altro); `message_attachments` e le funzioni `message_attachment_discard` e `message_attachments_prune` da D-247 (`0075_message_attachments.sql`: immagini e file allegati in chat, sempre L2, solo in una conversazione privata non incognita, vedi le note); il tipo `stop` delle righe di attività da D-250 (`0077_activity_stop.sql`: l'errore che chiude il task, nella chat diretta con un agente e sulla card di un agente, scritto senza «provo un'altra strada»); `messages.thought`, `messages.thought_ms` e `task_turns.thought_ms` da D-249 (`0078_message_thought.sql`: il pensiero prima di una risposta, nella riga della risposta e quindi con la sua etichetta, al più 32000 caratteri, solo `assistant`, testo vuoto se il modello ha pensato senza mostrarlo, tempo in millisecondi sempre insieme al testo; il trigger `messages_thought_not_incognito` lo toglie in un'incognita; se ne va con la riga in `purge_conversation`, `erase_conversation` e `purge_incognito`; mai in un brief né nella storia letta da un modello); `routines` e `routine_runs` da D-254, tappa A delle routine di D-110 (`0079_routines.sql`); le approvazioni `routine` e il trigger `routines_proposal_guard` da D-256, tappa A2 (`0080_routine_proposals.sql`: la routine proposta in chat da `routine.propose`, vedi le note); la fonte `dashboard` e `routines.dashboard_tiles` da D-258 (`0081_routine_dashboard.sql`: la routine aggiorna i riquadri della Dashboard, vedi le note); `routines.channel` `call`, `routines.voice_max_label`, `routines.retry_minutes`, il trigger `routines_call_guard`, il motivo `routine` di `calls` con `calls.routine_run_id` e `calls.routine_attempt` e il codice `expired` di `calls.end_reason` da D-259, tappa B (`0082_routine_call.sql`: la routine con la chiamata, vedi le note); la destinazione `link-video` di `gateway_log` da D-273 (`0085_link_video.sql`: l'indirizzo di un video di YouTube approvato dall'utente, vedi le note); le destinazioni `web-session` e `web-form` di `gateway_log` da D-276 (`0086_browser_session.sql`: le richieste del sito di un accesso fatto dall'utente nel browser dell'agente e i suoi moduli, L2 ammesso solo con le regole `session` e `form`, vedi le note). Per queste tabelle la definizione che fa fede è la migrazione. Le altre tabelle qui sotto sono una bozza e nascono con il task che le usa. Le migrazioni sono file SQL numerati, solo in avanti, applicati da un runner proprio (D-028): una migrazione già applicata non si modifica, se ne aggiunge una nuova.

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
  character_on    boolean NOT NULL DEFAULT true,            -- interruttore «Personaggio» della chat (D-225): false, né blocco del personaggio né battute in nessun prompt della conversazione; si cambia anche in incognito e archiviata, mai da cancellata; evento `conversation.character`
  series_character text,                                    -- personaggio delle serie della chat «con un personaggio» (D-225, tappa B): solo l'id, solo con agent 'claude', di lavoro, senza progetto, mai incognito; scelto alla creazione, mai cambiato
  agent           text,                                     -- chi risponde (D-111, D-111d): NULL Arianna, altrimenti l'id dell'agente della chat diretta (mai arianna, solo origin user); modo e progetto dalla scheda, nel codice; immutabile
  purged_at       timestamptz,                              -- testi cancellati per sempre (purge_conversation o purge_incognito); non compare più
  incognito       boolean NOT NULL DEFAULT false,           -- conversazione incognita (D-136): scelta alla creazione, immutabile; senza titolo, mai archiviata né fissata
  trial_model     text,                                     -- "Prova in chat" (D-142): id del catalogo del modello locale che risponde da solo; solo in un'incognita privata senza agente, immutabile
  secretary       boolean NOT NULL DEFAULT false,           -- la conversazione del pulsante "Segretaria" (D-144): una sola non cancellata (indice unico), privata, dell'utente, di Arianna, mai incognita né archiviata, titolo "Segretaria" dalla nascita; immutabile; mai nella lista
  secretary_session_at timestamptz,                         -- inizio della sessione corrente della segretaria (D-146): l'ultimo clic sul pulsante, o il primo promemoria di oggi ancora senza risposta a quel clic (D-151, `from` nell'evento); solo sulla sua conversazione, solo in avanti; ogni clic è anche un evento `secretary.session`; un task legge i messaggi dall'ultimo clic prima della sua (dal suo `from`, se c'è) nascita, senza riassunti
  direct_session_at timestamptz,                            -- «Nuova sessione» di una chat diretta (D-185): da qui l'agente non riprende la sessione di prima; solo su una conversazione con agente, solo in avanti; evento `direct.session`
  direct_session_open text,                                 -- il mockup aperto nello Studio a quel clic (percorso relativo `.html`, senza parti `.` o `..`), per il riassunto scritto dal codice letto alla prima sessione dopo la riga
  origin          text NOT NULL DEFAULT 'user',             -- user | system: chat di sistema, aperta dal sistema (D-064)
  system_reason   text,                                     -- perché il sistema l'ha aperta: failure (task fallito); solo con origin = system
  source_task_id  uuid REFERENCES tasks(id),                -- il task di cui parla; una sola chat di sistema aperta per task e motivo
  question_attached boolean NOT NULL DEFAULT false,         -- l'utente ha allegato la domanda del task; da false a true, una volta
  source_error_id bigint REFERENCES task_errors(id),        -- l'ultimo errore del task raccontato nella chat; solo verso uno più recente
  side_of         uuid REFERENCES conversations(id),        -- «Chiedi a lato» (D-232, 0071): la conversazione da cui nasce il filo a lato; NULL per le altre; immutabile; mai nella lista
  side_message_id bigint,                                   -- la risposta (role assistant della madre) su cui chiede; con side_of; senza chiave esterna (la cancellazione dei testi della madre toglie i messaggi)
  dashboard_of    uuid,                                     -- Dashboard (D-248, 0074): la conversazione di cui questa rifà la domanda di un riquadro; NULL per le altre; immutabile; privata, mai nella lista; senza chiave esterna (resta come scheletro dopo la cancellazione dei testi)
  plan_approval_id uuid REFERENCES approvals(id) ON DELETE SET NULL, -- 0072, D-235: il piano approvato da cui nasce la card, solo sulle carte; NULL se il piano è stato cancellato con «Elimina per sempre» della sua conversazione
  complexity      text,                                     -- 0072, D-235: S, M o L come l'ha proposta il piano, solo sulle carte
  planning        text,                                     -- 0072, D-235: 'request' sul task della chat di «/progetta», 'card' sulla card «Piano» (senza conversazione, di arianna, una per richiesta)
  finance         boolean NOT NULL DEFAULT false,           -- 0056, D-183: ha letto dati delle finanze; da false a true, mai indietro (trigger); solo privata con effective_label L2; nasce true con l'agente «Finanze» e nella chat di sistema di un task segnato; la segna un task che legge dati delle finanze
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
  kind     text NOT NULL,                                   -- search | read | write | card | plan | error | stop | delegate | tool | wait (mai thinking; stop: errore che chiude il task, D-250, migrazione 0077)
  detail   text NOT NULL,                                   -- lo stesso testo breve della riga dal vivo, ≤ 300 caratteri
  label    privacy_label NOT NULL                           -- ≥ etichetta effettiva del task, ≤ clearance della conversazione
);

-- Terminale del Coder, salvato con la sua delega (D-095, migrazione 0062): solo inserimento e lettura per arianna_app
CREATE TABLE task_terminal (
  id             bigserial PRIMARY KEY,
  delegation_id  bigint NOT NULL REFERENCES task_delegations(id) ON DELETE CASCADE,  -- si cancella con la delega
  ts             timestamptz NOT NULL DEFAULT now(),
  call_id        text NOT NULL,                             -- accoppia comando e uscita, ≤ 128 caratteri
  part           text NOT NULL,                             -- command | output
  label          privacy_label NOT NULL,                    -- solo L0 o L1, ≤ clearance della conversazione
  text           text NOT NULL,                             -- già tagliato (200 righe o 16 KiB), righe col vault sostituite; vuoto se refused
  truncated      boolean NOT NULL,
  hidden         integer NOT NULL,                          -- righe nascoste per un valore del vault
  refused        boolean NOT NULL DEFAULT false,            -- un valore del vault spezzato: nessun testo
  error          boolean NOT NULL DEFAULT false
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
  model           text,                                     -- modello cloud che ha scritto la risposta del task (Claude in una chat di sistema, D-064); NULL: modello locale.
                                                            -- solo assistant senza agent; il trigger messages_model_work lo rifiuta fuori da una conversazione work (L1)
  thought         text,                                     -- il pensiero prima della risposta (D-249, 0078): solo assistant, <= 32000 caratteri, '' se non mostrato; mai in incognito
  thought_ms      integer                                   -- quanto ha pensato, in ms; NULL insieme a thought
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
  design_style    text,                                     -- 0046, D-163: slug di uno stile del catalogo di Open Design, solo sulle card e (0058, D-184) sui task della chat diretta col Designer; non cambia l'etichetta
  design_skills   text[] NOT NULL DEFAULT '{}',             -- 0046, D-163: skill del catalogo (owner/repo/slug), al più 10, solo sulle card e (0058, D-184) sui task della chat diretta col Designer
  finance         boolean NOT NULL DEFAULT false,           -- 0056, D-183: ha letto dati delle finanze; mai indietro; allora effective_label = L2; nasce true in una conversazione segnata o da un padre segnato; il core ne ricrea i contesti con createContext(..., { finance: true }) (finance-mark.ts)
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
-- 0075, D-247: immagini e file allegati in chat, sempre L2; i byte in data/attachments/<id>.<ext>, fuori da git
CREATE TABLE message_attachments (id uuid, conversation_id uuid /* NULL finché è in attesa */, message_id bigint /* idem, poi fisso */,
                             kind text /* image | text */, media_type text /* png, jpeg, webp, gif fino a 10 MB; txt, md, csv, json fino a 256 KiB */,
                             name text /* 1-200, senza "/" */, size_bytes integer, sha256 text, label privacy_label /* sempre L2 */,
                             read_state text /* pending | done | failed */, reading text /* il testo del file o la lettura del modello vision */,
                             read_at timestamptz, created_at timestamptz);
-- 0073, D-235: le note di «Rimanda», solo sulle card, mai cambiate
CREATE TABLE card_returns   (id bigserial, task_id uuid, after_step integer /* l'agente la legge dopo questo passo */,
                             note text /* 1-2000 caratteri */, label privacy_label /* L1 o L2, scelta dall'utente */, created_at timestamptz);

-- 0074, D-248: la Dashboard, una riga per risposta fissata; l'etichetta sale soltanto (0076: kind, chart, la domanda modificabile)
CREATE TABLE dashboard_tiles (id uuid, title text /* 1-80 */, question text /* 1-2000, la domanda di «Aggiorna» */,
                             question_label privacy_label, body text /* <= 32000 */, label privacy_label /* >= question_label, >= la risposta */,
                             source_conversation_id uuid /* ON DELETE CASCADE */, source_message_id bigint /* unica */,
                             answered_by text /* local | claude | codex */, origin_cloud boolean, width text /* narrow | wide */, position integer,
                             refreshed_at timestamptz, refresh_state text /* idle | running | failed */,
                             refresh_error text /* failed | timeout | question | empty | lost */,
                             refresh_conversation_id uuid /* ON DELETE SET NULL */, refresh_started_at timestamptz, created_at timestamptz, updated_at timestamptz);

-- 0048, D-168 (I-16 C1): i clienti. Tutto Privato: label >= L2 e mai in discesa; mai al cloud,
-- a Telegram né al gateway; eventi client.* con soli id e nomi di campo. Mai cancellati (D-046).
CREATE TABLE clients (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL DEFAULT 'company',      -- company | individual | freelancer | public_administration
  status               text NOT NULL DEFAULT 'active',       -- active | prospect | archived (con archived_at)
  display_name         text NOT NULL,                        -- 1-200; legal_name, first_name, last_name, sector, website, notes, tags text[]
  country              text NOT NULL DEFAULT 'IT',           -- ISO 3166-1 alpha-2; l'area (IT, UE, extra UE) è derivata
  vat_number           text,                                 -- partita IVA italiana, 11 cifre; unica fra i clienti non archiviati
  tax_code             text,                                 -- codice fiscale: 16 caratteri o 11 cifre
  eu_vat_number        text,                                 -- con il prefisso del paese (VIES, solo la forma); foreign_tax_id per l'extra UE
  vat_rate             numeric(5,2), vat_nature text,        -- natura N1-N7 di FatturaPA; split_payment, withholding_agent boolean
  sdi_code             text, pec text, ipa_code text, cig text, cup text,  -- fatturazione elettronica
  registered_address   jsonb, billing_address jsonb, shipping_address jsonb, -- {street, number, postalCode, city, province, country}
  billing_email text, payment_method text, payment_days smallint, payment_end_of_month boolean,
  currency text NOT NULL DEFAULT 'EUR', invoice_language text NOT NULL DEFAULT 'it', purchase_order text, iban text,
  email text, phone text, mobile text,
  logo_type            text, logo_sha256 text,               -- il logo in data/clients/<id>/logo.<png|jpg|webp>, fuori da git
  label                privacy_label NOT NULL DEFAULT 'L2',  -- >= L2
  created_at timestamptz, updated_at timestamptz, archived_at timestamptz
);
CREATE TABLE client_contacts (id uuid, client_id uuid, name text, role text, email text, phone text, mobile text, notes text,
                              is_primary boolean /* una al più per cliente */, label privacy_label /* >= L2 */,
                              created_at timestamptz, updated_at timestamptz, removed_at timestamptz /* poi immutabile */);
CREATE TABLE client_projects (id uuid, client_id uuid, project text /* nome di un [[project]] */,
                              created_at timestamptz, removed_at timestamptz);  -- un cliente per progetto; solo la rimozione

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
  finance         boolean NOT NULL DEFAULT false,           -- 0056, D-183: dal task alla nascita del run; mai indietro
  context_tokens  integer,                                  -- 0064, D-212: token nella sessione dopo la risposta di una chat semplice (Claude o ChatGPT senza progetto); solo un numero, NULL altrove
  CHECK (locality = 'local' OR effective_label <= 'L1'),    -- difesa in profondità nel database
  CHECK (NOT finance OR locality = 'local')                 -- un task segnato non lavora mai nel cloud
);

-- Si decide una volta sola; poi la riga è congelata (trigger), e non si cancella.
CREATE TABLE approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid REFERENCES tasks(id),                    -- facoltativo: impostazioni e declassamenti
  kind        text NOT NULL,                                -- action | declassify | budget | setting | workspace (0010: cartella con modifiche non committate, D-056) | commitment (0036: conferma della segretaria, D-144)
  action      text NOT NULL,                                -- per commitment: commitment.add | commitment.done | commitment.move (0038, D-148) | commitment.report (0039, D-151)
  detail      jsonb NOT NULL,                               -- per declassify: text, sha256, from, to; per commitment: op, text, day, time, dayText, step (e commitmentId per done; commitmentId, fromDay e fromTime per move); per il resoconto (D-151) op = report, step ed entries[]: commitmentId, text, day, time, dayText, outcome (done | not_done | postponed), reason, e per un rinvio toDay, toTime, toDayText
  -- commitment: etichetta almeno L2, sempre con un task, si decide solo da web; approvata, scrive o chiude l'impegno nella stessa transazione
  -- plan (0045, D-159): action task.plan, detail title, cards[] (title, goal, assignee, blockedBy: numeri 1-based di card precedenti), step;
  --   etichetta del passo, sempre con un task, solo da web; approvata, crea le card figlie e le loro dipendenze nella stessa transazione
  -- executor (0045, D-159): action card.executor, detail title, agent, options[] (claude | codex | local), excluded[] (executor, reason: label | project | off), step;
  --   etichetta della card, sempre con un task, solo da web
  -- browser (0084, D-268): action browser.click, detail url, site, step; etichetta del passo, al più L1, sempre con un task, solo da web;
  --   approvata, l'indirizzo vale come scritto dall'utente per la conversazione
  choice      text,                                         -- 0045: claude | codex | local, presente se e solo se kind = executor e state = approved (approvals_choice)
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
-- summary solo se allow e <= L1; una riga 'link' ha target link-list, link-click o link-video (0085, D-273), località cloud, niente summary e, se allow, regola 'link'
-- (gateway_log_link_fields, 0042 e 0085).
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
  thought     text,                                        -- ragionamento (D-051): dal 2026-10-17 si vede in chat e si salva con la risposta (D-249)
  thought_ms  integer,                                     -- quanto ha pensato il passo, in ms (D-249, 0078)
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
  read_chat     boolean NOT NULL DEFAULT false,             -- D-220: l'agente locale ha letto la chat oltre al brief; vero solo con executor = 'local'
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
  reason text,                      -- solo out: waiting | task-done | scheduled | routine (D-259)
  task_id uuid REFERENCES tasks(id),-- il task che fa chiamare (out)
  status text NOT NULL,             -- scheduled | ringing | connecting | active | ended | missed | skipped | failed
  scheduled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz, ended_at timestamptz,
  end_reason text,                  -- codice chiuso: hangup, time-limit, disconnected, voice-error, core-restart, no-answer, quiet-hours, daily-limit, cancelled, agent-off, expired (D-259)
  delegations integer NOT NULL DEFAULT 0,
  rang_at timestamptz,              -- quando ha squillato (out): il massimo al giorno conta da qui
  routine_run_id bigint REFERENCES routine_runs(id),  -- D-259 (0082): l'esecuzione della routine che la chiamata consegna, solo con reason = 'routine'
  routine_attempt smallint          -- D-259: 1, o 2 per il secondo squillo; unico con routine_run_id (calls_routine_once)
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
  cases jsonb,                          -- [{id, passed, ms, error?, action?, tool?, firstMs?, tokens?, genMs?}], error = codice
                                        -- D-199: action in call | reply | plan | refuse | unreadable, tool solo dal
                                        -- registro (nomi puntati minuscoli, vincolo model_evals_case_answers); firstMs,
                                        -- tokens e genMs dallo streaming e dal conteggio del server, solo se misurati
  preemptions integer NOT NULL DEFAULT 0, -- casi rifatti per dare precedenza a chiamate e task
  error text,                           -- codice chiuso: user, preempted, interrupted, files-missing, ...
  -- D-199 (0060): velocità, solo su una prova finita (passed/failed); NULL per le prove di prima
  -- e quando il server non dà il conteggio dei token: mai stimata
  tokens_per_second double precision,   -- token scritti / secondi dal primo token (ragionamento compreso), su tutti i casi misurati
  first_token_ms integer,               -- attesa media della prima parola
  -- D-199 (0060): copia della voce del catalogo alla richiesta, scritta una volta; NULL per le prove di prima
  model_name text,                      -- nome leggibile ("Qwen3.8 27B"), dalla pagina del modello o dall'id
  model_provider text,                  -- provider del catalogo
  model_size_bytes bigint,              -- somma dei file
  model_quantization text,              -- "4bit", "Q4_K_M", "bf16" se l'id o la pagina lo dicono
  model_ram_min_gib integer             -- ram_min_gib
);
-- Indici (model_id, requested_at desc) e (role, requested_at desc); una sola prova aperta (queued/running) per modello.
-- Trigger model_evals_guard: modello, ruolo, data della richiesta, pesi e copia del catalogo non cambiano;
-- una riga finita non si riapre; running non torna queued. arianna_app: SELECT, INSERT, UPDATE.

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
CREATE TABLE routines (       -- D-254: le routine di D-110, tappa A (0079); Privato come la conversazione che le tiene
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,                   -- una riga, fino a 80 caratteri; il testo dell'utente, mai in un evento
  conversation_id uuid NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,  -- la sua conversazione privata (L2, di Arianna, dell'utente), immutabile
  days smallint[] NOT NULL,              -- giorni ISO 1-7 (lunedì 1), almeno uno
  at text NOT NULL,                      -- "HH:MM" nel fuso della routine
  timezone text NOT NULL,                -- nome IANA, quello del Mac alla creazione
  sources text[] NOT NULL,               -- elenco chiuso: todo, waiting, cards, done-since, failed-since, notes, dashboard (D-258) (email e calendario con le tappe C e D)
  dashboard_tiles uuid[],                -- D-258 (0081): con la fonte dashboard, NULL = tutti i riquadri, altrimenti gli id scelti (da 1 a 200, mai titoli); un riquadro tolto non si trova più e basta
  summary boolean NOT NULL DEFAULT true, -- tre righe del modello locale dopo il resoconto (routine.summary)
  channel text NOT NULL DEFAULT 'chat',  -- chat | call (D-259, 0082): con call il resoconto arriva in chat e Arianna chiama sulla voce del Mac
  voice_max_label privacy_label NOT NULL DEFAULT 'L2',  -- D-259: i titoli letti al telefono dopo il «sì», fino a questa etichetta; mai L3 (routines_voice_below_secret)
  retry_minutes smallint,                -- D-259: NULL nessun secondo squillo; altrimenti uno, 5-60 minuti dopo una chiamata senza risposta
  status text NOT NULL DEFAULT 'active', -- proposed (A2) | active | paused | retired; da retired non cambia più
  paused_by text,                        -- user | archived, solo da paused
  next_run_at timestamptz,               -- la prossima esecuzione, solo da active
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,               -- prima attivazione (salvata dalla pagina o approvata), una volta
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE routine_runs (   -- D-254: una riga per esecuzione, mai modificata salvo la sintesi
  id bigserial PRIMARY KEY,
  routine_id uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,    -- l'ora del calendario (unica per routine fra le schedule) o l'istante di «Prova adesso»
  trigger text NOT NULL,                 -- schedule | manual
  status text NOT NULL,                  -- done | missed-offline | skipped | failed
  reason text,                           -- codice chiuso: late | blocked | archived | purged | error
  message_id bigint,                     -- il resoconto (o la riga «saltata»); senza chiave esterna: la purge toglie i messaggi
  summary_message_id bigint,             -- la sintesi, se c'è
  summary_state text NOT NULL DEFAULT 'none',  -- none | queued | done | unavailable | failed; da queued una volta sola
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Trigger routines_guard: una routine nasce solo in una conversazione privata L2 dell'utente con Arianna, non archiviata,
-- senza agente, progetto, incognito, segretaria, prova, filo a lato né Dashboard; conversazione e nascita non cambiano.
-- Trigger routine_runs_guard: un'esecuzione resta com'è scritta, solo la sintesi si chiude una volta. arianna_app: SELECT, INSERT, UPDATE.
-- D-256 (0080): routine.propose scrive una routine proposed (next_run_at NULL, approved_at NULL) con la sua
-- conversazione, nascosta dalla lista finché approved_at è NULL, e un'approvazione kind = 'routine',
-- action = 'routine.propose', label >= L2, detail con routineId, title, days, at, timezone, sources, summary e step
-- (approvals_routine_fields; dopo la purge della conversazione che la chiede solo {"purged": true}), decisa solo dal
-- web (approvals_routine_via_web), dalla chat o dalla pagina «Routine». Trigger routines_proposal_guard: una routine
-- nasce proposed (mai approvata) o active; una proposta non cambia i suoi campi e diventa solo active (approvata,
-- con approved_at e next_run_at) o retired (scartata); nessuna torna proposed.
-- D-259 (0082): channel, voice_max_label e retry_minutes; il trigger routines_call_guard tiene fermi voice_max_label e
-- retry_minutes in una routine tolta e in una proposta (channel lo tengono già le due guard di 0079 e 0080, non riscritte). Il detail dell'approvazione porta anche channel.
CREATE TABLE im_closings (   -- D-167: la chiusura di un IM del progetto (I-11, tappa P4b)
  id bigserial PRIMARY KEY,
  project text NOT NULL,                 -- il nome del [[project]]: solo nomi, mai il testo delle voci
  im integer NOT NULL,                   -- il numero dell'IM (file IM-<n>.md); UNIQUE (project, im): si chiede una volta
  message_id bigint REFERENCES messages(id) ON DELETE SET NULL,  -- il messaggio di Arianna che chiede; NULL se non c'era niente di aperto
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz                  -- NULL finché la chiusura aspetta l'utente ("Attende te")
);
-- Le voci restano nel file dell'IM: le risposte (fatta, in parte, non fatta) le scrive il codice nel
-- file. Indice parziale im_closings_open_idx sulle chiusure aperte. arianna_app: SELECT, INSERT, UPDATE.
CREATE TABLE im_prices (     -- D-169: il prezzo di un IM del progetto (I-11, tappa P4d), Privato
  project text PRIMARY KEY,              -- il nome del [[project]]
  amount_cents bigint,                   -- imponibile senza IVA, in centesimi; NULL: nessun prezzo
  currency text NOT NULL DEFAULT 'EUR',  -- ISO 4217
  label privacy_label NOT NULL DEFAULT 'L2',  -- almeno L2
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE im_invoices (   -- D-169: una fattura fatta dall'utente col suo programma, IM di un solo progetto
  id uuid PRIMARY KEY, project text NOT NULL, number text NOT NULL, issued_on date NOT NULL,
  paid_on date, currency text NOT NULL, note text, label privacy_label NOT NULL DEFAULT 'L2',
  document_cents bigint,  -- D-170: il totale del documento com'è sulla fattura (IVA, ritenuta, bollo); NULL per le fatture di prima
  due_on date,            -- D-170: scadenza scritta a mano; NULL = calcolata dai giorni di pagamento del cliente
  created_at timestamptz, updated_at timestamptz, cancelled_at timestamptz  -- annullata, mai cancellata
);
-- Numero unico (senza maiuscole né spazi ai lati) fra le fatture non annullate. Il trigger tiene fissi
-- progetto, valuta e nascita, e una fattura annullata non cambia più.
CREATE TABLE im_billing (    -- D-169: quanto vale un IM (progetto e numero, come dice il file IM-<n>.md)
  project text, im integer, PRIMARY KEY (project, im),
  override_cents bigint,                 -- il prezzo di questo IM, sopra tutto
  not_billed boolean NOT NULL DEFAULT false,
  closed_cents bigint, closed_currency text, closed_at timestamptz,  -- il prezzo del progetto quando il core l'ha visto chiuso; poi fisso
  invoice_id uuid REFERENCES im_invoices(id),  -- la fattura non annullata in cui è entrato; NULL quando ne esce
  label privacy_label NOT NULL DEFAULT 'L2', updated_at timestamptz
);
-- Un IM non fatturato non sta in una fattura; un IM entra solo in una fattura non annullata del suo
-- progetto, e finché ci resta eccezione e non fatturato non cambiano (trigger). Gli eventi im.price.set, im.billing.set e im.invoice.* portano progetto, id,
-- numeri degli IM e nomi dei campi, mai importi né numeri di fattura. arianna_app: SELECT, INSERT, UPDATE.
-- I promemoria della segretaria (D-149, tappa S2) non hanno tabella: un momento scritto è un
-- messaggio di Arianna (role assistant, senza task, etichetta almeno L2) nella conversazione della
-- segretaria, con l'evento message.created che porta anche reminder = morning|afternoon|evening;
-- "una volta per giorno e momento" è l'evento schedule.fired (L0, payload schedule = 'secretary',
-- day, slot, written), scritto nella stessa transazione sotto un advisory lock. Lo stesso evento
-- servirà alle routine di D-110 con un altro schedule.

-- Il tracker delle spese (I-18, D-183, migrazione 0056, contratto in docs/FINANCE-API.md). Tutto Privato
-- (label >= L2, fonte finance:*), solo locale: il gateway rifiuta ogni destinazione cloud (regola finance).
-- Il file importato non si salva. arianna_app: SELECT, INSERT, UPDATE (finance_imports e finance_settings
-- solo SELECT, INSERT); nessun DELETE: ciò che l'utente toglie passa da finance_delete(kind, id)
-- (SECURITY DEFINER come erase_conversation, search_path fisso; kind import | category | rule | budget).
CREATE TABLE finance_accounts (id uuid, name text /* 1-80, una riga */, currency text /* ISO 4217, immutabile */,
  profile jsonb /* BankProfile dell'ultima importazione */, archived boolean, label privacy_label, created_at, updated_at);
CREATE TABLE finance_imports (id uuid, account_id uuid, name text /* nome del file scelto */, imported integer,
  duplicates integer, rejected integer, label privacy_label, created_at timestamptz);   -- mai cambiata
CREATE TABLE finance_transactions (
  id uuid, seq bigserial /* ordine d'inserimento: cronologico dentro un'importazione */, account_id uuid,
  import_id uuid REFERENCES finance_imports ON DELETE CASCADE, booked date, value_date date,
  description text, search text /* senza maiuscole né accenti */, amount bigint /* centesimi */, currency text,
  balance bigint, fingerprint text /* sha256, UNIQUE (account_id, fingerprint) */,
  category_id uuid, category_by text /* rule | user, insieme a category_id */, label privacy_label, created_at timestamptz
);  -- cambia solo la categoria (trigger)
CREATE TABLE finance_categories (id uuid, name text /* unico senza maiuscole */, kind text /* out | in */, label, created_at);
CREATE TABLE finance_rules (id uuid, match text, category_id uuid, label, created_at);  -- in ordine di creazione (matchRule)
CREATE TABLE finance_budgets (category_id uuid PRIMARY KEY, monthly bigint /* centesimi > 0 */, label, updated_at);
CREATE TABLE finance_settings (id boolean PRIMARY KEY /* una riga */, seeded_at timestamptz);  -- categorie predefinite scritte una volta
-- Gli eventi finance.* portano solo id e conteggi, mai descrizioni, importi o nomi di file.

-- «Su di te» (D-114 tappa A, migrazione 0061): il profilo dell'utente, un fatto per riga con la sua
-- etichetta, scritto solo dalle Impostazioni. arianna_app: SELECT, INSERT, UPDATE; nessun DELETE:
-- un fatto si cancella con user_fact_delete(id) (SECURITY DEFINER, search_path fisso; P0002 se manca).
CREATE TABLE user_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,        -- 1-60 caratteri, senza caratteri di controllo; L1 per dichiarazione;
                              -- unico senza maiuscole (user_facts_topic_idx su lower(topic))
  text text NOT NULL,         -- 1-300 caratteri
  label privacy_label NOT NULL DEFAULT 'L2',  -- solo L1 «Condivisibile» o L2 «Solo in casa»; mai L3
  created_at timestamptz NOT NULL DEFAULT now(),  -- mai cambiata
  updated_at timestamptz NOT NULL DEFAULT now()   -- scritta dal trigger a ogni modifica
);
-- Trigger user_facts_guard: un UPDATE L2 → L1 solo nella transazione che ha scritto in label_changes
-- la riga content:<sha256 del testo>, L2 → L1, con un'approvazione declassify approvata dal web;
-- L1 → L2 libero. Un fatto nuovo può nascere L1 (dichiarazione dell'utente, scanner e vault nel core).
-- L'approvazione tiene il testo approvato (append-only, come ogni declassify) anche dopo modifica o cancellazione.
-- Gli eventi user_fact.created | updated | deleted (L1) portano id, argomento ed etichette, mai il testo.
-- Dalla migrazione 0065 il trigger accetta l'abbassamento solo con un'approvazione di azione `declassify`
-- (la pagina), mai con quella di un fatto dato a un agente (`share_fact`).

-- «Su di te», tappe C e D (D-213, migrazione 0065).
-- profile.share: approvals.kind = 'declassify', action = 'share_fact', detail con testo, sha256, from, to
-- più topic, agent e reason (approvals_share_fact_fields), decisa solo dal web (approvals_declassify_via_web).
-- profile.propose: approvals.kind = 'fact', action = 'profile.propose', label >= L2, detail con topic e text
-- (approvals_fact_fields), decisa solo dal web (approvals_fact_via_web); approvata, il core scrive il fatto L2.
-- delegation_facts: quale approvazione va con quale delega, mai il testo. arianna_app: SELECT, INSERT;
-- se ne va solo a cascata con la sua delega o la sua approvazione (purge ed erase di una conversazione). Il trigger delegation_facts_check vuole un'approvazione share_fact approvata dal web, dello
-- stesso task e agente della delega, con la sua riga in label_changes scritta nella stessa transazione.
CREATE TABLE delegation_facts (
  delegation_id bigint NOT NULL REFERENCES task_delegations (id) ON DELETE CASCADE,
  approval_id uuid NOT NULL REFERENCES approvals (id) ON DELETE CASCADE,  -- unica: un fatto esce una volta
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (delegation_id, approval_id)
);
-- Evento fact.shared (L1): topic, to (agente), approvalId, delegationId; mai il testo.

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
- **Eliminazione per sempre di una conversazione (D-157, migrazione `0043`, scelta dell'utente che supera D-046 e D-057 in questo punto):** solo `erase_conversation(uuid)` (`SECURITY DEFINER`, solo `arianna_app`, `search_path` fisso, `lock_timeout` di 5 s), su una conversazione non cancellata che non sia della segretaria, di Telegram né incognita (55000), per la conversazione e le chat di sistema sui suoi task a ogni profondità. Rifiuta (55006) se un job dei suoi task è `running` (un passo preso da un worker) o una chiamata è `ringing`/`connecting`/`active`: il core (`apps/core/src/erase.ts`) ferma prima i passi col segnale `stop` del worker, causa `erase` (il job fallisce con `last_error = 'erase'`), aspetta fino a 15 s, poi riprova una volta; altrimenti 409 e i job fermati tornano in coda (`queued`, come il rilascio del worker): nulla cambia. Una chiamata viva risponde 409 prima di qualunque stop. Rifiuta (55000) se un id delle sue righe (conversazioni, task, run, approvazioni, chiamate) è anche l'id di una riga di un'altra tabella con chiave `id uuid` (un id scelto dal core per prendere gli eventi di un'altra riga). Prende i lock di riga (conversazioni, task, run, approvazioni, chiamate, job per chiave e per payload), poi il lock advisory della catena (dopo cancella solo righe di tabelle append-only, che nessuno scrittore aggiorna), e imposta per la transazione `arianna.erase`, che `append_only`, `events_append_only`, `conversation_participants_guard` e `commitments_guard` rispettano solo quando chi esegue è il proprietario della tabella (`erase_target`, come `purge_target`). **Cancella** ogni riga che nomina la conversazione, i suoi task, i loro run, approvazioni e chiamate: `messages`, `tasks`, `task_turns`, `task_delegations` (con `files`), `task_activities`, `task_errors`, `conversation_summaries`, `conversation_participants`, `approvals`, `label_changes` (per approvazione o per `subject`), `runs`, `router_decisions`, `gateway_log`, `jobs` (per chiave o payload), `calls`, `task_dependencies` e parti di card che li nominassero (difensivo: esistono solo su card, che non hanno conversazione), ed `events` (per `task_id`, `run_id` o uno di quegli id nel payload); infine la conversazione. **Restano** le carte create dai suoi task (task senza conversazione, D-152), con `parent_id` a NULL, e un impegno detto lì (`commitments`) senza `conversation_id`, `task_id` né `approval_id`; i `runs.resumed_from` di altri task verso questi run vanno a NULL. **Catena:** dalla prima riga di `events` tolta in avanti ogni `prev_hash` e `hash` si riscrive in ordine con `event_hash`, nella stessa transazione, poi una sola riga `events.rewoven` (L0, payload `{}`, nessun task, run o agente: dice solo quando) segna la ricucitura; `verify_event_chain`, che usa il doctor, la dà integra. Gli id degli eventi restano quelli (con buchi): `telegram_state.event_cursor` e il feed dal vivo continuano. Nessun evento nomina la conversazione eliminata. Il doctor ammette `erase_conversation` fra le funzioni `SECURITY DEFINER` e ne controlla `search_path` e permessi; `arianna_app` continua a non avere `DELETE` né `UPDATE` su `events`. Dopo il commit il core cancella le cartelle `data/worktrees/<runId>` dei run tolti. **Limiti noti (revisione del 2026-10-10):** restano le righe del gateway delle chiamate vocali, che non portano il task (ora, etichetta e impronta sha256 di ciò che è stato detto, senza testo), e quelle dei link scaricati (`target_kind = 'link'`, impronta dell'indirizzo), che non appartengono a una conversazione; la ricucitura riscrive ogni evento successivo al primo tolto tenendo il lock della catena, quindi eliminare una conversazione vecchia ferma per qualche istante la scrittura degli eventi. Dalla migrazione `0062` la cancellazione delle deleghe porta via a cascata anche il loro terminale salvato (`task_terminal`).
- **Conversazioni incognite (D-136, migrazione `0031`):** `conversations.incognito` si sceglie alla creazione e `conversations_guard` rifiuta ogni cambio. Il vincolo `conversations_incognito_fields` la vuole aperta dall'utente (`origin = 'user'`), senza chat diretta (`agent IS NULL`), senza titolo, mai archiviata né fissata; `conversations_purged_archived_untitled` ammette una cancellata non archiviata solo se incognita. Il trigger `conversations_incognito_source` rifiuta una chat di sistema su un task di un'incognita, `telegram_state_not_incognito` il canale di Telegram legato a un'incognita, `tasks_incognito_title` un task di un'incognita con un titolo diverso da `Incognito` (dalla nascita: l'inizio del messaggio non diventa mai un titolo). **Chiusura:** `purge_incognito(uuid)` (`SECURITY DEFINER`, solo `arianna_app`, `search_path` fisso, come `purge_conversation`) su un'incognita non cancellata, senza chiederne l'archiviazione; rifiuta se un task è `ready`/`running`, un run è `running` o un job è attivo (il core li chiude prima). Cancella e svuota come `purge_conversation`, tiene il titolo `Incognito` dei task, azzera anche `runs.session_ref` e `runs.workspace` e restituisce i conteggi (`tasks`, `messages`, `summaries`) per la scheda di chiusura, più task chiusi e approvazioni scadute come `purge_conversation`. La riga resta come scheletro (`purged_at`, `incognito`, `archived_at` NULL). Il doctor ammette solo queste due funzioni `SECURITY DEFINER` e `lock_incognito` (dalla `0033`). Il test del canarino (`apps/core/test-db/incognito-schema.test.ts`) scrive una stringa unica ovunque e la cerca, dopo la chiusura, in ogni colonna di testo, json e jsonb dello schema. Il core (`apps/core/src/incognito.ts`) chiude un'incognita con "Termina" (`POST /api/conversations/:id/end`), dopo 10 minuti senza pagina e all'avvio prima che il worker riprenda i run: ferma il passo in corso col segnale `stop` del worker (il job fallisce con `last_error = 'incognito'`, mai di nuovo in coda), mette `failed` (causa `incognito`) i task `ready`/`running`, chiude i run rimasti `running`, legge file cambiati (`task_delegations.files`) e invii al cloud (`gateway_log` con il modello del run) per la scheda di chiusura, poi chiama `purge_incognito` e scrive `conversation.incognito-closed` (L0, causa `user`, `idle` o `restart`) e `conversation.purged`. Nella stessa transazione annulla le chiamate ancora `scheduled` della conversazione (`skipped`, `cancelled`) e segna chiusa nel solo database una chiamata viva su di lei (non dovrebbe esistere); le rotte delle chiamate rifiutano comunque un'incognita (409). Se la chiusura fallisce (lock, lavoro che non si ferma: 409 `busy`), `haltIncognito` ferma lo stesso il lavoro in una transazione sua: job `failed`, run chiusi, task `ready`/`running` `failed`. **Migrazione `0032`:** il trigger `task_text_not_purged` rifiuta l'inserimento e la modifica di `task_delegations` e l'inserimento di `task_turns` per un task di una conversazione cancellata, come già facevano messaggi, riassunti e righe di attività: un passo tardivo non scrive più nulla dopo il purge. **Migrazione `0033`:** `lock_incognito(uuid)` (`SECURITY DEFINER`, solo `arianna_app`, `search_path` fisso, `lock_timeout` di 5 s) prende per primi, nell'ordine del purge, i lock di riga che serviranno, anche sulle tabelle dove `arianna_app` non ha UPDATE; la chiusura la chiama prima del primo evento, perché scrivere un evento tiene il lock advisory della catena (`0001_init.sql`) fino al commit e un'attesa dopo fermerebbe ogni altro evento di Arianna.
- **Chat diretta con il Coder (D-111 tappa A, migrazione `0027`):** `conversations.agent` vale `coder` quando nella conversazione risponde il Coder al posto di Arianna. Ammesso solo da `conversations_agent_known` (`NULL` o `coder`) e da `conversations_agent_work_project` (`mode = 'work'`, `origin = 'user'`, `workspace` presente); si sceglie alla creazione (`POST /api/conversations` con `agent`) e il trigger `conversations_agent_fixed` rifiuta ogni cambio. Ogni messaggio dell'utente scrive nella stessa transazione il task (`assignee = 'coder'`) e la sua riga di `task_delegations` al passo 1, con il messaggio come brief; un messaggio nuovo è rifiutato (409) finché un task della conversazione è in coda, al lavoro o in attesa di un'approvazione. Nessuna tabella nuova.
- **«Con chi parli» (D-111 tappa B, D-209, migrazione `0063`):** oltre ad Arianna (`NULL`) e agli agenti della chat diretta, `conversations.agent` vale `local-chat` (il modello locale con la base di conoscenza in sola lettura, solo `mode = 'private'`, `model` sempre `NULL`: `conversations_agent_local_chat`, `conversations_agent_local_model`) oppure `claude` o `codex` (chat semplice senza progetto, solo `mode = 'work'` e `workspace` `NULL`: `conversations_agent_cloud_chat`; per `claude` `model` è `NULL`, cioè Sonnet, `sonnet` o `opus`: `conversations_agent_claude_model`). `coder` vuole lavoro e progetto (`conversations_agent_coder_project`, `NOT VALID`). Per `local-chat` e `claude` un messaggio scrive solo il task, senza `task_delegations`: il passo stesso risponde (il ciclo dell'orchestratore con i due strumenti della scheda, o `runDirect` verso `claude`). La sessione della chat con Claude si ritrova da `runs.session_ref` del run che ha scritto l'ultima risposta (messaggio con `model`); la sua cartella vuota è `data/worktrees/chat-<id>`, fuori dal database. **ChatGPT senza progetto (D-212, migrazione `0064`):** `codex` prende la stessa strada (`runDirect` verso `codex`, sessione da `runs.session_ref` dei run con `executor = 'codex'`, la stessa cartella, che per Codex è un repository git vuoto); `model` è `NULL` (Sol), `luna`, `sol` o `astra` (`conversations_agent_codex_model`). Per le due chat semplici `contextTokens` della conversazione è `runs.context_tokens` del run più recente che l'ha scritto dopo `direct_session_at`; per la chat diretta con un agente resta `task_delegations.context_tokens`.
- **Allegati della chat (D-247, migrazione `0075`):** un'immagine o un file incollato, trascinato o scelto con «Allega file» nasce **in attesa** (`message_id` e `conversation_id` `NULL`) e si lega al messaggio dell'utente che lo porta, nella stessa transazione del messaggio (`bindAttachments`); da lì non si sposta più. Il trigger `message_attachments_guard` lo lega solo a un messaggio `user` della stessa conversazione, privata (`mode = 'private'`, clearance L2), non incognita né cancellata, dell'utente, con Arianna o con il modello locale (mai della segretaria, a lato, delle Finanze o diretta con un agente), e non lascia cambiare nome, tipo, dimensione, impronta, etichetta né ora; la lettura si scrive una volta sola (`pending` → `done` o `failed`). I vincoli tengono `label = 'L2'`, i tipi chiusi (mai SVG) con i loro tetti, e `reading` presente solo con `done` (il testo di un file di testo nasce `done`). Il core controlla prima (`attachmentRefusal` di `apps/core/src/attachments.ts`): solo una conversazione privata dell'utente con Arianna o con il modello locale, mai di lavoro, incognita, della segretaria, a lato, di sistema o diretta con un agente; un messaggio con allegati non entra nella coda di D-218. «Elimina» (D-157) porta via le righe a cascata con i messaggi e la conversazione, e il core cancella i file subito dopo; `purge_conversation` le toglie col trigger `message_attachments_purge` e la rotta della purge cancella i file subito dopo. Un allegato in attesa si toglie solo con `message_attachment_discard(uuid)` («×» nel campo) o `message_attachments_prune(timestamptz)` (all'avvio, quelli più vecchi di un giorno), entrambe `SECURITY DEFINER`; il core poi cancella i file senza riga. Eventi: `attachment.sent` (conversazione, messaggio, quanti) e `attachment.unread` (id, task e motivo in valori chiusi), mai nomi né letture. `arianna_app` legge, inserisce e aggiorna.
- **Fili a lato (D-232, migrazione `0071`):** «Chiedi a lato» su una risposta crea (una volta, poi la ritrova) una conversazione con `side_of` = la madre e `side_message_id` = la risposta. `conversations_side_guard` (BEFORE INSERT OR UPDATE) rifiuta un filo di una conversazione cancellata, archiviata, di sistema, incognita, della segretaria, di prova, di un filo o di una chat diretta con un agente (ammessi `agent` `NULL`, `local-chat`, `claude`, `codex`), con modo, clearance, interlocutore, modello o progetto diversi dalla madre, o su un messaggio che non è una risposta della madre; alza `effective_label` al massimo fra la sua, quella della madre e quella della risposta e copia il segno delle finanze; le due colonne non cambiano più. `conversations_side_pair` le vuole insieme, `conversations_side_fields` vuole il filo dell'utente, mai incognito, della segretaria, di prova o fissato; `conversations_side_one` ne tiene uno vivo per risposta. Il core non lo mette in lista, nella ricerca né fra le destinazioni di una nota rilasciata; un filo non riceve messaggi mentre la madre è archiviata. Il modello del filo legge in testa la risposta e fino a 10 messaggi della madre prima di lei (`sideContext` in `apps/core/src/side-threads.ts`), poi i messaggi del filo; la madre non legge mai il filo. `purge_conversation` cancella prima, archiviandoli, i fili della conversazione come le chat di sistema sui suoi task (nella lista `system` del risultato, evento `conversation.purged` con `cause: 'source'`); `erase_conversation` li prende nel suo albero. Nessun permesso nuovo.
- **Dashboard (D-248, migrazioni `0074` e `0076`):** «Fissa alla Dashboard» su una risposta scrive una riga di `dashboard_tiles` con titolo, domanda per gli aggiornamenti, testo ed etichetta presi dal messaggio (mai dalla pagina). `dashboard_tiles_guard` (BEFORE INSERT OR UPDATE) rifiuta una risposta di una conversazione cancellata, incognita, di prova, di sistema, di un filo a lato o di un aggiornamento, un messaggio che non è una risposta della conversazione, un riquadro meno protetto della risposta; poi non lascia cambiare l'etichetta della domanda (la domanda sì, da `0076`, mai mentre si aggiorna), conversazione, messaggio e origine cloud, né abbassare `label`, e vuole la conversazione dell'aggiornamento nata dalla sua conversazione e di nessun altro riquadro. Vincoli: `label >= question_label`, errore solo con `failed`, ora d'inizio con `running`, un riquadro Segreto mai in aggiornamento, una sola riga per risposta. «Aggiorna» crea una conversazione con `dashboard_of` = la conversazione d'origine: `conversations_dashboard_fields` la vuole privata (L2), dell'utente, mai incognita, della segretaria, di prova, filo a lato, fissata, con progetto o modello, e con `local-chat` o un agente delle finanze; `conversations_dashboard_guard` vuole viva la conversazione nominata e non lascia cambiare la colonna. Il core scrive lì la domanda all'etichetta `question_label`, il task la fa rispondere sul modello locale e, a lavoro finito, copia la risposta nel riquadro (etichetta alzata al massimo fra le due) e cancella per sempre la conversazione con `erase_conversation` (testi, task ed eventi; la catena si ricuce dai soli eventi di quell'aggiornamento). `arianna_app` legge, inserisce e aggiorna; toglie un riquadro solo con `remove_dashboard_tile(uuid)` (`SECURITY DEFINER`, rifiutata mentre si aggiorna, ammessa dal doctor come `user_fact_delete`). «Elimina» della conversazione d'origine (`erase_conversation`) porta via i riquadri a cascata; il core cancella prima le conversazioni d'aggiornamento ancora vive. `purgeConversation` toglie prima riquadri e aggiornamenti vivi. Ringer, attese e stato non contano le conversazioni d'aggiornamento. Eventi `dashboard.*` con soli id (riquadro e conversazione d'origine) e, per un fallimento, il codice dell'errore.
- **Conversazioni fissate (D-089, migrazione `0022`):** `pinned_at` è l'ora in cui l'utente l'ha fissata; `GET /api/conversations` mette prima le fissate (l'ultima in alto), poi le altre per attività. Nessun limite di numero. Il vincolo `conversations_pinned_listed` vieta una fissata archiviata e il trigger `conversations_unpin_archived` toglie la fissatura quando una conversazione si archivia (anche quella di sistema archiviata da `purge_conversation`); fissare un'archiviata è rifiutato dal core (409), ripristinarla non la rifissa. Nessun permesso nuovo: `arianna_app` aggiorna `conversations` a livello di tabella e `conversations_guard` blocca le altre colonne. Evento `conversation.pinned` con il solo id. **Messaggi salvati in inbox (D-089):** non sono nel database: la nota di `kb/inbox/` scrive `source: message:<id>` e il core la cerca lì (un salvataggio per messaggio, `GET /api/conversations/:id/saved`).
- **Righe di attività salvate (D-083, migrazione `0021`):** `postActivity` (`apps/core/src/reply.ts`) salva in `task_activities` la stessa riga che manda alla chat dal vivo, dopo gli stessi filtri (valori del vault rifiutati, spazi e caratteri di controllo compattati, al massimo 300 caratteri), con l'etichetta effettiva del task in quel momento; non salva `thinking` né una riga uguale all'ultima del task; un salvataggio fallito non ferma la riga dal vivo. Il trigger `task_activities_guard` rifiuta un task senza conversazione o di una conversazione cancellata, un'etichetta sotto quella del task o sopra la clearance della conversazione e la riga oltre la duecentesima del task (con un lock consultivo per task, nessuna riga di `tasks` bloccata). La chat le legge con `GET /api/tasks/:id/activities` (righe ≤ clearance della conversazione) e conta le righe per task con `GET /api/conversations/:id/activity-counts`. `purge_conversation` le cancella con i turni.
- **Terminale salvato (D-095, migrazione `0062`, scelta dell'utente del 2026-10-14):** il core salva in `task_terminal` ciò che manda al pannello «Computer» (`saveTerminal`, `apps/core/src/live-terminal.ts`), dopo gli stessi filtri: solo progetti fino a L1 e dentro la clearance del task, valori del vault sostituiti, testo tagliato. Mai per una conversazione in incognito (controllato nel core e dal trigger `task_terminal_guard`, che rifiuta anche una conversazione cancellata e un'etichetta sopra la sua clearance); al massimo 400 righe per delega (il core smette prima di salvare, al tetto o al primo errore). Le password scritte nei file del progetto (un `.env`) non sono note al vault e restano nel testo, quindi anche nel database e nei suoi backup. Le righe dipendono dalla delega con `ON DELETE CASCADE`: `erase_conversation`, `purge_conversation` e `purge_incognito`, che cancellano le deleghe, le cancellano senza cambiare. Le legge solo `GET /api/tasks/:id/terminal`, dentro la clearance della conversazione; nessun modello le rilegge.
- **Errori leggibili e chat di sistema (D-064, migrazione `0013`):** quando un task fallisce (tentativi del job esauriti, worker morto, esito `failed` dell'esecutore) il core scrive nella stessa transazione una riga di `task_errors` e l'evento `task.failed` (L0, solo origine e codice). I dettagli sono scalari da una lista chiusa per codice (`apps/core/src/failures.ts`: endpoint, porta, stato HTTP, tentativi, codice SQL, esecutore, classe dell'errore), mai messaggi né output; il database rifiuta oggetti, liste e stringhe oltre 100 caratteri. Un task riprovato che fallisce di nuovo ha una riga nuova: vale l'ultima. `POST /api/tasks/:id/retry` riporta un task `failed` in `ready` con un job nuovo (evento `task.retried`), mai per una conversazione archiviata o eliminata. Una chat di sistema (`origin = 'system'`) prende il modo della conversazione del task (senza conversazione: privata; trigger `conversations_system_mode`), non ha progetto, ed è una sola per task finché non è eliminata (indice unico parziale); se ne apre una nuova solo per un task `failed` in quel momento. Il titolo nomina l'origine dell'errore, mai il task (il titolo del task è l'inizio della domanda). Riaperta dopo un nuovo fallimento, riceve un messaggio `system` con l'errore nuovo (`source_error_id`). Il primo messaggio, `role = 'system'`, contiene solo l'errore con l'etichetta della riga; la domanda del task entra solo con `POST /api/conversations/:id/question`, con la sua etichetta, una volta. L'orchestratore legge i messaggi `system` come messaggi dell'utente marcati. `purge_conversation` elimina prima, archiviandole, le chat di sistema sui task della conversazione (ricorsivo): una chat di sistema al lavoro blocca l'intera eliminazione. Quell'archiviazione non scrive `conversation.archived`: basta `conversation.purged` con `cause: 'source'`. `task_errors` resta: non ha testi.
- **Telegram (task 1.15, D-044; spento per ora, D-110):** il bot scrive in una sola conversazione `work`, legata in `telegram_state`; un messaggio da Telegram è un messaggio dell'utente con `channel = 'telegram'`, scritto nella stessa transazione che sposta `update_offset`, così un aggiornamento si applica una volta sola. Un pulsante decide un'approvazione con `decided_via = 'telegram'` nella stessa transazione dell'offset; i declassamenti restano solo web (`approvals_declassify_via_web`). Gli avvisi verso Telegram nascono dagli eventi `approval.requested` e `message.created`, letti in ordine da `event_cursor`: dopo un crollo un avviso può ripetersi, non perdersi. Ogni testo verso Telegram ha la sua riga in `gateway_log` (`target = 'telegram'`). Dopo una settimana senza update Telegram può ripartire con id più bassi: dopo due giorni di quiete (`telegram_offset_stale`; Telegram tiene un update non consegnato 24 ore) qualsiasi id è nuovo. Un update o un evento che fallisce sempre per un errore che non è di rete si salta dopo alcuni tentativi, con un evento `telegram.failed` che porta solo un codice. Gli aggiornamenti di chi non è ammesso lasciano al massimo un evento `telegram.ignored` al minuto, senza id né contenuto. Il titolo mostrato in un avviso è quello del task, la cui etichetta è `tasks.label`: un futuro aggiornamento del titolo dovrà rispettarla.
- **Delega (task 1.10, seconda parte, D-055):** una chiamata `task.delegate` scrive il turno (senza risultato) e una riga in `task_delegations` nella stessa transazione; il passo successivo del task è il run cloud (`runs.locality = cloud`, `effective_label` del run = etichetta del brief, non del task), che aggiorna la riga; il passo dopo legge `result` come risultato dello strumento. Un brief sopra L1 aspetta un'approvazione `declassify` (cercata per `detail.sha256` del brief); Fable un'approvazione `budget` (`detail.step` = passo della delega). Un rifiuto di quota rimette la delega `pending` e riaccoda lo stesso passo (`jobs.run_at`, evento `task.retry`); il run finisce `failed`. Con D-056 la cartella di lavoro è il repository stesso: modifiche non committate (`git status`) fermano il task con un'approvazione `workspace` (`detail.step` = passo della delega, `detail.files` = percorsi); i file cambiati dal run finiscono in `result`, non nel messaggio del Coder, e (D-082) in `task_delegations.files` con il tipo di cambio, prima che il rapporto sia salvato. Il rapporto del Coder è un messaggio con `agent = 'coder'`, che l'orchestratore non rilegge come storia della chat e che il controllo "task già risposto" ignora. Dopo un crash fra il salvataggio del rapporto e la chiusura della delega, il passo riprende il rapporto dell'agente scritto dopo `task_delegations.created_at` e non collegato ad altre deleghe (`message_id`), senza rilanciare il run: mai il rapporto di una delega precedente dello stesso task. **Agenti utente (D-119, tappa T3, migrazione `0025`):** `task.delegate` nomina il Coder o un agente utente attivo che un esecutore può far girare. Un agente `code` segue la strada del Coder; un agente senza strumenti (modello `answer`) lavora sul modello locale: il passo dopo la chiamata è un run `locality = local` con `executor = 'local'` sulla delega (`repo` vuoto), una sola chiamata con il prompt dell'agente (L1 per dichiarazione) e il brief, passati dal gateway verso `local`; il rapporto è un messaggio con `agent` = nome dell'agente e porta l'etichetta più alta fra brief e prompt. Il vincolo `task_delegations_guard` vuole un run locale per `executor = 'local'` e un run cloud per gli altri. Un brief sopra la clearance dell'agente (L1 per un agente `answer` creato dall'utente) aspetta un'approvazione `declassify` verso quella etichetta.
- **Partecipanti (D-125, migrazione `0026`):** `task.delegate` porta anche `reason`, una riga breve scritta da Arianna. Alla delega verso un agente che non è partecipante attivo della conversazione, nella stessa transazione del turno e della delega, il core inserisce la riga in `conversation_participants` (`added_by = 'arianna'`, con task e delega; `ON CONFLICT` sull'indice parziale: due task insieme lo aggiungono una volta), l'evento `participant.added` (L1, solo id) e due messaggi `role = 'system'` con `task_id`: "Arianna aggiunge <agente>: <reason>" (etichetta = più alta fra quella del turno e quella del nome; il `reason` passa prima il gateway verso `channel:web`, e se è fermato la riga dice solo chi entra) e "<agente> è stato aggiunto" (etichetta del nome: L0 per un agente di `agents/`, L1 per uno dell'utente). Un messaggio di sistema con task è solo per l'utente: né l'orchestratore né i riassunti lo leggono (`conversationView`), e da questa migrazione nemmeno `conversation_summaries_guard` lo conta come buco fra due pezzi o nell'etichetta di un pezzo. Il run della delega che ha portato dentro l'agente, se l'agente è ancora attivo, riceve la frase fissa d'ingresso (`ENTRY_TEXT`, L0): fra prompt dell'agente e brief verso Claude, in coda al prompt di sistema sul modello locale; dalla seconda delega niente righe né frase. Arianna legge i partecipanti attivi all'inizio del task come nota di sistema dopo la chat ("In this conversation: …", mai nel prompt di sistema). L'utente toglie un partecipante (`POST /api/conversations/:id/participants/:agent/remove`): `removed_at`, evento `participant.removed` (L1) e la riga "Hai tolto <agente>" con il task che l'aveva portato dentro; alla delega seguente rientra con una riga nuova. `GET /api/conversations/:id/participants` dà i partecipanti attivi con l'esecutore. Il trigger `conversation_participants_guard` rifiuta una conversazione cancellata, una riga che nasce tolta, un task di un'altra conversazione o una delega di un altro task o agente, ogni modifica che non sia impostare `removed_at` una volta, e la cancellazione fuori da `purge_conversation`, che cancella le righe prima delle deleghe. `arianna_app` ha `SELECT`, `INSERT` e `UPDATE`.
- **Orchestratore (task 1.10, D-053):** il contesto di un task si ricostruisce a ogni passo dai messaggi della conversazione fino a quello che l'ha aperto e dai suoi `task_turns`, mai da quelli di altri task. Dei messaggi legge il riassunto (`conversation_summaries`, pezzi con `last_message_id` fino a quel messaggio) e quelli da un'ancora in poi (D-077): l'ancora si ricalcola dai messaggi dopo l'ultimo pezzo, resta ferma fino a 30 messaggi o 24.000 caratteri e poi salta lasciandone 10; i messaggi lasciati indietro diventano un pezzo nuovo, scritto dal modello locale al primo passo del task, prima della risposta (i passi successivi leggono soltanto). Un intervallo che il gateway blocca riceve un pezzo segnaposto senza contenuto; uno sopra la clearance del task nessun pezzo. Senza il pezzo (modello fermo, conflitto, massimo di pezzi) il passo legge la finestra ancorata e basta, e il core scrive l'evento `summary.degraded` (L0, solo conversazione e motivo). Inserire un turno alza `tasks.effective_label` alla sua etichetta (trigger `task_turns_within_task`); `effective_label` di un task non scende mai (`tasks_label_only_up`). Una risposta in chat chiude il task in `done` con il messaggio come prova (`running` → `done` solo così). Un passo che trova già il suo turno non richiama il modello.
- **`task.update` dell'orchestratore (task 1.10, D-101 proposta, migrazione `0023`):** sposta una carta e ci scrive una nota. Carte ammesse: le figlie aperte (`inbox`, `ready`, `waiting_user`, `to_verify`) dei task della stessa conversazione (senza conversazione: del task stesso), con etichetta entro la clearance del task, senza job attivo né approvazione pendente; un id sconosciuto o di un'altra conversazione dà lo stesso errore, con le carte aggiornabili elencate; un prefisso di almeno 8 caratteri vale se indica una carta sola. Le mosse sono quelle di `task-status.ts`, più l'autonomia: A0 non sposta carte; A1 non mette carte in `ready`, salvo chiudere un'attesa aperta da un agente (ultimo `task.status` verso `waiting_user` con causa `agent`). `waiting_user` vuole la nota, che diventa anche `waiting_reason`. La nota porta l'etichetta del contesto del passo: rifiutata sopra la clearance della carta, alza `label` ed `effective_label`. Eventi: `task.status` (causa `agent`), `task.updated` (etichetta della nota, solo id, stati e se c'è una nota) e, una volta per task, `task.offer` (L0, `{update}`: se lo strumento è offerto, deciso al primo passo e tenuto per tutto il task). La nota resta in locale, come il titolo: niente gateway; sopravvive a `purge_conversation` con la carta. Una carta in `waiting_user` compare in `GET /api/tasks/waiting` (senza conversazione, motivo `other`); una in Pronti non parte da sola (nessun job).
- **Attese superate e "Chiudi" (D-109, da confermare; nessuna migrazione):** quando l'utente scrive in una conversazione, nella stessa transazione del messaggio (`writeUserMessage`, dopo i controlli di archivio e scanner) i task di quella conversazione in `waiting_user` senza un'approvazione `pending` (né quella di `waiting_approval_id` né un'altra del task) passano a `done`: evento `task.status` con `cause: 'superseded'` (payload solo `from`, `to`, `cause`) e prova accodata `{kind: 'superseded', ref: <id della riga di sistema>}` (il vincolo `tasks_done_needs_evidence` vuole una prova). La conversazione riceve una riga `role = 'system'`, L0, testo fisso "Attesa chiusa: la conversazione è andata avanti.", con `task_id` del (primo) task chiuso, prima del messaggio nuovo; una sola riga per messaggio. Un messaggio `system` con `task_id` è solo per l'utente: `conversationView` lo esclude, quindi né l'orchestratore né i riassunti lo leggono (i messaggi `system` delle chat di sistema, D-064, non hanno task e restano letti). Le carte senza conversazione (D-101) non sono toccate. `POST /api/tasks/:id/dismiss` (corpo `{}`, "Chiudi" in "Decisioni in attesa"): blocca prima le approvazioni pendenti del task, poi il task (l'ordine di `recordDecisionIn` e `resumeTask`); le approvazioni scadono (`expired`, evento `approval.decided` con `via: null`) e il task passa a `done` con `cause: 'user'` e prova `{kind: 'dismissed', by: 'user'}`. 404 per un task inesistente; 409 per un task non in attesa o di una conversazione eliminata; ammessa per una archiviata. Una decisione arrivata dopo trova l'approvazione scaduta (409).
- **Routine (D-254, tappa A di D-110, migrazione `0079`):** un ticker del core (`apps/core/src/routines.ts`) guarda ogni 30 secondi le routine `active` con `next_run_at <= now()`. Sotto il lock della riga, solo se `next_run_at` è ancora quello letto, scrive l'esecuzione in `routine_runs` (indice unico `routine_runs_once` su routine e `scheduled_for` fra le `schedule`), il messaggio di Arianna nella conversazione della routine e la prossima esecuzione, calcolata da `nextRun` (`routine-schedule.ts`) dopo l'ora di adesso: i giorni persi non si recuperano. Entro 5 minuti il resoconto è puntuale, fino a 2 ore arriva con le scuse (`reason = 'late'`), oltre è `missed-offline` con una sola riga L0. Il resoconto lo scrive il codice da `tasks` (solo le carte, cioè i task senza conversazione; sopra L2 solo contate), dal conteggio di D-091 e dai file `status: new` di `kb/inbox/`; passa il gateway verso `web`; ha almeno L2. Con `summary` lo stesso messaggio entra in un job `routine.summary` (payload con `runId`, `routineId`, `conversationId` e la scadenza a 20 minuti, così `erase_conversation` lo trova), che lo dà al modello locale senza strumenti e scrive la sintesi con la stessa etichetta, oppure la riga «Sintesi non disponibile». Archiviare la conversazione mette la routine in `paused` con `paused_by = 'archived'` (in `archiveConversation`); cancellare la conversazione (`purgeConversation`) la porta a `retired` nella stessa transazione e ne sostituisce il titolo con «Routine cancellata» (il trigger lo ammette anche su una routine già tolta); `erase_conversation` la cancella con le esecuzioni per `ON DELETE CASCADE`. Eventi L0: `routine.created`, `routine.updated` (nomi dei campi), `routine.paused` e `routine.retired` (con `by`), `routine.resumed`, `routine.run`, `routine.missed`, `routine.summary`, tutti con `routineId` e `conversationId` (così `erase_conversation` li toglie), mai il titolo. I codici `archived` e `purged` di `reason` e lo stato `skipped` sono per le tappe successive. Il messaggio porta `routine` nell'evento `message.created`. Il ticker prende un'esecuzione solo se sotto il lock anche giorni, ora, fuso, fonti e sintesi sono quelli da cui ha scritto il resoconto (D-257); una modifica in mezzo lo fa rinunciare fino al giro dopo.
- **Pagine lette da Arianna (D-262, P7, migrazione `0083`):** ogni pagina chiesta con lo strumento `web.fetch` lascia un evento `web.fetch` con la label del passo e solo `{ conversationId, site, outcome }` (mai l'indirizzo intero, che sta in `gateway_log` come sha256, né il testo). Il core li conta prima di ogni pagina: al più 5 per task e 30 al giorno (giorno italiano), contando anche gli esiti `blocked`; il controllo e la scrittura non sono atomici, quindi due turni in parallelo possono superare di poco il tetto. Indice parziale `events_web_fetch_idx` su `events (ts) WHERE kind = 'web.fetch'`. Nessun permesso nuovo per `arianna_app`.
- **Wiki proposta (D-280, nessuna migrazione):** i job della Wiki stanno nella coda `note.organize`: `{ wiki: 'note', page, force? }` (chiave `wiki-note:<nota>` o `wiki-note-again:<nota>`, `page` relativo a `kb/`) e `{ wiki: 'index', folder }` (chiave `wiki-index:<cartella>`); `last_error` un codice. Pagine, indici, proposte (JSON in `kb/wiki/.proposte/`) e versioni (`kb/wiki/.storia/`) sono file, nessuna tabella. Eventi L0: `wiki.proposed {jobId, action, points, citations}`, `wiki.propose_failed {jobId, reason, retry?}`, `wiki.index_written {jobId}`, `wiki.index_failed {jobId, reason, retry?}`, `wiki.approved {action, corrected, points, relinked}`, `wiki.discarded {action}`, `wiki.move_proposed {pages}`, `wiki.restored {}`, `wiki.deleted {versions, proposals}`, `wiki.edited {}`, `wiki.created {kind}` (`page`, `folder`), `wiki.moved {kind, pages, relinked}`.
- **Video di YouTube in Pensieri (D-273 tappa A, migrazione `0085`):** «Riassumi il video» mette un job nella coda `note.video` (chiave `note-video:<percorso>`, payload solo il percorso della nota; `last_error` un codice di `VIDEO_FAILURES`, che la chat mostra in italiano). L'indirizzo esce con una riga di `gateway_log` `target_kind = 'link'`, `target = 'link-video'` (vincolo `gateway_log_link_fields` riscritto da `0085`), solo sha256 e byte. Eventi L0 con soli codici: `note.video_fetched {jobId, source, minutes}` (`source`: `subtitles`, `automatic`, `audio`) e `note.video_failed {jobId, reason, retry?}`. La nota del video sta in `kb/inbox` come le altre, con i campi d'intestazione `media: youtube`, `video_id`, `channel`, `duration` (secondi) e `transcript_source`; nessuna tabella nuova.
- **Browser di Arianna in chat (D-264 passo 3, D-268, migrazione `0084`):** ogni azione di uno strumento del browser lascia un evento `browser.action` con la label del passo e solo `{ conversationId, action, outcome, chars? }` (`chars` solo per `type`: il numero di caratteri, mai il testo; mai indirizzi né etichette degli elementi); il core li conta per task prima di ogni azione, al più 20 per risposta (indice parziale `events_browser_action_idx` su `events (task_id) WHERE kind = 'browser.action'`). In una conversazione Interna un link verso un sito fuori consenso scrive un'approvazione `kind = 'browser'`, `action = 'browser.click'`, `detail = { url, site, step }`, con la label del passo (al più L1: l'indirizzo è contenuto pubblico di una pagina), decisa solo dalla chat web (`approvals_browser_via_web`; vincolo dei campi `approvals_browser_fields`, `{"purged": true}` dopo la cancellazione della conversazione). Approvata, l'indirizzo vale come scritto dall'utente per tutta la conversazione (lo legge il consenso dei passi seguenti). La riga «Browser chiuso: lo usa un'altra chat» è un messaggio `system` senza `task_id`, così lo legge anche il modello. Nessun permesso nuovo per `arianna_app`.
- **Schermo in diretta del browser (D-264 passo 4, D-270):** ogni schermo aperto dalla chat lascia `browser.screen` L0 con `{state: 'opened', conversationId}` e, alla fine, `{state: 'closed', conversationId, ms, reason}` (`browser-closed`, `refused-message`, `vnc-closed`, `overflow`, `core-stopping`, con un dettaglio come `page-closed` o il motivo del filtro); mai byte dello schermo, sito o indirizzo. I gettoni restano solo in memoria (sha256), nessuna tabella. «Chiudi» nella chat lascia `browser.close` L0 con `{conversationId, reason: 'user'}` e la riga `system` senza `task_id` «Browser chiuso da te. Se serve, Arianna lo riapre.».
- **«Prendi il controllo» e accesso fatto dall'utente (D-264 passo 5, D-276, migrazione `0086`):** ogni passaggio del controllo lascia `browser.control` L0 con `{state: 'taken', conversationId}` e, alla fine, `{state: 'returned', conversationId, reason, ms, keys, clicks}` (`reason`: `user`, `screen-closed`, `idle` o `browser-closed`; il passaggio a un altro schermo non chiude il controllo, cambia lo schermo che guida; tasti e clic solo contati, mai i valori). Le richieste fatte mentre guida l'utente vanno in `gateway_log` senza `task_id`. Il primo modulo dell'utente verso il sito della pagina lascia una riga `target_kind = 'web'`, `target = 'web-form'`, regola `form`, `bytes_out` la dimensione del corpo e `sha256` del solo indirizzo, mai il contenuto; da lì le richieste del sito dell'accesso sono righe `web-session`, regola `session`, L2. `0086` riscrive `gateway_log_cloud_up_to_l1` (L2 verso il cloud ammesso anche per `web-session`/`web-form` con le loro regole) e aggiunge `gateway_log_session_fields` (quelle destinazioni solo `web`, cloud e senza `summary`; le regole `session` e `form` solo con loro). Evento `browser.access` L0 senza payload quando nasce l'accesso; dopo, `browser.navigate` non porta più il sito. I cookie restano solo in memoria del core, nessuna tabella. Le righe di sistema «La pagina di <sito> chiede un accesso…» sono messaggi `system` senza `task_id`, scritte al più una volta ogni 10 minuti. Nessun permesso nuovo per `arianna_app`.
- **Routine proposte in chat (D-256, tappa A2 di D-110, migrazione `0080`):** lo strumento `routine.propose` dell'orchestratore (offerto ad Arianna fuori dall'incognita e dalla segretaria) scrive solo da una conversazione privata dell'utente con Arianna (mai di lavoro, diretta con un modello, di prova, a lato o della Dashboard: altrove è un errore per il modello), passa campi chiusi controllati dal codice (`checkRoutineProposal` in `apps/core/src/routine-proposals.ts`: titolo di una riga fino a 80 caratteri, giorni ISO, `HH:MM`, fonti dell'elenco chiuso, sintesi; fuso del Mac; ogni altro campo, come un prompt, è un errore per il modello). Con il turno, nella stessa transazione, il core scrive la routine `proposed` con la sua conversazione e l'approvazione `routine` (L2 almeno); il task aspetta. La decisione (`recordDecisionIn` dalla chat, `decideRoutine` dalla pagina, che decide anche l'approvazione ancora in attesa) chiama `decideRoutineProposal`: approvata, `active` con `next_run_at` da adesso e `approved_at`; scartata, `retired`. Il passo dopo risponde senza modello con un testo del codice. `listConversations` non mostra la chat di una routine mai approvata. Eventi L0: `routine.proposed` (con `approvalId`), `routine.approved`, `routine.retired` con `by: 'discarded'`, mai il titolo. Una proposta non si modifica, non si prova e non va in pausa; «Togli» la scarta. Se la conversazione che la chiede è cancellata, l'approvazione scade e la proposta resta nella pagina, da attivare o scartare.
- **Dashboard aggiornata dalle routine (D-258, migrazione `0081`):** la fonte `dashboard` di `routines.sources` (vincolo `routines_sources_check` riscritto, da 1 a 7 fonti) e `routines.dashboard_tiles` (`uuid[]`; `NULL` = ogni riquadro che c'è all'ora dell'esecuzione; altrimenti da 1 a 200 id, solo con la fonte: vincolo `routines_dashboard_tiles`). La lista non ha chiavi esterne: il core la legge contro `dashboard_tiles` (`TILES_CHOSEN` in `routines.ts`), così un riquadro tolto sparisce dalla routine senza errori e una lista rimasta senza riquadri dà un resoconto «Dashboard: nessun riquadro da aggiornare.»; il prossimo salvataggio dalla pagina la riscrive con i soli riquadri presenti (una modifica che non tocca la scelta la lascia com'è). `routines_guard` e `routines_proposal_guard` riscritte con la colonna: una routine tolta non la cambia più, una proposta (`routine.propose`) nasce sempre con `NULL` e resta com'è. All'esecuzione (del calendario e «Prova adesso», non per una persa né per un resoconto fermato dal gateway) il core giudica i riquadri con le regole di «Aggiorna» (`refreshCandidates` in `dashboard.ts`: Segreto mai, uno in aggiornamento saltato, uno il cui agente non è caricato non aggiornabile) e, nella stessa transazione che scrive l'esecuzione e il resoconto, avvia per ognuno lo stesso aggiornamento della pagina (`startRefreshIn`, in un savepoint per riquadro): conversazione privata nascosta `dashboard_of`, task `ready` del modello locale, poi `settleDashboard` copia la risposta e cancella la conversazione. Eventi: `dashboard.tile_refreshing` con `routineId` in più, `routine.run` con `tiles` (quanti avviati, solo il numero).
- **Routine con la chiamata (D-259, tappa B di D-110, migrazione `0082`):** un'esecuzione `done` del calendario di una routine con `channel = 'call'` scrive, nella stessa transazione del resoconto, una riga di `calls` con `reason = 'routine'`, `status = 'scheduled'`, `scheduled_at = now()`, `routine_run_id` e `routine_attempt = 1` (evento `call.scheduled` con `callId`, `routineId`, `runId` e `attempt`, mai il titolo). «Prova adesso», un'esecuzione `missed-offline` o fallita non chiamano. Il ringer di D-066 (`apps/core/src/voice/ringer.ts`) la prende dopo le chiamate programmate dall'utente, se la routine è ancora `active` e la conversazione aperta; la regola è `mayCall` con il motivo `routine`: il primo squillo salta silenzio e fine settimana, il secondo squillo e la chiamata di un'esecuzione in ritardo (`routine_runs.reason = 'late'`) rispettano le ore di silenzio; tutte contano nel massimo al giorno. Prima del controllo della voce il ringer chiude le chiamate di routine non più possibili: `cancelled` senza nota se la routine non è più attiva o la chat è archiviata o cancellata, `expired` con una nota se aspettano da più di 10 minuti (voce non pronta, un'altra chiamata in corso). Senza risposta (`no-answer`), se la routine ha `retry_minutes` ed è attiva, nella stessa transazione nasce una seconda riga con `routine_attempt = 2` e `scheduled_at` fra quei minuti; «Rifiuta» non fa richiamare. Le note sono testi fissi L0. La risposta legge di nuovo le fonti (`routineCallScript` in `routines.ts`): il saluto ha i soli conteggi, i titoli fino a `voice_max_label` si dicono solo dopo un «sì» riconosciuto dal codice (`gateAnswer` in `voice/routine-call.ts`), e per tutta la chiamata il modello della chiamata legge solo i messaggi detti in quella chiamata (da quando l'utente risponde), mai i resoconti, le sintesi, le chiamate di prima né la chat. Senza nessuna pagina aperta né push la chiamata è persa subito, con il secondo squillo se la routine lo chiede; una chiamata in coda di una routine passata a «In chat», o un secondo squillo tolto, è `cancelled`. Una chiamata di routine che squillava a un riavvio del core resta `missed` con la nota della chiamata non risposta, senza secondo squillo; «Rifiuta» ha la sua nota e non fa richiamare; dopo il «no» il core chiude la chiamata. `routines_call_guard` fa nascere una proposta solo con `voice_max_label = L2` e `retry_minutes` NULL. `erase_conversation` cancella le chiamate prima delle esecuzioni, quindi la chiave esterna non la blocca.
- **Calendario delle routine (D-257, senza migrazione):** `GET /api/routines/calendar` legge `routines` e `routine_runs` (sola lettura, solo id). `POST /api/routines/:id/split` («Solo <giorno>» del calendario, `{day, to, at}`) in una transazione toglie `day` dalla routine (che deve averlo e non solo quello; non una proposta né con la chat archiviata), crea una conversazione privata «Routine · <titolo>» e una routine nuova con stesso titolo, fonti, sintesi, fuso e stato (attiva, o in pausa con `paused_by = 'user'`) solo nel giorno `to` all'ora `at`; eventi `routine.updated` (`fields: ['days']`), `conversation.created` e `routine.created` con `splitFrom` (l'id della prima) e `splitDays` (i giorni ceduti, soli numeri), mai il titolo. `POST /api/routines/:id/unsplit` (`{created}`, il suo «Annulla») blocca le due routine in ordine di id e la chat della prima (`FOR SHARE`), verifica sull'evento `routine.created` che `created` nasca dalla divisione di `id`, che dopo quell'evento non ci siano `routine.updated` della prima né eventi della nuova e che la nuova non abbia esecuzioni (altrimenti 409); poi ridà alla prima i giorni di `splitDays`, porta la nuova a `retired` (`routine.retired` con `by: 'unsplit'`) e ne archivia la conversazione (`conversation.archived`). In una modifica, una divisione o un annullamento `next_run_at` resta quando è già passato da al più 2 ore e appartiene ancora alla regola nuova (`dueOrNext`), altrimenti è la prossima esecuzione dopo adesso.
- **Notifica degli eventi:** un trigger fa `pg_notify('arianna_events:<schema>', id)` a ogni nuovo evento, consegnato al commit; chi ascolta legge l'evento dalla tabella. Il canale porta lo schema, così i test in schemi separati non si sentono fra loro.
- **Eventi dello Studio di design (D-184, nessuna migrazione):** `studio.edit` (una modifica diretta di un mockup dallo Studio: progetto, percorso, sha256 prima e dopo, byte scritti) `studio.export` (un'esportazione PPTX: progetto, percorso del mockup, numero di slide) e `studio.delete` (una variante eliminata dallo Studio e spostata in `eliminati/`: progetto, percorso, destinazione, sha256), con l'etichetta del progetto (al più L1); mai il testo del mockup né del deck. Contratto in `docs/STUDIO-API.md`.
- **Percorsi:** sempre relativi ad `ARIANNA_HOME`.
- **Ruoli (task 1.13, D-046):** il proprietario dello schema (`database.user`) applica solo le migrazioni; il core lavora come `arianna_app`, creato dalla migrazione `0007_app_role.sql`, che non possiede nulla, non crea oggetti né tabelle temporanee (`TEMPORARY` è revocato anche a `PUBLIC`), non altera tabelle né trigger e non ha `DELETE` né `TRUNCATE` su nessuna tabella (l'unica cancellazione che il core chiede passa da `purge_conversation`, `purge_incognito` ed `erase_conversation`, D-157). Sulle tabelle append-only (`events`, `gateway_log`, `label_changes`, `messages`, `router_decisions`, `task_turns`, `task_errors`, `conversation_summaries`, `task_activities`) ha solo `SELECT` e `INSERT`; su `tasks`, `jobs`, `runs`, `approvals`, `conversations`, `telegram_state`, `calls`, `push_subscriptions`, `model_evals` e `conversation_participants` anche `UPDATE`, sempre sotto i trigger di guardia; su `schema_migrations` solo `SELECT`. **Ogni tabella nuova, e la sequenza di un nuovo `bigserial`, va concessa nella sua migrazione:** i test con il database girano come `arianna_app` e `pnpm arianna:doctor` fallisce su una tabella che il ruolo non legge o una sequenza che non usa. Il ruolo riceve `LOGIN` e la password dal proprietario (`prepareDatabase`, in `pnpm db:migrate` e, con le password di sviluppo, a ogni `pnpm start`), che invia solo il verificatore SCRAM, mai la password.
- **Verifica della catena:** `verifyEventChain` (in `apps/core/src/events.ts`, eseguita anche da `pnpm arianna:doctor`) ricalcola gli hash di `events` e segnala la prima riga che non torna.
- **Limiti della catena, da chiudere più avanti:**
  - la cancellazione degli ultimi eventi non si vede dalla sola catena: serve un'ancora esterna, cioè l'ultimo hash salvato periodicamente fuori dal database (con `arianna export`, Fase 2);
  - il core lavora come `arianna_app`, che non può disattivare i trigger né modificare o cancellare eventi (D-046); il proprietario dello schema sì: chi ne ha la password può manomettere il registro, e la manomissione resta rilevabile ma non impedita. Le due password stanno nel vault;
  - le transazioni che scrivono eventi devono usare l'isolamento predefinito (READ COMMITTED). Con un altro livello la scrittura fallisce invece di biforcare la catena: lo impone il vincolo `events_single_successor`;
  - il lock della catena dura fino al commit: l'evento si scrive come ultima istruzione di una transazione breve.
- **«/progetta» e piani modificabili (D-235, migrazione `0072`):** il messaggio «/progetta …» crea un task della chat con `planning = 'request'` (mai insieme a `addressed`); il suo passo risponde senza modello e crea la card «Piano: …» con `planning = 'card'`: senza conversazione, assegnata ad `arianna`, figlia della richiesta (`tasks_planning_card_one`, una per richiesta: un passo ripetuto la ritrova), etichetta e clearance del messaggio. Il passo della card scrive l'approvazione `plan` della card; `approvals.conversationId` e `chatTaskId` la portano nella chat della richiesta, e lì la notifica (`conversationOfTask`). Finché l'approvazione è `pending` l'utente sostituisce le card del `detail` (`approvals_guard` lo ammette solo per `kind = 'plan'`, stato che resta `pending`, nient'altro cambia; l'etichetta resta quella del contesto). Ogni modifica alza `detail.revision`; la decisione porta la revisione che la chat mostrava e una diversa è rifiutata (409), così non parte nulla che l'utente non ha visto. Con la decisione il `detail` riceve `starts` (le righe «Avvia subito»), poi nascono le card, tutte `inbox`, con `plan_approval_id`, `complexity` e `done_criteria`; quelle di `starts` vanno `ready` con il passo in coda. La card «Piano» va in `done` nella stessa transazione, con l'approvazione come prova (`tasks_done_needs_evidence`) e l'esito nella nota. `tasks_planning_fields`, `tasks_complexity_only_cards` e `tasks_plan_approval_only_cards` tengono le colonne al loro posto. La card «Piano» ha il testo dell'utente ma nessuna conversazione: `purge_conversation` ed `erase_conversation`, riscritte nella `0072`, la prendono con i task della conversazione della sua richiesta («Elimina» la chiude e la svuota con il suo piano, «Elimina per sempre» la cancella con il piano), e `approvals_guard` lascia che la purga svuoti il suo piano; le card nate dal piano restano, come da D-159. Nessun permesso nuovo.
- **Test con il database:** `pnpm test:db` crea uno schema usa e getta per ogni file di test e applica le migrazioni da zero (D-029).
- **Ricerca (Fase 2):** Qdrant fuori da Postgres; indice testuale con `tsvector` o BM25 dedicato. Alternativa da valutare: `pgvector` al posto di Qdrant per avere un servizio in meno (`OPEN-QUESTIONS.md`).
