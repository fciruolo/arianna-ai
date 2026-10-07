# I-4, modalità incognita: proposta di progetto

Stato: **decisa come D-136** (2026-10-07) e **implementata** sul ramo `task/i4-incognito` nella notte del 2026-10-07, da provare (esiti delle tappe in fondo). Prima: proposta di Claude (idea I-4 di `docs/PROPOSTE.md`, "Idee dell'utente del 2026-10-05 sera"; risposta dell'utente: "come una chat normale", stessi strumenti e agenti, ma niente salvato in Arianna).

## In una frase

Una conversazione incognita funziona come le altre (privata o di lavoro, con KB, agenti e Coder), ma ha un **segno che non cambia** dalla nascita: non compare in lista, ricerca, ufficio e pannelli; non scrive nulla di permanente fuori dal database; e **alla chiusura**, o al riavvio del core se è caduto, i suoi testi si cancellano con `purge_conversation`. Ciò che non può sparire (file cambiati dal Coder, ciò che il fornitore cloud ha ricevuto, lo scheletro dell'audit) è elencato in una scheda **"Cosa resta fuori da Arianna"**, mostrata all'apertura e di nuovo alla chiusura con i dati veri di quella conversazione.

## Inventario delle tracce di oggi

Per ogni traccia lasciata oggi da una conversazione: dove sta, cosa contiene, e cosa le succede in incognito. Colonna "Esito": **evitata** (non si scrive), **cancellata** (si scrive e sparisce alla chiusura), **resta** (per forza o per scelta, sempre senza contenuto salvo dove detto).

### Database (PostgreSQL in `data/postgres`)

| Traccia | Contenuto | Esito in incognito |
| --- | --- | --- |
| `conversations` | modo, clearance, progetto, modello, **titolo** (dal primo messaggio, D-057) | Titolo **evitato**: resta `NULL`, la chat mostra "Incognito". Dopo la chiusura la riga resta come scheletro `purged_at` (serve alle chiavi esterne di task, run, chiamate), con il segno `incognito` |
| `messages` | **testi** di utente, Arianna, Coder, agenti, righe di sistema | **Cancellata** (`purge_conversation`) |
| `tasks` | **titolo** = inizio del messaggio dell'utente (`taskTitle` in `writeUserMessage`), obiettivo, prove (solo riferimenti), etichette, stato | Titolo **evitato**: testo fisso "Incognito" dalla nascita, così non è mai su disco (oggi resta fino al purge). Obiettivo e criterio di fine azzerati dal purge come oggi; **restano** stato `failed`/`done`, etichette, prove con soli id |
| `task_turns` | risposta del modello, **ragionamento** (D-051), risultato degli strumenti (anche pagine KB lette) | **Cancellata** |
| `task_delegations` | **brief**, **rapporto** dell'agente, file cambiati (D-082), commit di base, `session_ref` | **Cancellata**; prima della cancellazione l'elenco dei file cambiati va nella scheda di chiusura (in memoria della pagina, mai salvato) |
| `conversation_summaries` (D-077) | **riassunti** della storia | **Cancellata** (scritti come oggi oltre 30 messaggi o 24.000 caratteri) |
| `task_activities` (D-083) | righe di attività (≤ 300 caratteri, **testo**: "legge kb/…", "scrive src/…") | **Cancellata** |
| `conversation_participants` (D-125, sul suo ramo, migrazione `0026`) | id della conversazione e dell'agente | **Cancellata**: il purge va esteso a questa tabella quando D-125 entra in `main` (vale anche fuori dall'incognito) |
| `approvals` | `detail`: **testo** di un declassamento, file di un'approvazione `workspace`, azioni | `detail` svuotato dal purge, le pendenti scadono; la riga **resta** (tipo, azione, stato, ora) |
| `label_changes` | sha256 del testo declassato, etichette | **Resta** (append-only, è l'audit di un declassamento): l'hash di un testo breve si può indovinare per tentativi, ma il testo non c'è |
| `runs` | esecutore, modello, località, `session_ref`, cartella, token, durata | **Resta**; proposta: il purge in incognito azzera anche `session_ref` e `workspace` (sono `UPDATE` già concessi ad `arianna_app`) |
| `gateway_log` | destinazione, etichetta, regola, byte, sha256 del payload, `summary` | **Resta**: il `summary` passato oggi è un testo del codice con il solo nome dell'agente (`delegated step for <agente>`, `delegate.ts`), mai contenuto; lo sha256 come sopra |
| `router_decisions` | etichetta, difficoltà, candidati, motivo (etichette e regole) | **Resta**, senza contenuto |
| `jobs` | chiave `task:<id>`, tentativi, `last_error` (codice) | **Resta**; `last_error` già azzerato dal purge |
| `task_errors` (D-064) | origine, codice, dettagli scalari | **Resta**, senza testo |
| `events` (catena di hash) | tipo, id, etichetta; payload L0 con id (`conversationId`, `messageId`), mai il testo (regola 12, titolo mai negli eventi) | **Resta**: append-only con catena, non si tocca (rompere la catena è peggio di una traccia senza contenuto). Più due eventi nuovi L0 `conversation.incognito-closed` (con causa: utente, inattività, riavvio) e il `conversation.purged` di oggi |
| `calls` (D-066) | direzione, stato, orari, numero di deleghe | **Resta** se la voce è ammessa (domanda 3); le parole della chiamata sono in `messages`, quindi cancellate |
| `push_subscriptions`, `telegram_state`, `model_evals` | non legati alla conversazione | Nessun effetto |
| Log di PostgreSQL (stderr del container, `docker logs`) | errori e istruzioni fallite (`STATEMENT`), senza i valori dei parametri (`log_parameter_max_length_on_error` vale 0) | **Resta**, senza testo; da tenere così (nessun `log_statement` né parametri nei log) |

**Cosa resta su disco dopo il purge (fino a VACUUM e oltre).** `purge_conversation` cancella in modo logico: le tuple tolte restano nelle pagine delle tabelle e dei loro indici (e nelle tabelle TOAST per i testi lunghi) finché l'autovacuum non le marca riutilizzabili e un'altra scrittura non le copre; i segmenti del WAL (`data/postgres/pg_wal`) contengono gli `INSERT` finché non vengono riciclati dopo qualche checkpoint; la coda di `pg_notify` (frammenti della risposta in streaming e diff dal vivo del Coder, D-039 e D-117) passa per i file SLRU di `pg_notify/`. Nulla di questo è leggibile da Arianna, dalla chat o da un agente; lo è da chi ha accesso ai file del database con strumenti di analisi forense. Il `VACUUM` dopo il purge accorcia la finestra ma non azzera i byte, e `arianna_app` non può lanciarlo oggi (D-046; PostgreSQL 17 lo permetterebbe con `GRANT MAINTAIN`). La difesa vera per il disco è la cifratura del disco (FileVault, `docs/SPEC.md` "Backup e disco"); la cancellazione crittografica è l'opzione più forte (domanda 2). I backup di `arianna export` (Fase 2) e un eventuale Time Machine sulla cartella `data/` copierebbero le righe se scattano mentre la conversazione è aperta.

**Perché non "solo in memoria", UNLOGGED o TEMP.**
- **Solo in memoria del core:** il motore dei task vive nel database (job con `FOR UPDATE SKIP LOCKED`, run, approvazioni, `gateway_log` scritto prima di ogni uscita, trigger di guardia come `runs` "cloud solo fino a L1", `task_delegations_guard`, etichette solo verso l'alto). Un motore parallelo in memoria dovrebbe rifare tutte queste difese nel codice, cioè togliere la difesa in profondità del database proprio nella conversazione più delicata, e "stessi strumenti e agenti" vorrebbe dire duplicare orchestratore, deleghe e approvazioni. Stima 40-60 ore e un rischio di privacy maggiore. Scartata.
- **Tabelle UNLOGGED:** niente WAL, ma i file delle tabelle sono comunque su disco e vengono svuotati solo dopo un crollo, non a un riavvio pulito; una tabella normale non può avere una chiave esterna verso una UNLOGGED, quindi servirebbero copie gemelle di `messages`, `task_turns`, `task_delegations`, `conversation_summaries`, `task_activities` con tutti i trigger duplicati. Guadagno piccolo (solo il WAL), costo alto. Scartata.
- **Tabelle TEMP:** `TEMPORARY` è revocato ad `arianna_app` (migrazione `0007`, D-046) e una tabella temporanea vive per connessione, mentre il core usa un pool. Scartata.

### File in `data/` e nella cartella di Arianna

| Traccia | Contenuto | Esito |
| --- | --- | --- |
| Log del core (stdout di `pnpm start`) | solo codici e nomi di errore (`main.ts`), mai testi | Nessun effetto |
| `data/<id>.log` di oMLX (D-071) | il log del server del modello locale **può contenere i prompt** (D-071 lo dice, per questo resta solo nella chat web) | **Resta** se oMLX scrive i prompt: non si controlla per singola richiesta. Proposta (tappa 0): verificare il livello di log di oMLX e, se scrive i prompt, abbassarlo per tutti con il `command` del suo `[[local.endpoints]]` |
| Cache di oMLX su disco (`--paged-ssd-cache-dir`, solo se configurata) | blocchi KV del prompt (numeri, non testo, ma derivati dal testo) | **Resta** fino allo sfratto; la scheda lo dice solo se la cache è accesa |
| `kb/inbox/` | note da `kb.write` (Arianna, A1), "Salva in inbox" (D-089), `/nota` (D-080) | **Evitata**: in incognito questi tre si spengono (domanda 3) |
| `kb/` (pagine) | lette con `kb.read`/`kb.search` | Lettura ammessa, nessuna traccia (le pagine c'erano già) |
| Carte create con `task.create` (figlie senza conversazione) | titolo e obiettivo scritti da Arianna | Sopravvivono al purge per disegno (D-057): **evitate**, `task.create` e `task.update` spenti in incognito (domanda 3) |
| `data/worktrees/<run>` | cartella vuota della chat di sistema o copie degli eval | Non usata da una conversazione incognita |
| `data/voice/` (copie di voce, D-066) | solo per il provino | Nessun effetto; `apps/voice` non salva audio e logga solo codici |
| Memoria a lungo termine | oggi non esiste una memoria separata dalla KB | Una memoria futura (Fase 2) dovrà escludere le conversazioni incognite: regola da scrivere nella decisione |

### Fuori da Arianna

| Traccia | Contenuto | Esito |
| --- | --- | --- |
| **Sessioni di `claude`** nella cartella `projects` del profilo dell'utente (D-049: `HOME` ereditata, nessun `--no-session-persistence`); il binario scrive anche altrove nel profilo (`file-history` con copie dei file modificati, `todos`, `shell-snapshots`, `debug`, il file `.claude.json` della home) | la sessione completa del Coder: brief, file letti, risposte; copie dei file toccati | **Evitata per `projects`, da verificare per il resto** (tappa 0): il binario installato (2.1.292 il 2026-10-07) ha `--no-session-persistence` ("sessions will not be saved to disk and cannot be resumed", solo con `--print`, che usiamo). Per i run di una conversazione incognita `packages/executors` lo aggiunge; prezzo: un run interrotto da un riavvio non si riprende con `--resume` e riparte da zero o fallisce. Se le altre cartelle del profilo restano scritte anche con il flag, la scheda le nomina come traccia che resta. Cambio a `packages/executors`: test di contratto e `pnpm eval:live` (un caso: elenco completo dei file del profilo, la cartella `.claude` della home e il file `.claude.json` della home, uguale prima e dopo il run, salvo ciò che la tappa 0 avrà dichiarato inevitabile) |
| **Fornitore cloud** (Anthropic per Claude, OpenAI per Codex quando arriverà il 1.16) | ciò che il gateway ha fatto uscire: brief L0/L1 e file del progetto letti dal Coder | **Resta**, secondo le condizioni dell'abbonamento dell'utente; Arianna non può cancellarlo né saperne la durata. Vale solo per le incognite di lavoro: un'incognita privata non esce mai (L2, gateway invariato) |
| **File cambiati dal Coder** nel progetto approvato (D-056: lavora nella cartella vera) | il lavoro fatto | **Resta** per forza: è il risultato chiesto. La scheda di chiusura li elenca (da `task_delegations.files`, prima del purge) con un invito a guardare `git status` |
| `.git` del progetto | il Coder può scriverci (rischio accettato da D-056) | **Resta**: commit, rami o stash fatti dal Coder restano nella storia del progetto |
| Telegram (spento, D-110) | avvisi da `approval.requested` e `message.created` | **Evitata**: il canale salta gli eventi di una conversazione incognita (anche se torna acceso) |
| Notifiche push (D-066, futuro I-1) | testo fisso, nessun contenuto | Chiamate in uscita per un task incognito **evitate** (niente `task-done`/`waiting` che squillano); la notifica di I-1 senza testo è innocua ma va comunque saltata, perché dice che è successo qualcosa |
| Browser | stato in memoria della pagina; `localStorage` solo per disposizione e id di approvazioni chiuse; risposte API `no-store` | La pagina resta su un indirizzo fisso (`/incognito`), senza l'id della conversazione: anche `replaceState` finirebbe nella cronologia; non salva bozze; dopo la chiusura scarta ciò che ha in memoria |

## Disegno proposto

### 1. Dove vive la conversazione

Nelle **tabelle di oggi**, con il motore di oggi, e un segno nuovo `conversations.incognito boolean NOT NULL DEFAULT false` (migrazione `0031`). Vincoli nel database: si sceglie alla creazione e non cambia (`conversations_guard`); vietato con `origin = 'system'` (una chat di sistema su un task incognito non si apre: l'errore si vede nella conversazione stessa); vietato per la conversazione di Telegram; vietate archiviazione e fissatura (`incognito → archived_at IS NULL AND pinned_at IS NULL`, salvo l'archiviazione fatta dal purge stesso), così un'incognita non finisce mai nell'elenco dell'archivio. Titolo della conversazione sempre `NULL` (vincolo), titolo dei task di quella conversazione sempre il testo fisso (vincolo o trigger).

È la scelta che dà "stessi strumenti e agenti" senza duplicare nulla: orchestratore, gateway, router, deleghe e approvazioni non sanno nulla dell'incognito, salvo i punti elencati al punto 4. Il prezzo è che il testo tocca il disco del database finché la conversazione è aperta (vedi "Cosa resta su disco"); per chi vuole di più c'è la cifratura con chiave in memoria (domanda 2).

### 2. Quando si chiude

- **Pulsante "Termina"** nell'intestazione: chiede conferma con la scheda di chiusura, poi chiude.
- **Inattività:** nessuna pagina collegata alla conversazione per 10 minuti (il WebSocket della chat dice chi la guarda; una ricarica entro la soglia non perde nulla) → chiusura automatica (domanda 4).
- **Riavvio del core:** all'avvio, **prima della ripresa dei run interrotti e prima che partano i worker**, ogni conversazione incognita non cancellata si chiude: i suoi job attivi diventano `failed` (codice `incognito`), i run `running` o `interrupted` si chiudono senza ripresa, poi il purge. Così un crollo non lascia una incognita "appesa".
- **Lavoro in corso alla chiusura:** il motore ha già un segnale di arresto per passo (`stop` di `processStepJob` in `engine.ts`, che porta a `interruptRun` e allo stato `interrupted`, e arriva all'adattatore di `claude`: gruppo di processi, SIGTERM poi SIGKILL); manca la strada per usarlo su un task scelto (rotta HTTP e registro dei passi in corso nel worker) e una causa nuova (`incognito`) che non rimetta il passo in coda. La chiusura ferma così il lavoro, aspetta che il run finisca (pochi secondi) e poi cancella. Il Coder fermato a metà lascia i file come li ha lasciati: la scheda lo dice.
- **Il purge:** una variante `purge_incognito(uuid)` (stessa logica di `purge_conversation`, `SECURITY DEFINER`, solo `arianna_app`) che accetta una conversazione **non archiviata** purché incognita, dopo che il core ha chiuso job e run; in più azzera `runs.session_ref` e `runs.workspace` e cancella `conversation_participants`. Restano lo scheletro e l'audit come per ogni cancellazione definitiva.

### 3. Cosa vede l'utente

- **Apertura:** "+ Nuovo" → "Incognito", poi la scelta di sempre fra privata e di lavoro (con progetto). Una scheda "Cosa resta fuori da Arianna" da leggere prima del primo messaggio, con un testo diverso per modo:
  - privata: "Niente esce dal Mac. Alla chiusura Arianna cancella testi, riassunti e attività. Restano: l'ora e il numero dei passi nel registro di sicurezza, senza testo; nel database i byte cancellati restano illeggibili ad Arianna finché non vengono sovrascritti (il disco cifrato li protegge)."
  - di lavoro: in più "Ciò che il Coder riceve va a Claude (Anthropic) e resta presso di loro secondo il tuo abbonamento. I file che il Coder cambia nel progetto *nome* restano. Claude Code non salva la sessione."
- **Durante:** intestazione scura con l'icona della maschera e la scritta "Incognito"; la conversazione non compare in lista, in "Cerca" (D-089, oggi cerca i testi dei messaggi), nell'ufficio (D-106), nell'archivio, nel pannello di stato né in "Decisioni in attesa" fuori dalla sua pagina; le approvazioni si decidono dentro la conversazione stessa. Pulsanti spenti con la ragione al passaggio del mouse: "Salva in inbox", `/nota` (domanda 3). "Copia" resta.
- **Chiusura:** la stessa scheda con i dati veri: "Cancellati: 14 messaggi, 3 passi, 1 riassunto. Restano fuori: 2 file cambiati in *sito-demo* (`index.html`, `style.css`); 1 invio a Claude Opus (3,2 kB)". Poi la pagina torna alla lista; un clic indietro trova "Questa conversazione incognita è chiusa".
- **Riavvio:** se il core è ripartito, la pagina rimasta aperta mostra "Conversazione incognita chiusa al riavvio di Arianna", senza i testi (che scarta).

### 4. Cosa cambia nel codice (solo i punti toccati)

- `apps/core`: creazione (`createConversation` con `incognito`), titoli fissi, esclusioni (`GET /api/conversations`, ricerca, stato, ufficio, attese), canale Telegram e chiamate in uscita che saltano le incognite, strumenti `kb.write`, `task.create`, `task.update` tolti dall'elenco offerto al modello quando la conversazione è incognita (`LOCAL_TOOLS` filtrato per passo, con `task.offer` come oggi), rotte "Salva in inbox" e cattura rifiutate (409), chiusura (rotta, inattività, avvio), arresto del job.
- `packages/executors`: opzione `persistSession: false` → `--no-session-persistence`, controllata dal profilo e dal test di contratto; la ripresa con `--resume` è rifiutata quando la sessione non è stata salvata.
- `packages/policy`: **nessuna regola nuova.** L'incognito non tocca etichette né uscite.
- `apps/hud`: voce "Incognito", schede di apertura e chiusura, intestazione, cronologia sostituita, scarto alla chiusura.

### 5. Etichette, default-deny e audit

- **L'incognito non abbassa nulla.** Un'incognita privata ha clearance L2 e non esce mai; un'incognita di lavoro ha clearance L1 e progetto approvato, scanner al salvataggio e gateway all'uscita come oggi. "Dati non etichettati = L2" vale invariato: il segno incognito dice quanto a lungo si tiene un dato, non quanto è riservato. Un declassamento in incognito chiede l'approvazione di sempre e lascia la sua riga in `label_changes`.
- **Il registro di sicurezza non si spegne.** Ogni uscita ha la sua riga in `gateway_log` scritta prima dell'invio (se la riga non si scrive, non esce nulla), ogni scelta del router la sua in `router_decisions`, ogni cambio di stato il suo evento nella catena. Restano dopo la chiusura perché senza contenuto (regola 12, `summary` scritto dal codice con il solo nome dell'agente) e perché dicono *se* e *verso chi* qualcosa è uscito: è proprio ciò che la scheda di chiusura mostra. La catena di `events` non si tocca mai.
- **Cosa si può ricostruire dopo:** che alle 22:10 c'è stata un'incognita di lavoro sul progetto *sito-demo*, con 5 messaggi, una delega a Claude Opus di 3,2 kB e la sua durata. Non cosa si è detto. Se anche il nome del progetto è troppo, l'evento di creazione può portare solo il modo (oggi porta `mode`, il progetto sta in `conversations.workspace`): resta nella riga scheletro, che serve alle approvazioni `workspace`.

## Piano a tappe

| Tappa | Contenuto | Stima |
| --- | --- | --- |
| 0 | Verifiche senza codice dell'app: livello di log di oMLX (prompt sì o no in `data/<id>.log`) e comportamento di `--no-session-persistence` su un run vero minimo (elenco completo dei file del profilo prima e dopo: `projects`, `file-history`, `todos`, `shell-snapshots`, `debug`, il file `.claude.json` della home). Una riga nel documento con l'esito | 1 h |
| 1 | Migrazione: `conversations.incognito` immutabile con i vincoli, titoli fissi, `purge_incognito(uuid)` (job e run chiusi dal core prima; `session_ref`/`workspace` azzerati), concessioni; `test:db` con un **canarino**: una stringa unica scritta in un messaggio, un turno, una delega, un riassunto e una riga di attività di un'incognita; dopo la chiusura nessuna colonna di testo o jsonb dello schema la contiene | 3-4 h |
| 2 | Core: creazione, esclusioni da lista, archivio, ricerca, ufficio, stato, Telegram, chiamate; strumenti di scrittura spenti; rotte di salvataggio rifiutate; chiusura da pulsante, inattività e avvio (prima della ripresa dei run); arresto del lavoro in corso col segnale `stop` del motore | 4-5 h |
| 3 | `packages/executors`: `--no-session-persistence` per le incognite, test di contratto ed eval dal vivo (un caso, quota minima) | 1-2 h |
| 4 | Chat: voce "Incognito", schede di apertura e chiusura con i dati veri, intestazione, cronologia, scarto | 3-4 h |
| 5 | Documenti: sezione in `docs/PRIVACY-POLICY-SPEC.md` ("Conversazioni incognite", con la tabella "cosa resta"), `docs/DATA-MODEL.md`, decisione in `DECISIONS.md`, changelog | 1 h |
| | **Totale** | **13-17 h** |

Con la cancellazione crittografica (domanda 2, opzione "Cifratura") si aggiungono 10-14 ore: chiave AES-256-GCM per conversazione tenuta solo nella memoria del core, testi cifrati in `messages.body`, `task_turns`, `task_delegations.brief`/`result`, `conversation_summaries.body`, `task_activities.detail` e `approvals.detail`; da rivedere il controllo del database sullo sha256 dei declassamenti (oggi ricalcola l'hash del testo in chiaro) e ogni lettura di quei campi. Al riavvio la chiave è persa e i byte su disco, WAL compreso, sono illeggibili subito.

La stima di PROPOSTE (8-12 ore) non contava la rotta per fermare un task scelto (il segnale nel motore c'è, la strada per usarlo no), la chiusura all'avvio né le sessioni di `claude`.

## Rischi e limiti

- **Falsa sicurezza.** "Incognito" nei browser non protegge dal fornitore né dal disco; qui vale lo stesso. La scheda lo scrive in chiaro, con i dati della conversazione, ed è il cuore della funzione.
- **Lavoro perso per sbaglio.** Una scheda chiusa per errore e lasciata oltre la soglia cancella tutto. Mitigazione: soglia di 10 minuti e avviso "chiusura fra 1 minuto" se la pagina torna in tempo; nessun modo di recuperare dopo, per disegno.
- **Coder interrotto a metà.** I file restano in uno stato intermedio. La scheda di chiusura lo dice e li elenca.
- **Un riavvio a metà di una delega** non riprende il run (sessione non salvata): l'incognita si chiude comunque al riavvio, quindi non è una perdita in più.
- **Byte nel database fino alla sovrascrittura**, se non si sceglie la cifratura: protetti dalla cifratura del disco, non da Arianna.

## Scelte dell'utente (2026-10-05, sera)

Tutte e quattro sulle opzioni consigliate: incognito come una chat normale (privata o di lavoro; nel modo di lavoro il Coder su Claude, con la scheda che dice cosa resta presso il fornitore; sessioni di Claude Code non salvate); cancellazione alla chiusura senza cifratura (aggiungibile dopo); strumenti che salvano spenti (`kb.write`, `task.create`, "Salva in inbox", /nota; "Copia" resta); chiusura con "Termina", dopo 10 minuti senza pagina aperta o al riavvio, fermando il lavoro in corso e elencando i file già cambiati.

## Contratto API fra core e chat (fissato il 2026-10-07 per le tappe 2 e 4)

Le tappe 2 (core) e 4 (chat) si fanno in parallelo su questo contratto; un cambio va scritto qui.

- **Creazione:** `POST /api/conversations` accetta `incognito: true` insieme a `mode` (`private` o `work`) e, per `work`, al progetto come oggi. Rifiutato (400) con `origin` di sistema o con un agente diretto, se il core non lo supporta (scriverlo qui).
- **Forma:** ogni conversazione restituita dal core ha `incognito: boolean`. Per un'incognita `title` è sempre `null`.
- **Esclusioni:** `GET /api/conversations` (lista e archivio), `GET /api/search`, stato e ufficio, attese di altre pagine non mostrano mai un'incognita. `GET /api/conversations/:id` e i messaggi della conversazione funzionano (la pagina tiene l'id in memoria).
- **Salvataggi spenti:** `POST /api/capture` con un `messageId` di un'incognita, `POST /api/conversations/:id/save` e `/nota` da un'incognita rispondono **409** `{ "error": "incognito" }`. `GET /api/conversations/:id/saved` risponde come per una conversazione senza salvataggi.
- **Chiusura:** `POST /api/conversations/:id/end` (solo incognite, altrimenti 409 `{ "error": "not incognito" }`; 404 se non c'è o è già cancellata) ferma il lavoro in corso, cancella e risponde 200 con:
  `{ "deleted": { "messages": n, "tasks": n, "summaries": n }, "remains": { "files": [{ "project": "nome", "path": "src/x.ts" }], "cloud": [{ "model": "opus", "bytes": n }] } }`
  (`files` da `task_delegations.files` letti prima del purge; `cloud` dalle righe di `gateway_log`/`runs` di quella conversazione, solo modello e byte).
- **Scheda di apertura:** `GET /api/incognito/notice?mode=private|work&project=nome` → `{ "cloud": boolean, "project": string | null }` (la chat compone i testi; nessun dato oltre a questi).
- **Avviso di chiusura:** sul WebSocket della chat un messaggio `{ "type": "conversation.incognito-closed", "conversationId": "…", "cause": "user" | "idle" | "restart" }`; dopo, `GET /api/conversations/:id` risponde 404.
- **Presenza:** la pagina aperta su un'incognita lo dice al core con il messaggio di visibilità già usato dalle notifiche (`conversation` nel messaggio, D-128); 10 minuti senza nessuna pagina su quella conversazione → chiusura con causa `idle`. A 9 minuti il core manda `{ "type": "conversation.incognito-closing", "conversationId": "…", "inSeconds": 60 }`.
- **Indirizzo:** la chat apre un'incognita su `/incognito`, mai con l'id nell'indirizzo.

## Esito della tappa 0 (2026-10-07, notte)

- **Log di oMLX:** al livello predefinito `info` il file `data/omlx.log` non contiene testi: per ogni richiesta solo modello, token, tempi, `finish_reason` (controllato su 571 righe "Chat completion" e cercando frasi note di una conversazione: assenti). Il livello `trace` invece "includes full message content" (`omlx serve --help`). Da fare: il wizard (`pnpm arianna:init`) scrive `--log-level info` esplicito nel `command` dell'endpoint, così un default cambiato da oMLX non porta i prompt nel log; il doctor rifiuta `trace` e `debug`.
- **Cache di oMLX su disco:** nella configurazione di sviluppo è accesa (`--paged-ssd-cache-dir data/omlx-cache`, 10 GB): contiene blocchi KV derivati dai prompt, non testo. La scheda dell'incognito la nomina quando il `command` contiene `--paged-ssd-cache-dir`.
- **Profilo di `claude` con `--no-session-persistence`:** non verificato stanotte (serve un run vero e la lettura della cartella `.claude` nella home dell'utente, fuori dal repository: la fa l'utente, o un `pnpm eval:live` con il caso descritto in tappa 3).

## Esito della tappa 3 (2026-10-07, notte)

- `packages/executors`: `persistSession: false` aggiunge `--no-session-persistence` (con `-p`, sempre presente); la ripresa di una sessione non salvata è rifiutata con `invalid-options` prima del gateway, senza spendere il brief. Nel core (`claude-step.ts`, `delegate.ts`) l'id di una sessione non salvata non va in `runs.session_ref` né in `task_delegations.session_ref`; una chat diretta incognita manda gli scambi recenti nel brief (il ripiego di D-111b) invece di riprendere la sessione.
- **Da fare dal vivo:** un caso in `evals/contract/claude.jsonl` (`persistSession` in `ContractStep` di `packages/evals/src/contract.ts`) che confronta l'elenco dei file del profilo di `claude` nella home dell'utente prima e dopo un run con il flag. Leggere la home dell'utente è fuori dalle regole del repository per Claude Code: il caso lo scrive e lo lancia l'utente, o lo autorizza esplicitamente.
- Le chat dirette incognite sono vietate dal database (`agent IS NULL`): il ramo pensato per loro in `delegate.ts` è stato tolto.

### Aggiunte al contratto (2026-10-07, notte, dai dubbi della tappa 4)

- **Attese:** `GET /api/approvals` (e le attese sul WebSocket) includono quelle delle incognite con `incognito: true` e `conversationId`; la chat le mostra solo nella pagina della loro conversazione, mai in "Decisioni in attesa" altrove. Nessun altro canale le annuncia.
- **Notifiche:** per un'incognita il core non manda nulla sullo stream delle notifiche (aiutante del Mac), né Web Push, né avvisi nella chat con un collegamento `/c/<id>` (finirebbe nella cronologia).
- **Dopo la chiusura:** `GET /api/conversations/:id` di un'incognita cancellata risponde 404 con `{ "error": "not found", "closed": "user" | "idle" | "restart" }`, così la pagina dice la causa esatta; ogni altro 404 resta com'è.
- **Dal core della tappa 2:** `POST /api/capture` accetta `conversationId` (409 `incognito` per un'incognita: così `/nota` è rifiutato anche dal core); `GET /api/approvals?conversation=<id>` dà le attese di una conversazione; `POST /end` vuole il corpo `{}` e risponde 409 se il lavoro non si ferma in tempo (la chat ritenta); la presenza conta `conversation` nel messaggio di visibilità anche con la pagina nascosta e va rimandata a ogni riconnessione; `GET /api/incognito/notice` dà `cloud` vero solo con `mode=work` e un modello cloud selezionabile, 400 per un progetto con `mode=private` o non approvato.

## Esito delle tappe 1 e 2 (2026-10-07, notte)

- **Database (`0031_incognito.sql`):** segno immutabile; un'incognita è aperta dall'utente, senza agente diretto, senza titolo, mai archiviata né fissata (vincolo), e la sua cancellazione non passa dall'archivio; trigger contro una chat di sistema su un suo task, contro Telegram legato a lei, e contro un titolo di task diverso da "Incognito"; `purge_incognito` rifiuta se un task, un run o un job è ancora al lavoro e restituisce i conteggi per la scheda. Test del canarino (`apps/core/test-db/incognito-schema.test.ts` e `incognito.test.ts`): dopo la chiusura nessuna colonna di testo, json o array di testo dello schema contiene la stringa.
- **Limiti e scelte del core:** nessuna chat diretta incognita (`agent IS NULL`); la causa `incognito` di un job resta solo negli eventi (il purge azzera `last_error`); `remains.cloud` ha una voce per ogni uscita ammessa verso il cloud, col modello del run; un'incognita resta aperta finché almeno una pagina la dichiara aperta, anche nascosta; stato e ufficio mostrano inattivo un agente che lavora su un'incognita; un passo che ignora `stop` oltre 15 secondi viene chiuso d'ufficio e le sue scritture successive sono rifiutate dai trigger.
- **Dubbio per l'utente** (in `docs/OPEN-QUESTIONS.md`): un'incognita con una pagina aperta e nascosta resta aperta senza limite; serve un tetto? **Chiamate:** dopo la revisione, in un'incognita sono rifiutate (409 `incognito`: nessuna chiamata in entrata, programmata o "a lavoro finito"), e la chiusura annulla quelle rimaste.

### Dalla revisione complessiva (2026-10-07, notte)

- `GET /api/incognito/notice` dà anche `localCache` (vero quando oMLX ha la cache su SSD): la scheda la nomina.
- Il 409 di `POST /end` con il lavoro ancora in corso ha il codice stabile `{ "error": "busy" }`.
- Le chiamate legate a un'incognita rispondono 409 `{ "error": "incognito" }`.
- La chiusura prende tutti i lock prima di scrivere il primo evento (`lock_incognito`, migrazione `0033`): un evento tiene il lock della catena fino al commit, e una chiusura in attesa di un lock fermava per 5 s ogni altro evento (trovato dai test con il database in serie completa).
- `task_delegations` rifiuta le scritture per un task di una conversazione cancellata (migrazione `0032`): un passo tardivo non lascia un brief dopo la chiusura.
- **Eval dal vivo in sospeso:** il caso del profilo di `claude` non è scritto (serve leggere la home dell'utente); finché non c'è, la scheda dice che gli altri file del profilo non sono verificati.
- **Limiti rimasti dopo la seconda revisione:** la chiusura chiude una chiamata viva solo nel database (la sessione della voce, se esistesse, continuerebbe, ma le sue scritture sono rifiutate dai trigger); "Termina" può attendere due timeout di lock in fila (circa 10 secondi) prima del 409 `busy`, che la chat ritenta; il test delle prove dei modelli (`model-evals.test.ts`) e quello del ringer sono sensibili ai tempi quando tutti i test con il database girano insieme, e passano da soli.
