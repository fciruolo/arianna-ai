# Decisioni aperte e idee da scegliere

## Decisioni aperte

| Decisione | Proposta | Entro |
| --- | --- | --- |
| ~~Linguaggio del nucleo~~ | **Deciso: TypeScript** (D-003) | |
| Conferma delle decisioni "Proposta, applicata" (D-004, D-013…D-021, D-024) | Rileggerle in `DECISIONS.md` e confermarle o rifiutarle; insieme le altre decisioni di base ancora "Proposta, applicata" (D-025…D-029) e D-030 (cartella di sviluppo separata da quella dei dati veri, proposta da applicare a fine Fase 1A) | Task 0.6 |
| ~~Dove gira il server~~ | **Deciso: Mac Studio** (chiarito dall'utente il 2026-10-02: è la macchina di lavoro dove andrà l'installazione con i dati veri; `HANDOFF.md`, "Dove siamo"), dietro interfaccia sostituibile | |
| Conteggio di `claude -p` e `codex exec` negli abbonamenti | `claude -p` (task 1.5, D-049): con il login dell'abbonamento (`apiKeySource: none`) ogni run riporta un `rate_limit_event` con le finestre `five_hour` e `seven_day` dell'abbonamento; non è verificato se esista un credito separato. Da guardare nel tuo account dopo qualche run. `codex exec` (task 1.16, D-138): con il login ChatGPT i run contano nella quota di ChatGPT (2026-10-07: circa 60 run della sessione, fra prove ed eval, hanno portato Codex al 14% secondo la barra dell'utente); lo stream non porta finestre di quota né crediti, quindi la barra resta l'unica misura | Quando vuoi: Codex lavora già nelle deleghe dalla 0.29.0 (D-140) |
| ~~Nomi esatti dei flag di confinamento (`--strict-mcp-config`, sorgenti delle impostazioni, sandbox)~~ | **Deciso:** fissati per `claude` 2.1.288, sandbox compresa (D-049, D-050, `packages/executors/src/claude/profile.ts`), e per `codex` 0.160.0 (D-138, `packages/executors/src/codex/profile.ts`), con i test di contratto e del canarino | |
| ~~Sandbox: nativa di Claude Code oppure `sandbox-runtime`~~ | **Decisa la nativa** (D-050, confermata): il canarino non esce. microVM solo se un giorno esce | |
| ~~oMLX può puntare a `data/models/`?~~ | **Deciso: sì** (D-048, D-071): il core avvia `omlx serve --model-dir data/models` dal 2026-10-04 | |
| oMLX invia telemetria o contenuti fuori dalla macchina? | Il README non ne parla: verificare (codice o traffico di rete) prima di dargli dati L2 veri; non usare `--mcp-config` né `--hf-endpoint` con dati veri. Lasciare `--host 127.0.0.1` | Prima dell'uso con dati veri (fine Fase 1A) |
| Codex con provider locale invia telemetria o contenuti altrove? | Finché non è verificato non conta come locale: oggi Codex lavora solo come esecutore cloud (D-138, D-140) | Prima di usare Codex con un modello locale |
| Codice clienti con NDA | Locale (L2) finché non leggi i contratti | Quando serve |
| Remote git (GitHub privato, NAS, nessuno) | NAS o nessuno all'inizio; la CI remota è facoltativa (D-018). Oggi il remoto `origin` è su GitHub | Quando serve |
| `pgvector` al posto di Qdrant | Un servizio in meno; Qdrant resta la scelta se Mem0 lo richiede | Inizio Fase 2 |
| Editor della knowledge base | Obsidian all'inizio (l'utente l'ha installato il 2026-10-03) | Fase 2 |
| Fonti e persone per il Mentor | Scegli 10-15 nomi e fonti primarie | Fase 5 |
| ~~STT/TTS italiani~~ | **Deciso dall'utente con il provino del 2026-10-04:** trascrizione con Parakeet v3 (D-066), voce con Qwen3-TTS e la voce Serena (D-067, D-069) | |
| Numero e operatore telefonico | Decidere dopo costi e qualità | Fase 4 |
| Licenza degli sprite di pixel-agents (JIK-A-4, Metro City) | Uso personale ok; sostituire con asset a licenza chiara prima di condividere la cartella | Fase 3 |
| ~~Conferma delle decisioni della notte del 2026-10-05 (D-077, D-079 prima parte, D-080 prima parte, D-081…D-087)~~ | **Chiusa:** doppione delle conferme singole (`conf-D-077` … `conf-D-087b`), che restano aperte una per una | |
| Incognito: tetto di durata con la pagina aperta | Oggi un'incognita resta aperta finché una pagina la tiene aperta, anche nascosta (D-136): proposta di Claude, nessun tetto | D-136 è unita (0.25.0): prima di usare le incognite con dati veri |
| Incognito: verifica dal vivo del profilo di Claude Code | Un run vero con `--no-session-persistence` e l'elenco dei file del profilo di `claude` nella home prima e dopo (D-136, tappa 3) | Prima di usare le incognite di lavoro con dati veri |
| Modelli: schede cloud da rileggere | Frasi tradotte e prezzi API in `config/cloud-models.catalog.yaml` (D-137, I-3 M1); i nomi dei tre modelli di Codex sono verificati dal vivo il 2026-10-07 (D-141) | I-3 è unita (0.26.0): quando vuoi |
| Modelli da Hugging Face: scelte di D-139 | Applicate le opzioni consigliate di `docs/I-10-huggingface.md` mentre eri via: esce solo il testo cercato o l'id scelto, dal gateway; solo modelli MLX pubblici; catalogo tuo in `config/models.user-catalog.yaml`; sperimentale e senza ruoli finché non lo promuovi | I-10 è unita (0.31.0): per confermare D-139 |

### Domande delle proposte della notte del 2026-10-05

Testo, alternative e raccomandazioni in `docs/PROPOSTE.md`; qui solo l'elenco.

| Proposta | Domanda | Stato |
| --- | --- | --- |
| D-078 Sviluppo da dentro Arianna | 1. Clone separato del repository sotto la home come progetto L1, con le modifiche portate solo con `git pull`? | Chiusa (D-127): sì, clone dal repository locale dentro `repos/arianna` come progetto `arianna` L1; i lavori tornano come rami che unisce l'utente |
| D-078 | 2. Una sola memoria di sviluppo (tutto nel clone) o un file distinto per la scheda? | Chiusa (D-127): una sola memoria in git; il fascicolo è generato a ogni lavoro dai documenti del clone |
| D-078 | 3. Scheda nuova `developer` o il `coder` con una regola in più? | Chiusa (D-127): scheda nuova `god` in sola lettura; i sottocompiti li fa il `coder` com'è |
| D-078 | 4. Chi fa il commit nel clone? | Chiusa (D-127): nessun agente (D-174); «Prepara il ramo» fa il commit nel clone al clic dell'utente, l'unione la fa l'utente |
| D-078 | 5. Una sola delega attiva sul progetto di sviluppo? | Chiusa (D-127): no, sottocompiti in parallelo secondo la quota, ciascuno nel suo clone, mai due sugli stessi file |
| D-078 | 6. Quando cominciare? | Chiusa (D-127): adesso (2026-10-11) |
| D-078 | 7. Chi lancia `pnpm check` completo dopo un run? | Chiusa (D-127): nella sandbox build, lint, eval e i test senza servizi; il `pnpm check` completo con l'hook di pre-commit quando l'utente unisce |
| D-079 Catalogo "Agenzia" | 1. Catalogo come proposto (clone fissato, importatore, schede attive solo con approvazione)? | Chiusa: doppione della conferma `conf-D-079` |
| D-079 | 2. Chi fa il clone e quando? | Chiusa (2026-10-13): «Catalogo agenti» con il motore delle skill di D-161 (sorgenti GitHub, Aggiorna in attesa, Usa/Scarta), nessun clone a mano |
| D-079 | 3. Tetto delle schede adottate: L1 o L0? | Chiusa: L0 (D-119, T3b) |
| D-079 | 4. Autonomia delle schede adottate: A0 o A1? | Chiusa: D-119 (T3b) e revisione di D-079 per T4 |
| D-079 | 5. Schede approvate in `agents/` o fuori da git? | Chiusa: `data/agents/` (D-119) |
| D-079 | 6. Quali divisioni servono? | Chiusa (2026-10-13): tutte, con filtro per divisione e ricerca |
| D-079 | 7. Pagina "Agenzia" nelle Impostazioni o in chat? | Chiusa: modulo "+ Nuovo agente" della pagina Agenti (D-119, T4) |
| D-080 Second brain | 1. Tutto nasce L2 in `kb/inbox/` e si abbassa solo con approvazione? | Chiusa: sì, confermata dall'utente il 2026-10-13 con `conf-D-080` |
| D-080 | 2. L'Archivista propone e l'utente approva, o sposta da solo? | Chiusa (2026-10-13): propone, approva l'utente (A1) |
| D-080 | 3. Primo ingresso da costruire? | Chiusa: pagina "Pensieri" come ingresso principale, con "/nota" (richiesta dell'utente in D-086, costruita in D-090) |
| D-080 | 4. Declassificazione a L0 per singolo URL prima di scaricare un link? | Chiusa (2026-10-13): sì, ogni volta |
| D-080 | 5. `pdfjs-dist` in un processo figlio per i PDF? | Chiusa (2026-10-13): sì |
| D-080 | 6. Vocali e video: entrypoint in `apps/voice` o app Python a sé? | Chiusa (2026-10-13): entrypoint in `apps/voice` |
| D-080 | 7. Video di piattaforme solo come link, titolo e riassunto? | Chiusa (2026-10-13): no, solo audio scaricato con approvazione per link, trascritto e cancellato (SPEC aggiornata) |
| D-088 Pulsante "Aggiorna" | Come si porta il codice nuovo dallo sviluppo all'installazione? | Chiusa: accettata il 2026-10-13 con le risposte consigliate (riga D-088 di `DECISIONS.md`) |

## Idee dalla ricerca — da decidere

Fasi e ore come in `SPEC.md`, sezione "Idee dalla ricerca". Le ore non sono incluse nelle stime, salvo dove indicato. La colonna "Raccomandazione" è mia: la scelta resta tua.

| # | Idea | Fase | Ore | Raccomandazione |
| --- | --- | --- | --- | --- |
| 1 | Pattern Dual LLM / CaMeL | 2 | 12-20 | **Sì**, prima che il Segretario legga posta vera |
| 2 | Sandbox per gli agenti che eseguono codice | 1 | 6-10 | **Sì, già nel piano** (task 1.6, ore incluse): è parte del confinamento |
| 3 | DBOS per esecuzione durevole | 0-1 | 6-10 | **No per ora**: coda propria (D-004); si rivaluta a fine Fase 1 |
| 4 | Langfuse / Promptfoo / Inspect | 0-1 | 8-14 | **No per ora**: runner proprio e tabelle `runs` e `router_decisions` bastano; Langfuse si rivaluta con l'HUD |
| 5 | Funzioni native di Claude Code | 1 | 6-12 | **Rinviare** alla Fase 3: cambiano spesso e legano a un solo esecutore |
| 6 | Advisor tool nel router | 1 | 3-6 | **Rinviare**: è il piano B se il test 1.4 fallisce |
| 7 | Schede e procedure nel formato Skills più MCP | 1 | 4-8 | **Valutare dentro 1.9** senza ore in più; adozione piena in Fase 2 |
| 8 | Hermes Agent come harness | 1 | 10-20 | **No**: harness proprio sottile (task 1.10); la prova costerebbe più dell'harness |
| 9 | Scheduler deterministico | 1 | 4-8 | **Sì, quasi gratis**: `jobs.run_at` c'è già (D-004); le ricorrenze arrivano in Fase 2 |
| 10 | Fatture dall'XML FatturaPA | 2 | 8-14 | **Sì, per prima** (D-022): sostituisce l'OCR per le fatture |
| 11 | OCR e parsing locali | 2 | 10-18 | **Sì, dopo la 10**, solo per carta e scansioni; un solo strumento scelto con gli eval |
| 12 | Open banking PSD2 | 2+ | 15-30 | **No in v1**: i dati passano da un terzo |
| 13 | Memoria temporale con Graphiti | 5 | 20-35 | **No** finché una misura non lo chiede |
| 14 | Stack vocale locale pronto | 4 | 8-16 | Decidere all'inizio della Fase 4 (sostituisce lavoro) |
| 15 | Home Assistant via MCP | 3+ | 6-12 | Facoltativa, dopo la Fase 3 |
| 16 | Aggiornare e confrontare i modelli locali | 1 | 8-14 | **In parte già nel piano**: il test 1.4 è lo strumento; confronto completo solo se il Qwen attuale non passa |
| 17 | Ripasso FSRS con libreria | 5 | 8-15 | **Sì** (sostituisce lavoro) |
| 18 | Wiki compilato dal modello per il Mentor | 5 | 8-14 | Decidere in Fase 5 |

Scelta dell'utente: **non ancora fatta**.

## Spiegazioni delle domande

Contesto, opzioni ed esempio delle domande che non hanno posto sotto di sé (righe delle tabelle qui sopra, conferme delle decisioni di `DECISIONS.md`, righe "In attesa dell'utente" di `HANDOFF.md`), letti dalla pagina "Sviluppo di Arianna" (D-122). Un blocco per domanda, con la sua chiave come titolo: `conf-D-0NN` per una conferma, `oq-...` e `ho-...` per una riga (la chiave nasce dal testo della prima cella: se la riga cambia, cambia anche il titolo qui). Le domande di `PROPOSTE.md` hanno le stesse righe sotto la domanda. Quando una domanda si chiude, si toglie anche il suo blocco: un blocco senza domanda la pagina lo conta fra le righe saltate. Rilette il 2026-10-10: chiuse quelle già decise (righe barrate qui sopra, "(storico)" in `HANDOFF.md`, sezioni "Domande chiuse" in `PROPOSTE.md`, ciascuna con la sua fonte).

Parole che tornano spesso: **L0** = pubblico; **L1** = di lavoro, può andare a Claude o Codex passando dal gateway; **L2** = privato, resta sul Mac; **L3** = delicatissimo, nessun modello lo legge. Il **gateway** è il filtro unico di tutto ciò che esce verso il cloud; il **core** è il programma sempre acceso di Arianna; una **D-NNN** è una decisione scritta in `DECISIONS.md`.

### oq-conferma-delle-decisioni-proposta-applicata-d-00

- Contesto: All'inizio del progetto Claude ha preso alcune decisioni di base e le ha già messe in pratica, segnandole "Proposta, applicata": per esempio la coda dei lavori nel database (D-004), le regole su come tenere i documenti (D-013…D-021, D-024) e gli strumenti di sviluppo (D-025…D-029). Restano provvisorie finché non le confermi tu. Insieme si può decidere D-030 (tenere separate la cartella di sviluppo, con dati finti, e quella con i dati veri), che è ancora solo una proposta da applicare a fine Fase 1A. Si tratta di dire se ti vanno bene come sono o se qualcuna va cambiata.
- Opzione consigliata: Le rileggo e le confermo — diventano "accettate" e Claude non le rimette in discussione; se ne vuoi cambiare una la indichi nella risposta e Claude prepara la modifica.
- Opzione: Confermale tutte senza rileggerle — più veloce: diventano accettate subito; il rischio è scoprire più avanti una scelta che non ti piace e doverla rifare.
- Opzione: Rivediamole una alla volta — Claude te le presenta in conversazione con una domanda ciascuna: più lento, ma ogni scelta è spiegata.
- Opzione: Rimandiamo — restano provvisorie; nulla si ferma, ma la barra dello sviluppo le conta ancora "in corso".
- Esempio: Rileggi D-004 ("coda dei lavori in PostgreSQL invece di un servizio esterno") e rispondi "Confermo tutte tranne D-018: la CI remota non mi serve". Claude segna le altre come accettate e apre una proposta solo per D-018.

### oq-conteggio-di-claude-p-e-codex-exec-negli-abbonam

- Contesto: Quando Arianna fa lavorare Claude Code o Codex da soli (senza che tu scriva nel loro terminale), usa i tuoi abbonamenti. Va capito se questi lavori consumano la stessa quota delle tue chat normali o un credito a parte. Per Claude si è visto che ogni lavoro riporta le finestre di 5 ore e di 7 giorni dell'abbonamento; per Codex i lavori contano nella quota di ChatGPT (circa 60 lavori il 7 ottobre l'hanno portata al 14%). Manca solo un tuo controllo nella pagina dell'account, che Claude non può vedere, per sapere se esiste un credito separato.
- Opzione consigliata: Controllo io nell'account — guardi la pagina dell'utilizzo prima e dopo un paio di lavori e scrivi qui cosa cambia; Claude regola di conseguenza i limiti di Arianna.
- Opzione: Consideriamo la quota condivisa — si dà per scontato che consumino la stessa quota (ipotesi prudente) e la riga si chiude.
- Opzione: Rimandiamo — resta aperta; i lavori continuano come oggi.
- Esempio: Alle 10:00 l'account segna il 30% della finestra di 5 ore; Arianna fa fare a Claude due piccole modifiche; alle 10:20 segna il 34%. Allora i lavori di Arianna pesano sulla stessa quota e conviene non lanciarne troppi di giorno.

### oq-omlx-invia-telemetria-o-contenuti-fuori-dalla-ma

- Contesto: oMLX è il programma che fa girare sul Mac i modelli locali, quindi vedrà i tuoi dati privati (L2), quelli che non devono mai uscire dal Mac. Il suo manuale non dice se manda statistiche d'uso ("telemetria") o altro su internet. Prima di dargli dati veri va controllato, guardando il codice o il traffico di rete.
- Opzione consigliata: Verificare prima dei dati veri — si controllano codice e traffico entro la fine della Fase 1A; fino ad allora oMLX vede solo dati finti e risponde solo al Mac stesso.
- Opzione: Bloccarlo anche col firewall — in più alla verifica gli si impedisce di uscire su internet: più sicuro, ma va sbloccato per scaricare modelli nuovi.
- Opzione: Fidarsi del manuale — nessun lavoro, ma un'uscita nascosta dei dati privati non verrebbe scoperta.
- Esempio: Si avvia oMLX, gli si fa riassumere una nota finta e intanto un programma che sorveglia la rete (come Little Snitch) mostra se tenta di collegarsi a indirizzi esterni. Se non ci prova mai, la riga si chiude.

### oq-codex-con-provider-locale-invia-telemetria-o-con

- Contesto: Codex, l'assistente di programmazione di OpenAI, oggi in Arianna lavora solo come esecutore cloud (D-138, D-140): riceve solo dati che possono uscire (L0 e L1). Codex può anche usare un modello locale al posto di quello nel cloud; anche così però potrebbe mandare statistiche o pezzi di testo ai server di OpenAI. Si decide come trattarlo finché non lo si verifica.
- Opzione consigliata: Trattarlo come cloud, per ora — nessun rischio: Codex riceve solo dati che possono uscire; la verifica si fa quando servirà usarlo con un modello locale.
- Opzione: Verificarlo subito — si controlla ora il traffico di rete di Codex con un modello locale; se non esce nulla, potrebbe lavorare anche su progetti privati.
- Opzione: Mai Codex con modelli locali — la questione si chiude: Codex resta solo un esecutore cloud.
- Esempio: Chiedi a Codex di sistemare un file di un progetto privato. Finché la riga è aperta Arianna lo rifiuta e propone il modello locale; dopo una verifica positiva potrebbe permetterlo.

### oq-codice-clienti-con-nda

- Contesto: Se lavori su codice di clienti con un accordo di riservatezza (NDA), potrebbe essere vietato mandarlo a servizi cloud come Claude o Codex. Finché non hai letto i contratti, la proposta è trattare quel codice come privato (L2): lo vedono solo i modelli che girano sul Mac.
- Opzione consigliata: Privato finché non leggo i contratti — il codice dei clienti non va mai al cloud; i modelli locali possono lavorarci, più lenti ma sicuri.
- Opzione: Decido cliente per cliente — per ogni progetto scegli tu il livello dopo aver letto il contratto: più lavoro all'inizio, più libertà dove il contratto lo permette.
- Opzione: Niente codice dei clienti in Arianna — nessun rischio, ma Arianna non ti aiuta su quei progetti.
- Esempio: Aggiungi il progetto "gestionale-rossi" (cliente inventato). Se chiedi "fai correggere il bug a Claude", Arianna risponde che il progetto è privato e propone il modello locale; se il contratto lo permette, cambi il livello e Claude può lavorarci.

### oq-remote-git-github-privato-nas-nessuno

- Contesto: Il codice di Arianna è salvato con git, che tiene la storia delle modifiche. Un "remoto" è una copia di quella storia su un'altra macchina, utile come backup. Può stare su GitHub (nel cloud), sul NAS di casa o da nessuna parte. La proposta di partenza era NAS o nessuno; oggi però il remoto origin è su GitHub e i push li fai tu. Si decide quale tenere come regola.
- Opzione consigliata: NAS o nessuno all'inizio — il NAS fa da copia in casa; cosa fare del remoto su GitHub di oggi è una scelta a parte.
- Opzione: GitHub privato, com'è oggi — copia nel cloud raggiungibile da ovunque e controlli automatici gratuiti; il codice (non i tuoi dati, che stanno fuori da git) è su un servizio esterno.
- Opzione: Nessun remoto — zero configurazione, ma se il disco del Mac si rompe la storia del codice si perde.
- Esempio: A fine giornata un git push copia gli ultimi commit sul NAS. Se il Mac si guasta, sul Mac nuovo scarichi tutto dal NAS e riprendi dal punto esatto.

### oq-pgvector-al-posto-di-qdrant

- Contesto: Per cercare nei tuoi documenti "per significato", non solo per parole uguali, serve un archivio di vettori: numeri che rappresentano il senso dei testi. Si può usare pgvector, un'aggiunta al database PostgreSQL che Arianna ha già, oppure Qdrant, un programma separato. La proposta è pgvector, salvo che la memoria Mem0 (prevista in Fase 2) richieda Qdrant.
- Opzione consigliata: pgvector nel database che c'è già — un programma in meno da avviare, aggiornare e salvare nel backup; tutto sta in PostgreSQL.
- Opzione: Qdrant — più veloce su archivi molto grandi e richiesto da alcuni strumenti, ma è un programma in più da far girare.
- Opzione: Decidere all'inizio della Fase 2 — nessun lavoro ora; si sceglie quando si costruisce la ricerca nei documenti.
- Esempio: Cerchi "quella nota sul preventivo del tetto" e la nota si intitola "Lavori copertura, offerta ditta Bianchi". La ricerca per significato la trova lo stesso; con pgvector è una semplice interrogazione al database di Arianna.

### oq-editor-della-knowledge-base

- Contesto: La knowledge base è la raccolta delle tue note e documenti che Arianna legge e riordina (la cartella kb/). Serve un programma con cui aprirle e scriverle a mano. La proposta è Obsidian, che hai già installato: lavora su semplici file di testo nella cartella, senza mandarli nel cloud. Oggi Arianna ha anche le sue pagine Pensieri e Conoscenza.
- Opzione consigliata: Obsidian all'inizio — apri la cartella delle note in Obsidian e le vedi con collegamenti e grafo; Arianna e Obsidian lavorano sugli stessi file.
- Opzione: Solo le pagine di Arianna — niente programma in più: leggi e scrivi le note da Pensieri e Conoscenza nella chat.
- Opzione: Un altro editor (es. VS Code) — funziona perché sono file di testo, ma senza le comodità pensate per le note.
- Esempio: Arianna salva in kb/inbox la nota "Idea: corso di fotografia a novembre". Aprendo Obsidian la trovi già lì, aggiungi due righe e un collegamento a "Hobby", e Arianna alla lettura successiva vede la modifica.

### oq-fonti-e-persone-per-il-mentor

- Contesto: Il Mentor è l'agente della Fase 5 che ti aiuta a studiare e crescere partendo da autori e fonti di cui ti fidi. Per costruirlo servono 10-15 nomi di persone o fonti "primarie" (libri, corsi, siti originali, non riassunti fatti da altri). Non è urgente: serve in Fase 5.
- Opzione consigliata: Lista quando arriva la Fase 5 — nessun lavoro ora; la domanda resta in elenco come promemoria.
- Opzione: Scrivo ora qualche nome — Claude li annota nella proposta del Mentor, così sono pronti quando si comincia.
- Opzione: Claude propone una lista da approvare — più rapido per te, ma fonti scelte da altri possono non rispecchiare i tuoi interessi.
- Esempio: "i saggi di Paul Graham sul suo sito, il libro 'Pensieri lenti e veloci', un corso introduttivo di statistica". Il Mentor ti propone letture e domande di ripasso partendo da lì.

### oq-numero-e-operatore-telefonico

- Contesto: Nella Fase 4 Arianna potrà chiamarti su un telefono vero. Serve un numero e un operatore che permetta di collegarlo a un programma (telefonia via internet, VoIP o SIP). Oggi le chiamate funzionano già dentro la chat, via internet (D-066). La proposta è scegliere l'operatore solo dopo aver confrontato costi e qualità.
- Opzione consigliata: Decidere dopo un confronto — Claude prepara una tabella di 2-3 operatori con prezzi e qualità; tu scegli in Fase 4.
- Opzione: Solo chiamate via internet — niente numero; Arianna ti chiama dentro la sua app, come oggi: gratis, ma servono connessione e app.
- Opzione: Scelgo subito un operatore — si può provare prima, ma si paga un numero che per ora non serve.
- Esempio: Un operatore VoIP con un numero a 1 euro al mese e 2 centesimi al minuto; Arianna ti chiama ogni mattina alle 8 per un minuto di riepilogo: circa 60 centesimi al mese di chiamate.

### oq-licenza-degli-sprite-di-pixel-agents-jik-a-4-met

- Contesto: Gli sprite sono le immagini dei personaggi in pixel. Quelli del progetto pixel-agents (autori JIK-A-4 e Metro City) vanno bene per uso personale, ma non per condividere la cartella di Arianna con altri. Nel frattempo Arianna ha personaggi originali suoi (D-060), quindi il problema potrebbe essere già superato. La consigliata si scosta dalla riga della tabella ("uso personale ok, sostituirli prima di condividere"), scritta prima dei personaggi originali.
- Opzione consigliata: Chiudila, uso i personaggi originali — Claude verifica che nel repository non sia rimasto nessuno sprite di pixel-agents e barra la riga.
- Opzione: Tenere gli sprite per uso personale — vanno bene finché la cartella non si condivide; prima di condividerla vanno tolti.
- Opzione: Comprare un pacchetto a licenza chiara — personaggi diversi ma condivisibili; costa e va scelto lo stile.
- Esempio: Se un giorno vuoi mostrare Arianna a un amico mandandogli la cartella, con i personaggi originali puoi farlo; con quelli di pixel-agents no, perché la loro licenza non lo permette.

### oq-incognito-tetto-di-durata-con-la-pagina-aperta

- Contesto: Una conversazione in incognito (D-136) si cancella da sola dopo 10 minuti senza nessuna pagina aperta su di lei. Se invece lasci la scheda del browser aperta, anche dietro altre schede, resta viva senza limite, con i testi nel database. La modalità è già unita (0.25.0); si decide se mettere un tetto massimo di durata.
- Opzione consigliata: Nessun tetto — finché la pagina è aperta l'incognita resta; la chiudi tu con "Termina" o chiudendo la scheda.
- Opzione: Tetto di 12 ore — dopo 12 ore dall'apertura si chiude comunque, con un avviso un minuto prima; un lavoro lungo del Coder può venire interrotto.
- Opzione: Tetto di 2 ore — più prudente per la privacy, ma una sessione di lavoro lunga va riaperta.
- Esempio: Apri un'incognita alle 18:00 per parlare di un preventivo e dimentichi la scheda aperta; senza tetto alle 9:00 del giorno dopo i testi sono ancora nel database, con il tetto di 12 ore spariscono alle 6:00.

### oq-incognito-verifica-dal-vivo-del-profilo-di-claud

- Contesto: Nelle incognite di lavoro Claude Code parte con l'opzione che non salva la sessione sul disco. Non è ancora verificato se scrive comunque altro nella cartella del suo profilo, sotto la tua cartella utente (copie dei file toccati, cronologie, file di debug). Per saperlo serve un lavoro vero e guardare quella cartella prima e dopo; sta fuori dal repository, quindi Claude non può farlo da solo.
- Opzione consigliata: Lo facciamo insieme — apri una sessione in cui autorizzi la lettura dell'elenco dei file del profilo; si aggiunge un caso all'eval dal vivo e il risultato va nella scheda di chiusura dell'incognita.
- Opzione: Lo controllo io a mano — guardi tu la cartella prima e dopo un'incognita di lavoro e scrivi qui cosa cambia.
- Opzione: Rimandiamo — le incognite di lavoro si usano solo con dati finti finché non è verificato.
- Esempio: Prima di un'incognita di lavoro la cartella del profilo ha 1.204 file; dopo ne ha 1.207 (tre file di debug). La scheda di chiusura allora dirà "Claude Code ha lasciato 3 file di debug nel suo profilo".

### oq-modelli-schede-cloud-da-rileggere

- Contesto: La pagina Modelli delle Impostazioni (D-137) mostra una scheda per Sonnet, Opus, Fable e Codex con punti di forza, contesto e prezzi presi dalle pagine dei fornitori il 7 ottobre. Le frasi sono traduzioni di Claude (per esempio "Il più lento" per "Slower") e i prezzi sono quelli delle API a consumo, non la quota dell'abbonamento che usi davvero. I nomi dei tre modelli di Codex (Luna, Sol, Astra) sono stati verificati dal vivo (D-141). Si decide se rileggerle, togliere i prezzi o tenerle così.
- Opzione consigliata: Le rileggo e correggo — leggi le schede nella pagina Modelli (o il file config/cloud-models.catalog.yaml) e scrivi cosa cambiare.
- Opzione: Togliere i prezzi API — restano frasi e contesto; niente cifre che possano confondersi con la quota.
- Opzione: Vanno bene così — la riga si chiude.
- Esempio: Nella scheda di Opus leggi "4 / 20 $ per milione di token (API)"; se pensi che faccia credere che ogni delega ti costi soldi, scegli di toglierli.

### oq-modelli-da-hugging-face-scelte-di-d-139

- Contesto: Nella pagina Modelli puoi cercare e aggiungere modelli da Hugging Face, il grande archivio pubblico di modelli (I-10, unita in 0.31.0). Claude ha scelto da solo, mentre eri via, le regole più prudenti (D-139): dal Mac esce solo il testo che scrivi nella ricerca o il nome del modello scelto, passando dal gateway e senza account; solo modelli MLX pubblici con pesi .safetensors; il modello va in un catalogo tuo fuori da git (config/models.user-catalog.yaml), sperimentale e senza ruoli finché non lo promuovi tu. Si decide se queste regole restano.
- Opzione consigliata: Vanno bene così — D-139 diventa accettata con queste regole.
- Opzione: Anche modelli con login — serve un token di Hugging Face nella cassaforte per i modelli ad accesso controllato (per esempio quelli di Meta): una credenziale in più e una nuova decisione.
- Opzione: Anche il formato GGUF — si aggiunge un secondo motore (llama.cpp) accanto a oMLX: più modelli fra cui scegliere, ma un programma in più da installare e provare.
- Opzione: Senza promozione — il modello aggiunto si assegna subito a un ruolo: un passaggio in meno, ma un modello mai provato può diventare il "cervello" di Arianna con un clic.
- Esempio: Scrivi "qwen3 4bit", scegli mlx-community/Qwen3-4B-4bit (2,3 GB, licenza apache-2.0), premi Aggiungi: compare come qwen3-4b-4bit, da scaricare e senza ruoli; lo scarichi, lo promuovi a Estrattore, poi lo assegni al ruolo e salvi.

### ho-latenza-delle-chiamate-passi-1-2-e-4-fatti-d-070

- Contesto: In una chiamata con Arianna passano 2,3-2,8 secondi fra la fine della tua domanda e la sua risposta. Due accorciamenti decisi da Claude sono applicati ma aspettano la tua conferma: D-072 (meno storia mandata al modello) e D-073 (Arianna considera finito il tuo turno dopo 0,6 secondi di silenzio invece di 0,8). Il rischio di D-073 è che Arianna ti interrompa se fai una pausa per pensare.
- Opzione consigliata: Provo una chiamata e confermo — dici se il tempo va bene e se ti taglia mentre pensi; Claude conferma D-072 e D-073 o allunga il silenzio.
- Opzione: Confermo senza prova — D-072 e D-073 diventano accettate; eventuali problemi si vedranno più avanti.
- Opzione: Continuare ad accorciare — Claude fa anche il passo 3 (primo pezzo di voce più corto) e il 5 (un "Mm, vediamo…" registrato mentre il modello pensa).
- Esempio: Chiedi "Che tempo fa domani a Torino?", fai una pausa di mezzo secondo a metà frase e guardi se Arianna risponde prima che tu abbia finito.

### ho-git-push-di-main-avanti-di-origin-main-dai-commi

- Contesto: Claude non può fare push, cioè mandare i commit al repository remoto (oggi su GitHub): lo fai tu. Il ramo main locale è avanti rispetto al remoto, e restano rami già uniti a main che si possono cancellare senza perdere nulla: in locale task/d-065-markdown, sul remoto task/d-058-projects, task/0.3-postgres, task/1.6-confinement, task/1.15-telegram, task/1.18-wizard e task/1.10-orchestrator. Anche i tag delle versioni (v0.x.0) restano solo in locale finché non li mandi tu.
- Opzione consigliata: Faccio push e pulizia — il remoto si allinea e l'elenco dei rami si accorcia; nulla si perde perché i rami sono già in main.
- Opzione: Solo il push — il codice è al sicuro sul remoto; i rami vecchi restano.
- Opzione: Più avanti — il remoto resta indietro: se il Mac si rompe, gli ultimi commit esistono solo qui.
- Esempio: git push origin main, poi git push origin --delete task/0.3-postgres (e così per gli altri rami remoti) e git branch -d task/d-065-markdown.

### ho-permessi-in-claude-settings-json

- Contesto: Volevi che Claude lavorasse senza chiederti conferme a ogni modifica. Claude non può cambiare da solo i propri permessi (sarebbe un'auto-concessione), quindi il file .claude/settings.json lo modifichi tu. Oggi il file non contiene ancora la modalità proposta.
- Opzione consigliata: Incollo la proposta di Claude — modifiche ai file senza conferma; installare pacchetti e cambiare la configurazione globale di git chiedono sempre; il controllo dei percorsi blocca anche quando va in errore.
- Opzione: Lascio com'è — Claude continua a chiedere conferma per molte azioni: più lento ma più controllato.
- Opzione: Voglio una versione diversa — scrivi cosa permettere o vietare; Claude prepara il testo da incollare.
- Esempio: Con la proposta, Claude modifica apps/hud/src/style.css senza chiedere, ma per "pnpm add lodash" compare comunque la tua conferma.

### ho-conferma-di-d-034

- Contesto: D-034 riguarda le schede degli agenti, i file che dicono a ogni agente cosa può fare. Il punto da confermare: quando un agente passa un lavoro a un altro (una delega), l'altro parte con un contesto separato e non può comunicare con l'esterno solo perché chi delega poteva farlo.
- Opzione consigliata: Confermo — la regola diventa definitiva: una delega non allarga mai i permessi.
- Opzione: Voglio eccezioni — scrivi quali; Claude propone una decisione nuova, valutando il rischio di fughe di dati.
- Esempio: Arianna può scriverti sul telefono; se delega al Coder la sistemazione di un file, il Coder non ottiene per questo il diritto di mandarti messaggi.

### ho-conferma-di-d-047

- Contesto: D-047 è l'installer (pnpm arianna:install), il comando che prepara Arianna su un Mac. Due scelte da confermare: rende privata la cartella data/ anche se esisteva già, ed esce con errore finché il controllo dell'installazione (doctor) non è tutto verde, anche quando l'installazione in sé è riuscita.
- Opzione consigliata: Confermo — l'installer resta severo: non dice "pronto" finché ci sono password di sviluppo o pezzi mancanti.
- Opzione: Successo se l'installazione riesce — più comodo, ma un "tutto ok" potrebbe nascondere che non è pronto per i dati veri.
- Esempio: Dopo un'installazione nuova con le password di prova, l'installer finisce con "installato, ma non pronto per i dati veri" ed esce con errore.

### ho-conferma-di-d-048

- Contesto: D-048 è il wizard (le domande in italiano che scrivono la configurazione config/arianna.toml) con il catalogo dei modelli. Le scelte di fondo le hai già fatte; restano da confermare tre dettagli: oMLX sulla porta 7001, il controllo che fallisce se i modelli scelti superano la memoria del Mac, la rilettura della configurazione ogni secondo.
- Opzione consigliata: Confermo — i dettagli restano come sono e D-048 diventa accettata.
- Opzione: Cambio un dettaglio — scrivi quale; Claude lo modifica.
- Esempio: Se scegli modelli che insieme chiedono 80 GB su un Mac da 64 GB, pnpm arianna:doctor fallisce e lo dice.

### ho-conferma-di-d-052

- Contesto: D-052 ha chiuso il test 1.4 scegliendo il modello locale da 27B come orchestratore (il "cervello" di Arianna), con due accorgimenti: una regola sulle virgolette nei pensieri del modello e un secondo tentativo quando la risposta non è nel formato richiesto (JSON). Durante lo sviluppo oggi gira il 9B, più leggero, per non mandare il Mac in affanno; il 27B resta la scelta per l'uso vero.
- Opzione consigliata: Confermo — il 27B resta l'orchestratore per l'uso vero, con questi accorgimenti.
- Opzione: Voglio riprovare altri modelli — Claude usa la prova dei modelli (Impostazioni → Modelli) e propone un cambio se uno va meglio.
- Esempio: Se il modello risponde con testo libero invece del formato richiesto, Arianna gli richiede la stessa cosa una volta, senza la parte di ragionamento.

### ho-togliere-a-mano-data-scratch-review-d065

- Contesto: La cartella data/scratch/review-d065/ contiene file di prova lasciati dal revisore automatico il 2026-10-04; è fuori da git, non serve più e c'è ancora. Claude non la cancella da solo perché le cancellazioni passano da te.
- Opzione consigliata: La cancello io — basta rm -r data/scratch/review-d065 dalla cartella del progetto; poi la riga si toglie.
- Opzione: Cancellala tu, Claude — Claude la toglie con la tua approvazione e chiude la riga.
- Opzione: Lasciala — occupa poco spazio; la riga si toglie comunque.
- Esempio: Dentro ci sono piccoli file di sonda usati per verificare un controllo di sicurezza, che nessun programma legge più.

### ho-prova-dal-vivo-di-d-058-fuori-da-arianna

- Contesto: D-058 permette al Coder (Claude che scrive codice) di lavorare su un tuo progetto vero, in una cartella fuori da quella di Arianna. Finora è stato provato solo su progetti finti dentro la cartella di Arianna (repos/). Va provato dal vivo su un progetto finto fuori. Consuma chiamate vere dell'abbonamento.
- Opzione consigliata: La faccio seguendo i passi — crei un progetto finto, lo aggiungi in Impostazioni → Progetti (o col wizard) e chiedi al Coder una pagina; se va bene la riga si chiude.
- Opzione: Rinvio — la riga resta; il Coder fuori dalla cartella di Arianna resta non provato dal vivo.
- Esempio: Crei la cartella vuota "negozio-finto" nella tua cartella utente, la registri come progetto e in chat scrivi "fammi una landing page per una pasticceria inventata".

### ho-su-un-altra-macchina-pnpm-arianna-init-reconfigu

- Contesto: È un promemoria per il futuro: se usi Arianna su un altro computer, la sua vecchia configurazione con l'elenco cloud "allowlist" viene rifiutata e va riscritta con il wizard (i progetti oggi sono blocchi [[project]]). Su questo Mac l'ha già convertita Claude.
- Opzione consigliata: Non ho altre macchine, togli la riga — se un giorno ne aggiungi una, il messaggio di errore spiega comunque cosa fare.
- Opzione: Ho un'altra macchina — su quella lanci pnpm arianna:init --reconfigure, poi la riga si chiude.
- Esempio: Sul portatile Arianna non parte e dice che allowlist non è più accettata; lanci il wizard e i progetti diventano blocchi [[project]].

### ho-password-vere-del-database

- Contesto: Oggi il database usa password di sviluppo, note a tutti. Prima di metterci dati veri vanno cambiate, ma solo dopo il criterio di uscita della Fase 1A (il traguardo che chiude la fase in corso). Non è ancora il momento.
- Opzione consigliata: Più avanti, a fine Fase 1A — la riga resta come promemoria; Claude te la ricorda quando la fase si chiude.
- Opzione: Subito — segui i passi di SECURITY.md (password nuova con psql, poi pnpm db:migrate e pnpm arianna:doctor); lo sviluppo continua con le nuove.
- Esempio: Con le password di sviluppo pnpm arianna:doctor resta rosso; dopo il cambio diventa verde su quel punto.

### ho-chiave-age-vera

- Contesto: Il vault è la cassaforte cifrata dei segreti di Arianna; si apre con una chiave "age", un file che solo tu tieni. Quella vera la generi tu, ma va fatta solo dopo il criterio di uscita della Fase 1A. Non è ancora il momento.
- Opzione consigliata: Più avanti, a fine Fase 1A — la riga resta come promemoria.
- Opzione: Subito, come eccezione — un'eccezione alla regola delle fasi: la generi con i passi di SECURITY.md (sezione Vault) e la conservi anche fuori dal Mac.
- Esempio: Generi la chiave, lanci pnpm vault:init con la parte pubblica che inizia con "age1", e la parte privata la stampi e la metti in un cassetto.

### ho-scelta-delle-18-idee

- Contesto: Dalla ricerca iniziale sono uscite 18 idee (per esempio leggere le fatture dal file XML, un'esecuzione più robusta dei lavori, una memoria che tiene conto del tempo). Nella tabella "Idee dalla ricerca" di OPEN-QUESTIONS c'è la raccomandazione di Claude per ciascuna; manca la tua scelta.
- Opzione consigliata: Accetto le raccomandazioni di Claude — i "sì" entrano nel piano dei lavori, i "no" e i "rinviare" restano nella tabella come scelte fatte.
- Opzione: Le scelgo una per una — Claude te le presenta in conversazione con una domanda ciascuna.
- Opzione: Rinvio — restano tutte da decidere.
- Esempio: Idea 10, "Fatture dall'XML FatturaPA": raccomandata sì, perché leggere il file XML della fattura elettronica è più affidabile che leggere una scansione.

### ho-conferma-di-d-039

- Contesto: D-039 è la chat e le sue API (task 1.11), cioè le porte da cui la pagina parla con il core. Due punti da confermare: un messaggio di lavoro viene rifiutato se il controllo di privacy ci trova dati sensibili, e le API non chiedono login fino al task 1.13 (oggi rispondono solo al Mac stesso).
- Opzione consigliata: Confermo — le due regole restano; il login arriva con il task 1.13.
- Opzione: Voglio il login subito — Claude anticipa una parte del 1.13; più lavoro adesso.
- Esempio: Se in una conversazione di lavoro incolli un IBAN inventato, il messaggio non parte e la chat ti dice perché.
