# Decisioni aperte e idee da scegliere

## Decisioni aperte

| Decisione | Proposta | Entro |
| --- | --- | --- |
| ~~Linguaggio del nucleo~~ | **Deciso: TypeScript** (D-003) | |
| Conferma delle decisioni "Proposta, applicata" (D-004, D-013…D-021, D-024) | Rileggerle in `DECISIONS.md` e confermarle o rifiutarle | Task 0.6 |
| Dove gira il server | Mac Studio all'inizio, dietro interfaccia sostituibile | Fase 1A |
| Conteggio di `claude -p` e `codex exec` negli abbonamenti | `claude -p` (task 1.5, D-049): con il login dell'abbonamento (`apiKeySource: none`) ogni run riporta un `rate_limit_event` con le finestre `five_hour` e `seven_day` dell'abbonamento; non è verificato se esista un credito separato. Da guardare nel tuo account dopo qualche run. `codex exec` (task 1.16, D-138): con il login ChatGPT; lo stream non porta finestre di quota né crediti, quindi va guardato nel tuo account (o nella barra della quota) dopo qualche run | Prima di usare Codex nelle deleghe (D-111, tappa C) |
| Nomi esatti dei flag di confinamento (`--strict-mcp-config`, sorgenti delle impostazioni, sandbox) | Fissati per `claude` 2.1.288, sandbox compresa (D-049, D-050, `packages/executors/src/claude/profile.ts`), e per `codex` 0.160.0 (D-138, `packages/executors/src/codex/profile.ts`) | Task 1.6 e 1.16 |
| ~~Sandbox: nativa di Claude Code oppure `sandbox-runtime`~~ | **Decisa la nativa** (D-050, confermata): il canarino non esce. microVM solo se un giorno esce | |
| oMLX può puntare a `data/models/`? | Sì secondo il README: `omlx serve --model-dir data/models` (da provare); altrimenti collegamenti simbolici | Task 1.17 |
| oMLX invia telemetria o contenuti fuori dalla macchina? | Il README non ne parla: verificare (codice o traffico di rete) prima di dargli dati L2 veri; non usare `--mcp-config` né `--hf-endpoint` con dati veri. Lasciare `--host 127.0.0.1` | Prima dell'uso con dati veri (fine Fase 1A) |
| Codex con provider locale invia telemetria o contenuti altrove? | Finché non è verificato non conta come locale | Task 1.16 |
| Codice clienti con NDA | Locale (L2) finché non leggi i contratti | Quando serve |
| Remote git (GitHub privato, NAS, nessuno) | NAS o nessuno all'inizio; la CI remota è facoltativa (D-018) | Quando serve |
| `pgvector` al posto di Qdrant | Un servizio in meno; Qdrant resta la scelta se Mem0 lo richiede | Inizio Fase 2 |
| Editor della knowledge base | Obsidian all'inizio | Fase 2 |
| Fonti e persone per il Mentor | Scegli 10-15 nomi e fonti primarie | Fase 5 |
| STT/TTS italiani | Provarne 2-3 locali con la tua voce | Inizio Fase 4 |
| Numero e operatore telefonico | Decidere dopo costi e qualità | Fase 4 |
| Licenza degli sprite di pixel-agents (JIK-A-4, Metro City) | Uso personale ok; sostituire con asset a licenza chiara prima di condividere la cartella | Fase 3 |
| Skill nel formato agentskills.io | Verificare compatibilità con Hermes, Claude Code e Codex (idea 7) | Task 1.9 |
| Conferma delle decisioni della notte del 2026-10-05 (D-077, D-079 prima parte, D-080 prima parte, D-081…D-087) | Rileggerle in `DECISIONS.md`: sono applicate ma da confermare | Prossima sessione con l'utente |
| Incognito: tetto di durata con la pagina aperta | Oggi un'incognita resta aperta finché una pagina la tiene aperta, anche nascosta (D-136): proposta di Claude, nessun tetto | Prima di unire D-136 |
| Incognito: verifica dal vivo del profilo di Claude Code | Un run vero con `--no-session-persistence` e l'elenco dei file del profilo di `claude` nella home prima e dopo (D-136, tappa 3) | Prima di usare le incognite di lavoro con dati veri |
| Modelli: schede cloud da rileggere | Frasi tradotte, prezzi API e nomi dei modelli di Codex in `config/cloud-models.catalog.yaml` (D-137, I-3 M1) | Prima di unire I-3 |

### Domande delle proposte della notte del 2026-10-05

Testo, alternative e raccomandazioni in `docs/PROPOSTE.md`; qui solo l'elenco.

| Proposta | Domanda | Stato |
| --- | --- | --- |
| D-078 Sviluppo da dentro Arianna | 1. Clone separato del repository sotto la home come progetto L1, con le modifiche portate solo con `git pull`? | Aperta |
| D-078 | 2. Una sola memoria di sviluppo (tutto nel clone) o un file distinto per la scheda? | Aperta |
| D-078 | 3. Scheda nuova `developer` o il `coder` con una regola in più? | Aperta |
| D-078 | 4. Chi fa il commit nel clone? | Aperta |
| D-078 | 5. Una sola delega attiva sul progetto di sviluppo? | Aperta |
| D-078 | 6. Quando cominciare? | Aperta |
| D-078 | 7. Chi lancia `pnpm check` completo dopo un run? | Aperta |
| D-079 Catalogo "Agenzia" | 1. Catalogo come proposto (clone fissato, importatore, schede attive solo con approvazione)? | Prima parte applicata, da confermare |
| D-079 | 2. Chi fa il clone e quando? | Aperta |
| D-079 | 3. Tetto delle schede adottate: L1 o L0? | Aperta |
| D-079 | 4. Autonomia delle schede adottate: A0 o A1? | Aperta |
| D-079 | 5. Schede approvate in `agents/` o fuori da git? | Aperta |
| D-079 | 6. Quali divisioni servono? | Aperta |
| D-079 | 7. Pagina "Agenzia" nelle Impostazioni o in chat? | Aperta |
| D-080 Second brain | 1. Tutto nasce L2 in `kb/inbox/` e si abbassa solo con approvazione? | Applicata così, da confermare |
| D-080 | 2. L'Archivista propone e l'utente approva, o sposta da solo? | Aperta |
| D-080 | 3. Primo ingresso da costruire? | Scelto "/nota" da Claude, da confermare; l'utente vuole come ingresso principale la pagina "Pensieri" |
| D-080 | 4. Declassificazione a L0 per singolo URL prima di scaricare un link? | Aperta |
| D-080 | 5. `pdfjs-dist` in un processo figlio per i PDF? | Aperta |
| D-080 | 6. Vocali e video: entrypoint in `apps/voice` o app Python a sé? | Aperta |
| D-080 | 7. Video di piattaforme solo come link, titolo e riassunto? | Aperta |
| D-088 Pulsante "Aggiorna" | Come si porta il codice nuovo dallo sviluppo all'installazione? | Proposta, da discutere |

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

Contesto, opzioni ed esempio delle domande che non hanno posto sotto di sé (righe delle tabelle qui sopra, conferme delle decisioni di `DECISIONS.md`, righe "In attesa dell'utente" di `HANDOFF.md`), letti dalla pagina "Sviluppo di Arianna" (D-122). Un blocco per domanda, con la sua chiave come titolo: `conf-D-0NN` per una conferma, `oq-...` e `ho-...` per una riga (la chiave nasce dal testo della prima cella: se la riga cambia, cambia anche il titolo qui). Le domande di `PROPOSTE.md` hanno le stesse righe sotto la domanda. Quando una domanda si chiude, si toglie anche il suo blocco: un blocco senza domanda la pagina lo conta fra le righe saltate.

### oq-conferma-delle-decisioni-proposta-applicata-d-00

- Contesto: All'inizio del progetto Claude ha preso alcune decisioni di base e le ha già messe in pratica, segnandole "Proposta, applicata": per esempio la coda dei lavori nel database (D-004) e le regole su come lavorare con i documenti (D-013…D-021, D-024). Restano provvisorie finché non le confermi tu: si tratta di dire se ti vanno bene come sono o se qualcuna va cambiata.
- Opzione consigliata: Le rileggo e le confermo — le decisioni diventano "accettate" e Claude non le rimette in discussione; se ne vuoi cambiare una, la indichi nella risposta e Claude prepara la modifica.
- Opzione: Confermale tutte senza rileggerle — più veloce: diventano accettate subito; il rischio è scoprire più avanti una scelta che non ti piace e doverla rifare.
- Opzione: Rimandiamo — restano provvisorie e la domanda resta aperta; nulla si ferma, ma la barra dello sviluppo le conta ancora "in corso".
- Esempio: Rileggi D-004 ("coda dei lavori in PostgreSQL invece di un servizio esterno") e rispondi "Confermo tutte tranne D-018: la CI remota non mi serve". Claude segna le altre come accettate e apre una proposta solo per D-018.

### oq-dove-gira-il-server

- Contesto: Arianna ha un "server", cioè il programma sempre acceso che tiene la memoria, la coda dei lavori e la chat. Bisogna decidere su quale computer vive. La proposta è il Mac Studio, scritto però in modo che un domani si possa spostare su un'altra macchina senza riscrivere il codice.
- Opzione consigliata: Mac Studio, spostabile in futuro — si parte subito sul computer che hai già; se un giorno vuoi un mini server dedicato o un NAS, si cambia solo la configurazione.
- Opzione: Un computer dedicato sempre acceso — Arianna non rallenta il Mac su cui lavori, ma serve comprare e mantenere un'altra macchina.
- Opzione: Decidiamo più avanti — lo sviluppo continua sul Mac attuale; la scelta si rimanda alla Fase 1A.
- Esempio: Il Mac Studio resta acceso di notte, Arianna fa il riordino delle note alle 3:00 e alle 8:00 trovi il riassunto in chat. Se fra un anno compri un mini PC, copi la cartella di Arianna, cambi l'indirizzo nella configurazione e tutto riparte uguale.

### oq-conteggio-di-claude-p-e-codex-exec-negli-abbonam

- Contesto: Quando Arianna fa lavorare Claude Code o Codex "da soli" (senza che tu scriva nel loro terminale), usa il tuo abbonamento. Va capito se questi lavori consumano la stessa quota delle tue chat normali o un credito a parte. Per Claude si è visto che ogni lavoro riporta le finestre di 5 ore e di 7 giorni dell'abbonamento; manca un tuo controllo nell'account, e per Codex non è ancora verificato.
- Opzione consigliata: Controllo io nell'account — dopo qualche lavoro; Guardi la pagina dell'utilizzo prima e dopo un paio di lavori e scrivi qui cosa cambia; Claude regola di conseguenza i limiti di Arianna.
- Opzione: Consideriamo la quota condivisa — si dà per scontato che consumi la stessa quota (ipotesi prudente); la riga si chiude per Claude e Codex si verifica al task 1.16.
- Opzione: Rimandiamo al task 1.16 — resta aperta finché non si lavora sull'adattatore di Codex.
- Esempio: Alle 10:00 l'account segna il 30% della finestra di 5 ore; Arianna fa fare a Claude due piccole modifiche; alle 10:20 segna il 34%. Allora i lavori di Arianna pesano sulla stessa quota e conviene non lanciarne troppi di giorno.

### oq-nomi-esatti-dei-flag-di-confinamento-strict-mcp

- Contesto: Per tenere Claude Code "in una gabbia" (senza accesso a strumenti, impostazioni o file che non servono) bisognava sapere i nomi esatti delle opzioni da passargli. Questo è già stato fatto: le opzioni sono fissate per la versione 2.1.288 di Claude, sandbox compresa (D-049, D-050). La domanda è di fatto risolta.
- Opzione consigliata: Chiudila — Claude barra la riga in OPEN-QUESTIONS.md; se una versione nuova di Claude cambia le opzioni, se ne accorgono i test e si riapre.
- Opzione: Lasciala aperta come promemoria — resta nell'elenco finché non si verifica un'altra versione di Claude Code.
- Esempio: Quando Arianna lancia Claude su un progetto finto, gli passa "--strict-mcp-config" così Claude non vede gli strumenti aggiuntivi installati sul tuo Mac; un test controlla che quell'opzione ci sia sempre.

### oq-omlx-puo-puntare-a-data-models

- Contesto: oMLX è il programma che fa girare sul Mac i modelli di intelligenza artificiale locali. Arianna tiene i modelli nella sua cartella data/models, così è facile spostarli o salvarli. Va verificato se oMLX può leggerli direttamente da lì: il suo manuale dice di sì con un'opzione apposita, ma non è stato ancora provato.
- Opzione consigliata: Provare l'opzione --model-dir — se funziona, i modelli stanno solo in data/models e oMLX li legge lì: una sola copia, niente spazio sprecato.
- Opzione: Usare collegamenti simbolici — se l'opzione non funziona, nella cartella di oMLX si mettono dei "collegamenti" che puntano a data/models: funziona, ma è un pezzo in più da mantenere.
- Opzione: Modelli nella cartella di oMLX — nessun lavoro ora, ma backup e spostamenti di Arianna non includono i modelli.
- Esempio: Il modello da 15 GB sta in data/models/qwen-27b. Avviando "omlx serve --model-dir data/models" oMLX lo trova lì; senza, dovresti tenerne una seconda copia da 15 GB nella cartella di oMLX.

### oq-omlx-invia-telemetria-o-contenuti-fuori-dalla-ma

- Contesto: oMLX fa girare i modelli locali e quindi vedrà i tuoi dati privati (L2, quelli che non devono mai uscire dal Mac). Il suo manuale non dice se manda statistiche d'uso ("telemetria") o altro su internet. Prima di dargli dati veri va controllato, guardando il codice o il traffico di rete.
- Opzione consigliata: Verificare prima dei dati veri — si controllano codice e traffico di rete entro la fine della Fase 1A; fino ad allora oMLX vede solo dati finti e resta raggiungibile solo dal Mac stesso.
- Opzione: Bloccarlo anche con il firewall — in più alla verifica, si impedisce a oMLX di uscire su internet: più sicuro, ma va sbloccato per scaricare modelli nuovi.
- Opzione: Fidarsi del manuale — nessun lavoro, ma un'uscita nascosta dei dati privati non verrebbe scoperta.
- Esempio: Si avvia oMLX, gli si fa riassumere una nota finta e intanto un programma che sorveglia la rete (come Little Snitch) mostra se tenta di collegarsi a indirizzi esterni. Se non c'è nessun tentativo, la riga si chiude.

### oq-codex-con-provider-locale-invia-telemetria-o-con

- Contesto: Codex, l'assistente di programmazione di OpenAI, può lavorare con un modello locale invece che con quello nel cloud. Anche così potrebbe mandare statistiche o pezzi di testo ai server di OpenAI. Finché non lo si verifica, Arianna lo tratta come un esecutore cloud: niente dati privati.
- Opzione consigliata: Trattarlo come cloud — finché non è verificato; Nessun rischio: Codex riceve solo dati che possono uscire (L0/L1); la verifica si fa al task 1.16.
- Opzione: Verificarlo subito — si controlla ora il traffico di rete di Codex con un modello locale; se non esce nulla, potrebbe lavorare anche su progetti privati.
- Opzione: Non usare Codex con modelli locali — la questione si chiude: Codex resta solo come esecutore cloud.
- Esempio: Chiedi a Codex di sistemare un file di un progetto privato. Finché la riga è aperta, Arianna lo rifiuta e propone il modello locale; dopo una verifica positiva potrebbe permetterlo.

### oq-codice-clienti-con-nda

- Contesto: Se lavori su codice di clienti con un accordo di riservatezza (NDA), potrebbe essere vietato mandarlo a servizi cloud come Claude o Codex. Finché non hai letto i contratti, la proposta è trattare quel codice come privato (L2): lo vedono solo i modelli locali.
- Opzione consigliata: Privato (L2) per ora — finché non leggi i contratti; Il codice dei clienti non va mai al cloud; i modelli locali possono lavorarci, più lenti ma sicuri.
- Opzione: Decido cliente per cliente — per ogni progetto indichi tu il livello dopo aver letto il suo contratto: più lavoro iniziale, più libertà dove il contratto lo permette.
- Opzione: Non metto codice dei clienti in Arianna — nessun rischio, ma Arianna non ti aiuta su quei progetti.
- Esempio: Aggiungi il progetto "gestionale-rossi" (cliente inventato). Se chiedi "fai correggere il bug a Claude", Arianna risponde che il progetto è privato e propone il modello locale; se il contratto lo permette, cambi l'etichetta e Claude può lavorarci.

### oq-remote-git-github-privato-nas-nessuno

- Contesto: Il codice di Arianna è salvato con git, che tiene la storia delle modifiche. Un "remoto" è una copia di quella storia su un'altra macchina, utile come backup. Si può tenerla su GitHub (privato, nel cloud), sul NAS di casa o da nessuna parte. La proposta è NAS o nessuno all'inizio.
- Opzione consigliata: NAS o nessuno all'inizio — la storia del codice non esce di casa; il NAS fa da copia di sicurezza. I controlli automatici remoti (CI) restano facoltativi.
- Opzione: GitHub privato — copia nel cloud raggiungibile da ovunque e controlli automatici gratuiti; il codice (non i tuoi dati, che stanno fuori da git) è su un servizio esterno.
- Opzione: Nessun remoto — zero configurazione, ma se il disco del Mac si rompe la storia del codice si perde.
- Esempio: A fine giornata un "git push" copia gli ultimi commit sul NAS. Se il Mac si guasta, sul Mac nuovo scarichi tutto dal NAS e riprendi dal punto esatto.

### oq-pgvector-al-posto-di-qdrant

- Contesto: Per cercare nei tuoi documenti "per significato" (non solo per parole uguali) serve un archivio di vettori, cioè numeri che rappresentano il senso dei testi. Si può usare pgvector, un'aggiunta al database PostgreSQL che Arianna ha già, oppure Qdrant, un servizio separato. La proposta è pgvector, salvo che la memoria Mem0 richieda Qdrant.
- Opzione consigliata: pgvector nel database che c'è già — un servizio in meno da avviare, aggiornare e salvare nel backup; tutto sta in PostgreSQL.
- Opzione: Qdrant — più veloce su archivi molto grandi e richiesto da alcuni strumenti, ma è un programma in più da far girare.
- Opzione: Decidere all'inizio della Fase 2 — nessun lavoro ora; si sceglie quando si costruisce la ricerca nei documenti.
- Esempio: Cerchi "quella nota sul preventivo del tetto" e la nota si intitola "Lavori copertura, offerta ditta Bianchi". La ricerca per significato la trova lo stesso; con pgvector è una semplice interrogazione al database di Arianna.

### oq-editor-della-knowledge-base

- Contesto: La knowledge base è la raccolta delle tue note e documenti che Arianna legge e riordina. Serve un programma con cui aprirle e scriverle a mano. La proposta è Obsidian: lavora su semplici file di testo nella cartella, senza mandarli nel cloud.
- Opzione consigliata: Obsidian all'inizio — apri la cartella delle note in Obsidian e le vedi con collegamenti e grafo; Arianna e Obsidian lavorano sugli stessi file.
- Opzione: Solo le pagine di Arianna — niente programma in più: leggi e scrivi le note da "Pensieri" e "Conoscenza" nella chat web.
- Opzione: Un altro editor (es. VS Code) — funziona perché sono file di testo, ma senza le comodità pensate per le note.
- Esempio: Arianna salva in kb/inbox la nota "Idea: corso di fotografia a novembre". Aprendo Obsidian la trovi già lì, aggiungi due righe e un collegamento a "Hobby", e Arianna alla prossima lettura vede la modifica.

### oq-fonti-e-persone-per-il-mentor

- Contesto: Il Mentor è l'agente della Fase 5 che ti aiuta a studiare e crescere partendo da autori e fonti di cui ti fidi. Per costruirlo servono 10-15 nomi di persone o fonti "primarie" (libri, corsi, siti originali, non riassunti di altri). Non è urgente: serve in Fase 5.
- Opzione consigliata: Lista quando arriva la Fase 5 — nessun lavoro ora; la domanda resta in elenco come promemoria.
- Opzione: Scrivo ora qualche nome — Claude li annota nella proposta del Mentor, così sono pronti quando si comincia.
- Opzione: Claude propone una lista da approvare — più rapido per te, ma le fonti scelte da altri possono non rispecchiare i tuoi interessi.
- Esempio: "i saggi di Paul Graham sul suo sito, il libro 'Pensieri lenti e veloci', un corso introduttivo di statistica". Il Mentor ti propone letture e domande di ripasso partendo da lì.

### oq-stt-tts-italiani

- Contesto: STT è il riconoscimento della voce (da parlato a testo), TTS la sintesi (da testo a voce). Per parlare con Arianna in italiano servono modelli locali buoni per entrambe le cose. La proposta è provarne 2-3 con la tua voce; una pagina di provino esiste già (D-066, D-067, D-068).
- Opzione consigliata: Faccio il provino con la mia voce — usi la pagina di provino, ascolti e scegli i modelli migliori; Claude li fissa nel catalogo per la Fase 4.
- Opzione: Lascio scegliere a Claude dalle misure — si sceglie in base a velocità ed errori misurati, senza il tuo ascolto: più rapido, ma la voce potrebbe non piacerti.
- Opzione: Rimandiamo all'inizio della Fase 4 — nessun lavoro ora.
- Esempio: Leggi la frase "Ricordami di chiamare l'idraulico giovedì alle nove" e confronti i testi trascritti da tre modelli; poi ascolti tre voci che leggono "Hai tre email importanti" e scegli quella più naturale.

### oq-numero-e-operatore-telefonico

- Contesto: Nella Fase 4 Arianna potrà chiamarti su un telefono vero. Per farlo serve un numero e un operatore che permetta di collegarlo a un programma (telefonia via internet, VoIP/SIP). La proposta è decidere solo dopo aver confrontato costi e qualità.
- Opzione consigliata: Decidere dopo il confronto — confronto di costi e qualità; Claude prepara una tabella di 2-3 operatori con prezzi e qualità; tu scegli in Fase 4.
- Opzione: Solo chiamate via internet — niente numero; Arianna ti chiama dentro la sua app (già possibile con D-066): gratis, ma servono connessione e app.
- Opzione: Scelgo subito un operatore — si può provare prima, ma si paga un numero che per ora non serve.
- Esempio: Un operatore VoIP con un numero a 1 euro al mese e 2 centesimi al minuto; Arianna ti chiama ogni mattina alle 8 per un minuto di riepilogo, circa 60 centesimi al mese di chiamate.

### oq-licenza-degli-sprite-di-pixel-agents-jik-a-4-met

- Contesto: Gli sprite sono le immagini dei personaggi in pixel. Quelli del progetto pixel-agents (autori JIK-A-4 e Metro City) vanno bene per uso personale, ma non per condividere la cartella. Nel frattempo Arianna ha personaggi originali suoi (D-060), quindi il problema potrebbe essere già superato. La consigliata si scosta dalla riga della tabella ("uso personale ok, sostituirli prima di condividere"), scritta prima dei personaggi originali.
- Opzione consigliata: Chiudila, uso i personaggi originali — Claude verifica che nel repository non sia rimasto nessuno sprite di pixel-agents e barra la riga.
- Opzione: Tenere gli sprite (uso personale) — vanno bene finché la cartella non si condivide; prima di condividerla vanno tolti.
- Opzione: Comprare un pacchetto a licenza chiara — personaggi diversi ma condivisibili; costa e va scelto lo stile.
- Esempio: Se un giorno vuoi mostrare Arianna a un amico mandandogli la cartella, con i personaggi originali puoi farlo; con quelli di pixel-agents no, perché la loro licenza non lo permette.

### oq-skill-nel-formato-agentskills-io

- Contesto: Le "skill" sono istruzioni pronte che insegnano a un agente un compito (per esempio "come preparare un riassunto di riunione"). agentskills.io è un formato comune per scriverle, letto da più programmi. La proposta è verificare se lo stesso file funziona con Claude Code, Codex e Hermes, così una skill si scrive una volta sola (idea 7).
- Opzione consigliata: Verificare dentro il task 1.9 — Claude prova una skill d'esempio con i tre programmi mentre lavora sul 1.9, senza ore in più; se funziona, il formato si adotta in Fase 2.
- Opzione: Adottarlo subito — le skill nuove nascono già in quel formato, con il rischio che uno dei programmi non lo legga bene.
- Opzione: Formato proprio di Arianna — massimo controllo, ma ogni skill va riscritta per ogni programma.
- Esempio: La skill "riassumi una riunione" scritta una volta in quel formato: Claude Code e Codex la leggono allo stesso modo e producono lo stesso tipo di riassunto, invece di tenere due versioni diverse.

### oq-conferma-delle-decisioni-della-notte-del-2026-10

- Contesto: Durante la sessione notturna del 5 ottobre Claude ha applicato varie decisioni (D-077, D-079 e D-080 in parte, D-081…D-087) che restano da confermare. Ognuna ha già una sua domanda di conferma nel gruppo "Decisioni applicate da confermare", quindi questa riga è un doppione.
- Opzione consigliata: Chiudila, rispondo alle singole conferme — Claude barra la riga; le conferme si danno una per una, ciascuna con la sua spiegazione.
- Opzione: Confermale tutte in blocco — diventano tutte accettate in un colpo; più veloce, ma senza rileggerle una per una.
- Opzione: Lasciala aperta — resta come promemoria accanto alle conferme singole.
- Esempio: Invece di rispondere qui, vai a "Confermi D-083: Righe di attività salvate e rileggibili?" e rispondi "sì"; poi a D-084 rispondi "sì, ma il pulsante va spostato a destra".

### oq-D-088-come-si-porta-il-codice

- Contesto: Arianna avrà due installazioni: SVILUPPO, dove Claude lavora con dati finti, e PRODUZIONE, con i tuoi dati veri, che Claude non può leggere. Serve un modo sicuro per portare il codice nuovo dalla prima alla seconda. La proposta D-088 è un pulsante "Aggiorna" nelle Impostazioni della produzione che mostra le modifiche e chiede la tua conferma.
- Opzione consigliata: Pulsante "Aggiorna" — con un elenco da approvare; Vedi commit nuovi, migrazioni del database e dipendenze nuove; confermi tu; la produzione finisce i lavori in corso, salva il database e si aggiorna da sola.
- Opzione: Codice da GitHub dopo il push — come sopra, ma la versione arriva dal remoto: servono la rete e un push prima di ogni aggiornamento.
- Opzione: Aggiornare a mano dal terminale — nessun lavoro di sviluppo, ma ogni volta devi ricordare i comandi giusti (git pull, migrazioni, riavvio).
- Esempio: Claude finisce in sviluppo la pagina "Routine". Nella produzione premi "Aggiorna" e leggi: "3 commit nuovi, 1 migrazione del database, nessuna dipendenza nuova". Confermi, il core finisce i lavori in corso, salva il database, si aggiorna e riparte in un minuto.

### conf-D-077

- Contesto: Nelle conversazioni lunghe Arianna non rilegge più ogni volta gli ultimi 20 messaggi "a finestra mobile": parte da un punto fisso (l'ancora) e i messaggi più vecchi li riassume il modello locale in un riassunto che cresce solo in coda. Così il modello riusa il lavoro già fatto (la cache) e risponde prima. È già applicata: resta da confermare che ti va bene così.
- Opzione consigliata: Confermo — la decisione diventa "accettata" e le conversazioni lunghe restano veloci, con un riassunto dei messaggi vecchi
- Opzione: Confermo ma con soglie diverse — per esempio ancora che salta dopo 50 messaggi invece di 30: più testo originale letto, ma risposte un po' più lente
- Opzione: Rifiuto — si torna agli ultimi 20 messaggi: niente riassunti salvati, ma le conversazioni lunghe tornano più lente e Arianna dimentica del tutto i messaggi oltre i 20
- Esempio: In una conversazione di 60 messaggi sulla gita a Firenze, al messaggio 61 Arianna legge il riassunto "abbiamo scelto il treno delle 8 e un hotel vicino al Duomo" più gli ultimi messaggi, e risponde in pochi secondi invece di rielaborare tutto da capo.

### conf-D-079

- Contesto: Il catalogo "Agenzia" usa un elenco pubblico di oltre 230 ruoli pronti (agency-agents, licenza MIT) come spunto per nuovi agenti, senza lasciare a quel testo esterno il potere di scegliere strumenti o livelli di privacy. Oggi c'è solo la prima parte: un importatore in sola lettura che legge una copia fissata del catalogo e propone schede spente. Resta da confermare l'impianto (copia fissata, importatore, schede attive solo con la tua approvazione).
- Opzione consigliata: Confermo — resta l'importatore che propone schede spente; nessun agente del catalogo si attiva senza il tuo sì
- Opzione: Confermo solo l'indice — si tiene la lista consultabile dei ruoli, ma niente schede proposte finché non decidi le altre domande di D-079
- Opzione: Rifiuto — si toglie l'importatore e la copia del catalogo; gli agenti nuovi si scrivono solo a mano
- Esempio: Lanci l'importatore con "--propose" per il ruolo "Content Creator"; compare una scheda proposta e disattivata in data/agency/proposed/, con privacy al massimo L1 e niente strumenti pericolosi. Finché non la approvi, Arianna non la usa.

### conf-D-080

- Contesto: Il "second brain" è un ingresso unico per tutto ciò che vuoi ricordare: pensieri, link e note finiscono come file nella cartella kb/inbox/, sempre col livello di privacy L2 (privato) finché non lo abbassi tu. La prima parte è applicata: salvataggio istantaneo dalla chat ("/nota", "Salva in inbox") e dal terminale, senza modelli. Resta da confermare questa base.
- Opzione consigliata: Confermo — la cattura resta istantanea e privata per default; PDF, vocali e link scaricati arrivano dopo, con le loro decisioni
- Opzione: Privacy più bassa per le note di lavoro — le note nate da conversazioni di lavoro sarebbero L1: più facili da passare ai modelli cloud, ma più rischio di far uscire dati
- Opzione: Rifiuto — si toglie l'ingresso in kb/inbox/; le note si scrivono a mano nella cartella della conoscenza
- Esempio: Scrivi in chat "/nota comprare il regalo per Luca entro venerdì"; in un attimo nasce kb/inbox/2026-10-05-103000-comprare-il-regalo.md con etichetta L2, che nessun esecutore cloud può leggere.

### conf-D-081

- Contesto: Dalle Impostazioni (Prove dei modelli) puoi provare un modello locale nuovo del catalogo sugli stessi test dell'orchestratore (il "cervello" di Arianna), in sottofondo, senza fermare il modello in uso. Il risultato resta in uno storico confrontabile per modello. È applicata: resta da confermare il modo scelto da Claude di notte.
- Opzione consigliata: Confermo — la prova resta in sottofondo, un modello alla volta, con lo storico dei risultati
- Opzione: Solo dal terminale — si toglie il pulsante dalle Impostazioni e resta "pnpm eval:models --model": meno codice nel core, ma serve il terminale
- Opzione: Rifiuto — si toglie la prova dal core; i modelli nuovi si valutano solo a mano
- Esempio: Vuoi sapere se un nuovo modello da 32B è meglio di quello attuale; in Impostazioni → Prove dei modelli premi "Prova", continui a chattare normalmente e dopo mezz'ora vedi "18 casi su 20 superati" accanto ai 17 del modello di oggi.

### conf-D-082

- Contesto: Sotto ogni risposta del Coder (l'agente che scrive codice) compare una riga piccola con chi l'ha fatta, su quale modello, quanto è durata e quanto è costata, e un riquadro "File modificati" con l'elenco dei file toccati (solo i nomi, mai il contenuto). È applicata: resta da confermare.
- Opzione consigliata: Confermo — restano la riga "chi ha fatto cosa" e l'elenco dei file modificati sotto le risposte
- Opzione: Confermo ma senza il costo — la riga mostra esecutore, modello e durata, non gli euro
- Opzione: Rifiuto — si tolgono riga e riquadro; per sapere cosa è cambiato bisogna guardare il progetto a mano
- Esempio: Chiedi al Coder di correggere la pagina dei contatti; sotto la risposta leggi "Coder · Claude Code / Claude Sonnet · 2 min 5 s" e, aprendo "File modificati", vedi src/contatti.html modificato e src/stile.css aggiunto.

### conf-D-083

- Contesto: Le righe di attività ("cerco nella conoscenza", "leggo un file", "delego al Coder") prima sparivano a fine lavoro o ricaricando la pagina. Ora si salvano nel database e si possono rileggere dopo, con gli stessi filtri di privacy della riga dal vivo. È applicata: resta da confermare.
- Opzione consigliata: Confermo — le righe di attività restano rileggibili anche dopo la fine del lavoro
- Opzione: Confermo ma con scadenza — le righe si cancellano dopo un periodo (per esempio 30 giorni): meno dati conservati, ma lo storico vecchio si perde
- Opzione: Rifiuto — le righe tornano solo dal vivo e spariscono a fine lavoro
- Esempio: Ieri Arianna ha preparato un riepilogo delle spese finte di settembre; oggi riapri la conversazione e vedi ancora "Ho letto 3 note in kb/spese" e "Ho delegato al Coder", anche dopo aver ricaricato la pagina.

### conf-D-084

- Contesto: Una serie di piccole rifiniture della chat web scelte da Claude di notte: pulsante "Copia" sui blocchi di codice, "Salva in inbox" sotto i messaggi, intestazione delle chat di sistema e indice delle Impostazioni. È applicata: resta da confermare il pacchetto.
- Opzione consigliata: Confermo — le rifiniture restano come sono
- Opzione: Confermo tranne alcune — scrivi quali togliere o cambiare (per esempio "Salva in inbox" solo sui tuoi messaggi)
- Opzione: Rifiuto — si tolgono le rifiniture e la chat torna com'era prima di D-084
- Esempio: Il Coder ti risponde con un comando in un blocco di codice; premi "Copia" in alto a destra del blocco, compare "Copiato" per 2 secondi e lo incolli nel terminale senza selezionarlo a mano.

### conf-D-085

- Contesto: Quando il gateway (il controllo di privacy che decide cosa può uscire) blocca un testo perché contiene un segreto della cassaforte o non si riesce a controllare, Arianna si ferma e ti chiede cosa fare, invece di continuare in silenzio con il modello locale. Il codice faceva già così: si è corretta la specifica scritta per allinearla. Resta da confermare questo comportamento.
- Opzione consigliata: Confermo — dopo un blocco per segreto o testo non controllabile Arianna si ferma e ti avvisa
- Opzione: Continuare in locale — il lavoro prosegue col modello locale senza chiederti nulla: meno interruzioni, ma un segreto finito in un testo potrebbe passare inosservato
- Esempio: Incolli per errore una password di prova, che sta nella cassaforte, dentro una richiesta per il Coder; il gateway la riconosce, il lavoro si ferma e in chat vedi che serve una tua decisione perché il testo contiene un segreto.

### conf-D-086

- Contesto: Ogni nota salvata in kb/inbox/ viene poi riordinata dal modello locale (titolo, riassunto, collegamenti), con il tuo testo originale lasciato sotto il riassunto. La cattura resta istantanea: il riordino avviene dopo, in coda. È la parte "motore" dei Pensieri ed è applicata: resta da confermare.
- Opzione consigliata: Confermo — le note si riordinano da sole col modello locale, con l'originale sempre sotto
- Opzione: Riordino solo su richiesta — la nota resta grezza finché non premi "Riordina": meno lavoro per il Mac, ma più passaggi per te
- Opzione: Rifiuto — niente riordino automatico; le note restano come le scrivi
- Esempio: Salvi "idea: app per prenotare il campo da padel con gli amici, chiedere a Marco"; poco dopo la nota ha titolo "App per prenotare il padel", un riassunto di due righe, un collegamento alla nota "Sport" e sotto il tuo testo originale.

### conf-D-087

- Contesto: La sezione "Conoscenza" della chat mostra le note della tua base di conoscenza (kb/) come un grafo: ogni nota è un punto, ogni collegamento una linea. Non mostra mai pagine con privacy L3 (la più alta). È applicata: resta da confermare.
- Opzione consigliata: Confermo — la sezione Conoscenza resta con il grafo delle note
- Opzione: Solo come elenco — al posto del grafo un elenco di note con i collegamenti: più sobrio, meno "visivo"
- Opzione: Rifiuto — si toglie la sezione Conoscenza dalla chat
- Esempio: Apri Conoscenza e vedi la nota "Viaggio in Portogallo" al centro, collegata a "Lisbona", "Budget viaggi" e "Voli"; cliccando "Lisbona" la leggi a lato senza uscire dalla pagina.

### conf-D-087b

- Contesto: Seguito della sezione Conoscenza: con il tema scuro è una "sala di controllo" nera a schermo intero con il grafo sempre in leggero movimento; con il tema chiaro usa lo sfondo normale e un pulsante "Sfondo scuro" accende il nero, scelta ricordata nel browser. È applicata: resta da confermare.
- Opzione consigliata: Confermo — sfondo che segue il tema, nero a scelta col tema chiaro, grafo animato
- Opzione: Grafo fermo — niente animazione continua: meno movimento e meno lavoro per il computer, ma un effetto meno "vivo"
- Opzione: Sempre nero — sala di controllo nera anche col tema chiaro, come la prima versione
- Esempio: Di sera col tema scuro apri Conoscenza e trovi il grafo su fondo nero che "respira" piano; di giorno col tema chiaro lo vedi su sfondo chiaro e, se vuoi l'effetto notturno, premi "Sfondo scuro".

### conf-D-089

- Contesto: La parte invisibile (il backend, cioè il core) della barra sinistra nuova: ricerca in conversazioni, messaggi e note, conversazioni fissate in alto, salvataggio in inbox una volta sola per messaggio e informazioni sull'installazione (sviluppo o produzione, versione del codice). È applicata: resta da confermare.
- Opzione consigliata: Confermo — restano ricerca, conversazioni fissate, salvataggio unico e informazioni sull'installazione
- Opzione: Ricerca senza le note — si cerca solo nelle conversazioni: risultati più puliti, ma le note di kb/ si cercano altrove
- Opzione: Rifiuto — si tolgono queste funzioni e la barra sinistra torna a un semplice elenco
- Esempio: Scrivi "dentista" nella ricerca della barra sinistra e trovi la conversazione "Appuntamenti" e una nota in inbox del mese scorso; poi fissi "Appuntamenti" in alto per ritrovarla subito.

### conf-D-090

- Contesto: La pagina "Pensieri" è un posto per scrivere pensieri al volo e ritrovarli riordinati; il microfono c'è ma non è ancora attivo. Nella chat, scrivendo "/" si apre un menu di comandi come in Claude Code. È applicata: resta da confermare.
- Opzione consigliata: Confermo — restano la pagina Pensieri e il menu "/" della chat
- Opzione: Senza il microfono spento — il microfono si mostra solo quando la voce funziona davvero: niente pulsanti inattivi in pagina
- Opzione: Rifiuto — si toglie la pagina Pensieri; resta solo "/nota" in chat
- Esempio: Apri Pensieri, scrivi "regalare a mamma un corso di ceramica" e premi ⌘+Invio; dopo poco il pensiero compare nell'elenco con un titolo e un riassunto. In chat, digitando "/", vedi "/nota", "/nuova" e gli altri comandi.

### conf-D-091

- Contesto: Nel pannello di stato una riga "Arianna aspetta una tua decisione" apre una finestra con tutte le approvazioni in sospeso di tutte le conversazioni, dalla più vecchia. Inoltre il motivo per cui il router (la parte che sceglie chi esegue un lavoro) ha fatto la sua scelta ora è scritto in italiano. È applicata: resta da confermare.
- Opzione consigliata: Confermo — resta la finestra unica delle decisioni in attesa e il motivo del router in italiano
- Opzione: Decidere direttamente dalla finestra — approvare o rifiutare senza aprire la conversazione: più veloce, ma decidi senza vedere il contesto della chat
- Opzione: Rifiuto — si toglie la finestra; le approvazioni si trovano solo dentro ogni conversazione
- Esempio: Hai tre conversazioni aperte e in una il Coder chiede il permesso di spendere 0,50 euro; nel pannello vedi "Arianna aspetta una tua decisione", la apri e trovi "Budget · Sito del circolo di tennis", con il collegamento alla conversazione.

### conf-D-092

- Contesto: Alcuni modelli locali (per esempio Gemma) non accettano due messaggi di fila dello stesso tipo, come due tuoi messaggi consecutivi. Prima di mandarli al modello locale, Arianna li unisce in uno solo, separati da una riga vuota; il controllo di privacy li vede comunque uno per uno. È applicata: resta da confermare.
- Opzione consigliata: Confermo — i messaggi consecutivi si uniscono prima del modello locale, senza cambiare cosa controlla il gateway
- Opzione: Unire solo dove serve — solo per i modelli che lo richiedono; più fedele per gli altri modelli, ma una regola in più da mantenere
- Opzione: Rifiuto — i messaggi restano separati e i modelli come Gemma non si possono usare come orchestratore
- Esempio: Scrivi "prenota il ristorante" e subito dopo "per 4 persone, sabato"; il modello locale riceve un solo messaggio con le due righe e risponde senza errori.

### conf-D-100

- Contesto: Correzione di un errore: quando il Mac si avviava, il modello locale non era ancora pronto e tutte le note da riordinare fallivano per sempre in pochi millisecondi. Ora, se il modello non è pronto, il riordino riprova più tardi invece di arrendersi. È applicata: resta da confermare.
- Opzione consigliata: Confermo — il riordino delle note aspetta e riprova finché il modello locale non è pronto
- Opzione: Riprova solo a mano — dopo un fallimento compare "Riordina di nuovo" e decidi tu: niente tentativi automatici, ma note che restano grezze finché non intervieni
- Esempio: Accendi il Mac alle 8 e il modello locale impiega 3 minuti a partire; le 5 note salvate ieri sera restano in coda e alle 8:04 risultano tutte riordinate, invece di restare "Non riordinato".

### conf-D-101

- Contesto: Arianna (l'orchestratore locale) può aggiornare le carte di lavoro della conversazione, per esempio spostarle o segnarle in attesa, ma solo se all'inizio del lavoro c'è almeno una carta aperta. Da confermare soprattutto le regole di autonomia: con A0 (nessuna autonomia) nessuna mossa, con A1 niente spostamento in "Pronti" salvo le proprie attese.
- Opzione consigliata: Confermo — Arianna aggiorna le carte con queste regole di autonomia
- Opzione: Solo proposte — Arianna suggerisce lo spostamento e lo fai tu: più controllo, ma più clic
- Opzione: Rifiuto — si toglie lo strumento; le carte le aggiorni solo tu
- Esempio: Nella conversazione "Trasloco" c'è la carta "Chiedere preventivi"; quando dici "ho mandato le richieste a tre ditte", Arianna sposta la carta in "In attesa" con la nota "aspetto i preventivi", senza segnarla come finita.

### conf-D-104

- Contesto: Nella sezione Conoscenza un interruttore 2D/3D permette di navigare il grafo delle note come una galassia in tre dimensioni, ruotandolo e avvicinandoti. La scelta resta ricordata nel browser. Da confermare in particolare che la vista predefinita resti 2D.
- Opzione consigliata: Confermo con 2D predefinito — la pagina si apre in 2D e passi al 3D quando vuoi
- Opzione: 3D predefinito — la pagina si apre già come galassia: più spettacolare, ma più pesante per il computer e meno leggibile a colpo d'occhio
- Opzione: Rifiuto — si toglie il 3D e resta solo il grafo piatto
- Esempio: Apri Conoscenza, premi "3D" e trascinando il mouse fai ruotare le note intorno a "Progetti 2026"; la volta dopo la pagina si riapre in 3D perché il browser ricorda la scelta.

### conf-D-098

- Contesto: In alto, accanto all'orologio, c'è sempre l'etichetta SVILUPPO (gialla) o PRODUZIONE (verde), e in sviluppo il titolo della scheda del browser comincia con "[DEV]". Serve a non confondere due installazioni aperte una accanto all'altra. È applicata: resta da confermare.
- Opzione consigliata: Confermo — l'etichetta resta sempre visibile e i titoli in sviluppo iniziano con [DEV]
- Opzione: Etichetta solo in sviluppo — in produzione niente etichetta: barra più pulita, ma meno chiaro dove sei
- Opzione: Rifiuto — l'etichetta si vede solo nelle Impostazioni
- Esempio: Hai aperte due schede, una con i dati finti di sviluppo e una con l'installazione vera; prima di cancellare una conversazione guardi in alto e vedi "SVILUPPO" in giallo, quindi sai di essere su quella di prova.

### conf-D-099

- Contesto: Sotto ogni messaggio della chat c'è una piccola barra di azioni ("Copia" e "Salva in inbox") che compare solo passando col mouse sul messaggio; sul telefono è sempre visibile. "Salva in inbox" funziona una volta sola per messaggio, senza doppioni. È applicata: resta da confermare.
- Opzione consigliata: Confermo — azioni visibili al passaggio del mouse, salvataggio una volta sola
- Opzione: Azioni sempre visibili — più facili da trovare, ma ripetute sotto ogni messaggio
- Opzione: Rifiuto — si torna al solo "Salva in inbox" fisso sotto i messaggi
- Esempio: Passi il mouse sulla risposta di Arianna con la lista della spesa, premi "Copia" e la incolli nelle note del telefono; premi "Salva in inbox" e il pulsante diventa "Salvato", così non crei una seconda copia.

### conf-D-105

- Contesto: Le Impostazioni sono a due colonne: a sinistra l'indice delle sezioni, a destra solo la sezione scelta, con un indirizzo proprio (per esempio /impostazioni/voce), così ricarica e "indietro" funzionano. Ha sostituito la pagina lunga da scorrere. È applicata: resta da confermare.
- Opzione consigliata: Confermo — le Impostazioni restano a due colonne, una sezione alla volta
- Opzione: Con una ricerca nell'indice — un campo per trovare un'impostazione per nome: comodo quando le sezioni crescono, ma un pezzo in più
- Opzione: Rifiuto — si torna alla pagina unica da scorrere
- Esempio: Vuoi cambiare il modello locale; apri Impostazioni, clicchi "Modelli locali" a sinistra e a destra compare solo quella sezione; ricaricando la pagina resti lì.

### conf-D-108

- Contesto: Come in Claude Code, premere "Nuovo" apre solo una bozza vuota nella pagina: la conversazione nasce davvero, e compare nella lista, solo quando invii il primo messaggio. Così non restano conversazioni vuote. È applicata: resta da confermare.
- Opzione consigliata: Confermo — una conversazione nasce solo con il primo messaggio
- Opzione: Rifiuto — "Nuovo" crea subito la conversazione nella lista, anche se poi non scrivi nulla
- Esempio: Premi "Nuovo", scegli "Lavoro" e il progetto "Sito del circolo", poi cambi idea e chiudi; nella lista non compare nessuna conversazione vuota. Se invece scrivi "aggiorna gli orari", la conversazione appare in cima.

### conf-D-109

- Contesto: Un'attesa vecchia (un lavoro fermo ad aspettare una tua risposta) si chiude da sola quando scrivi un messaggio nuovo nella stessa conversazione, e nella finestra "Decisioni in attesa" c'è un pulsante "Chiudi" per toglierla a mano. Le approvazioni vere (spese, azioni esterne) restano finché non decidi.
- Opzione consigliata: Confermo — le attese superate si chiudono col messaggio nuovo e con "Chiudi"
- Opzione: Solo "Chiudi" a mano — niente chiusura automatica: nessuna attesa sparisce senza che tu lo veda, ma la finestra si riempie di cose vecchie
- Opzione: Rifiuto — le attese restano finché il lavoro non finisce da solo
- Esempio: Nella conversazione "Saluti di prova" un lavoro aspettava una tua risposta da due giorni; scrivi un messaggio nuovo, l'attesa vecchia si chiude e sparisce da "Decisioni in attesa", mentre la richiesta di budget di un'altra chat resta lì.

### conf-D-106b

- Contesto: La prima tappa dell'ufficio pixel è fatta: una pagina "Ufficio" dove gli agenti sono personaggi in pixel art in una mappa (stanza privata, isole dei progetti, area decisioni, pausa), disegnata con un motore nostro senza librerie esterne. Resta da confermare questa tappa prima delle successive.
- Opzione consigliata: Confermo — l'ufficio resta così e si può pensare alla tappa 2
- Opzione: Confermo ma fermo qui — la pagina resta, ma le tappe successive aspettano la fine della Fase 1A
- Opzione: Rifiuto — si toglie la pagina Ufficio dalla chat
- Esempio: Apri Ufficio mentre il Coder lavora sul "Sito del circolo"; vedi il suo personaggio seduto all'isola di quel progetto, e Arianna nell'area decisioni quando aspetta una tua approvazione.

### conf-D-118

- Contesto: Nella pagina Agenti puoi scaricare il foglio PNG di un personaggio pixel, modificarlo con un programma di disegno e ricaricarlo; il core controlla dimensioni e peso, pulisce l'immagine e la salva fra i tuoi personaggi. Resta da chiarire cosa intendevi con "aggiungerli": personaggi nuovi da dare agli agenti esistenti, o agenti nuovi.
- Opzione consigliata: Personaggi nuovi — "Carica PNG" con un nome nuovo aggiunge un personaggio da assegnare a un agente esistente
- Opzione: Agenti nuovi — caricare un personaggio crea anche un agente nuovo: serve poi definire cosa fa quell'agente
- Opzione: Entrambe le cose — personaggi nuovi subito, agenti nuovi con una decisione a parte
- Esempio: Scarichi il PNG del Coder, gli disegni gli occhiali con un programma di pixel art e lo ricarichi come "Coder occhiali"; poi lo assegni al Coder e nell'Ufficio compare il personaggio nuovo.

### ho-pagina-impostazioni-d-071-2026-10-04

- Contesto: La pagina Impostazioni (D-071) è finita in tutte e cinque le parti e i suoi rami task/3.5-impostazioni e p4-chiamate sono già dentro main. Resta solo una prova tua: aprire la pagina, salvare qualcosa e usare il pulsante "Riavvia oMLX" (oMLX è il programma che fa girare i modelli locali), che Claude non ha provato dal vivo.
- Opzione consigliata: Provo la pagina e il riavvio di oMLX — se funziona la riga si chiude; se qualcosa non va scrivi cosa hai visto e Claude lo corregge.
- Opzione: Già provata, va bene — Claude toglie la riga da HANDOFF senza altre prove.
- Opzione: Non ora — la riga resta in attesa; la pagina si usa lo stesso.
- Esempio: In Impostazioni spegni il modello "Opus" nei modelli cloud, salvi, lo riaccendi, poi premi "Riavvia oMLX" e controlli che dopo circa 15 secondi lo stato torni "acceso".

### ho-stato-di-arianna-per-conversazione-fatto-il-2026

- Contesto: Non è una domanda: è una nota di un lavoro già fatto il 2026-10-04 (l'intestazione della chat mostra lo stato della sola conversazione aperta). È finita fra le cose in attesa per errore.
- Opzione consigliata: Già fatto, togli la riga — Claude la sposta fra le cose fatte e non la vedi più qui.
- Opzione: Voglio cambiare qualcosa — scrivi cosa: Claude apre un task nuovo.
- Esempio: Se in una conversazione Arianna lavora e in un'altra no, l'intestazione della seconda dice "Qui con te" e non "Sta pensando…".

### ho-secondo-provino-della-voce-d-067-d-068

- Contesto: Arianna deve avere una voce per le chiamate. Nel provino (una pagina dove ascolti più voci sintetiche) ti era piaciuta Qwen3-TTS; resta da scegliere la voce esatta. La configurazione attuale usa già Qwen3-TTS, quindi forse è fatto. I modelli scartati occupano spazio (Voxtral 8 GB).
- Opzione consigliata: Riascolto e scelgo la voce — Claude scrive la scelta nella configurazione, riavvia il core e cancella i modelli scartati, liberando circa 8 GB.
- Opzione: Va bene quella di adesso — Claude chiude la riga e cancella solo i modelli scartati.
- Opzione: Rinvio — la riga resta; i modelli scartati restano su disco.
- Esempio: Nel provino ascolti la frase "Buongiorno, oggi hai tre appuntamenti" con due voci e scrivi "la seconda, un po' più lenta".

### ho-latenza-delle-chiamate-passi-1-2-e-4-fatti-d-070

- Contesto: In una chiamata passano 2,3-2,8 secondi fra la fine della tua domanda e la risposta di Arianna. Due accorciamenti (D-072 storia più corta, D-073 fine del turno dopo 0,6 secondi di silenzio invece di 0,8) sono applicati ma aspettano la tua conferma. Il rischio di D-073 è che Arianna ti interrompa se fai una pausa.
- Opzione consigliata: Provo una chiamata e confermo — dici se il tempo va bene e se ti taglia mentre pensi; Claude conferma D-072 e D-073 o allunga il silenzio.
- Opzione: Confermo senza prova — D-072 e D-073 diventano accettate; eventuali problemi si vedranno più avanti.
- Opzione: Continuare ad accorciare — Claude fa anche il passo 3 (primo pezzo di voce più corto) e il 5 (un "Mm, vediamo…" registrato mentre il modello pensa).
- Esempio: Chiedi "Che tempo fa domani a Torino?", fai una pausa a metà frase di mezzo secondo e guardi se Arianna risponde prima che tu abbia finito.

### ho-voci-copiate-d-069-fatte

- Contesto: Già fatto: il provino ha una sezione "Voci copiate" dove registri una voce (con il consenso della persona) o carichi un tuo file. La riga è rimasta come promemoria.
- Opzione consigliata: Già fatto, togli la riga — sparisce da qui; la sezione nel provino resta.
- Opzione: Voglio ancora provarla — la riga resta finché non dici com'è andata.
- Esempio: Registri 20 secondi di una persona che legge un testo inventato e ascolti Arianna dire "Ciao, sono pronta" con quella voce.

### ho-voci-copiate-storia

- Contesto: È solo la storia della scelta precedente (perché si usano modelli locali e non il servizio cloud Fish Audio, e perché Claude non ritaglia voci di attori da film). La decisione è già stata presa e applicata (D-069): non c'è nulla da rispondere.
- Opzione consigliata: Già chiusa, togli la riga — la storia resta in DECISIONS.md, qui non compare più.
- Opzione: Voglio la voce descritta a parole — Claude propone una decisione nuova per una voce tipo "Jarvis" creata da una descrizione, senza copiare nessuno.
- Esempio: Invece di copiare un attore, scrivi "voce maschile calma, britannica, leggermente ironica" e il modello ne crea una nuova.

### ho-prova-delle-chiamate-d-066

- Contesto: Le chiamate via internet dalla chat (D-066) sono già dentro main. Manca una prova tua: chiamare Arianna dal pulsante del telefono in cima alla chat, con oMLX acceso. Le notifiche push (il telefono che squilla anche a pagina chiusa) sono facoltative.
- Opzione consigliata: Faccio una chiamata di prova — dici com'è andata; Claude chiude la riga o corregge.
- Opzione: Prova fatta, va bene — Claude toglie la riga.
- Opzione: Voglio anche le notifiche push — Claude ti guida con pnpm voice:vapid (crea una coppia di chiavi, la privata va nel vault).
- Esempio: Premi il telefono nell'intestazione, dici "Quali task ho aperti?" e controlli che Arianna risponda a voce in pochi secondi.

### ho-omlx

- Contesto: Già fatto: dal 2026-10-04 il core avvia, riavvia e ferma oMLX da solo. Resta un solo dubbio: una seconda copia di prova di oMLX sulla porta 7002, accesa a mano in una vecchia sessione, che consuma memoria.
- Opzione consigliata: Fermala e togli la riga — Claude ferma l'istanza sulla 7002 se c'è ancora e chiude la riga; la memoria torna libera.
- Opzione: Lasciala accesa — la riga si chiude ma la copia resta a usare memoria.
- Esempio: Se il Mac ha 64 GB e quella copia tiene caricato un modello da 16 GB, fermarla libera quei 16 GB per i modelli che usa Arianna.

### ho-git-push-di-main-a-ogni-task-chiuso-ora-7-commit

- Contesto: Claude non può fare push (mandare i commit al repository remoto): lo fai tu. main è avanti di 7 commit rispetto al remoto. Inoltre sul remoto restano rami già uniti a main (task/0.3-postgres, task/1.6-confinement, task/1.15-telegram, task/1.18-wizard, task/1.10-orchestrator) che si possono cancellare.
- Opzione consigliata: Faccio push e cancello i rami vecchi — il remoto è allineato e l'elenco dei rami si accorcia; nulla si perde perché sono già in main.
- Opzione: Solo il push — il codice è al sicuro sul remoto; i rami vecchi restano.
- Opzione: Più avanti — il remoto resta indietro: se il Mac si rompe, gli ultimi commit esistono solo qui.
- Esempio: Git push origin main, poi git push origin --delete task/0.3-postgres (e così per gli altri rami).

### ho-permessi-in-claude-settings-json

- Contesto: Volevi che Claude lavorasse senza chiederti conferme a ogni modifica. Claude non può cambiare da solo i propri permessi (sarebbe un'auto-concessione), quindi il file .claude/settings.json va modificato da te. Oggi non contiene ancora la modalità proposta.
- Opzione consigliata: Incollo la proposta di Claude — modifiche ai file senza conferma, ma installare pacchetti e cambiare git globale chiedono sempre; l'hook blocca anche se va in errore.
- Opzione: Lascio com'è — Claude continua a chiedere conferma per molte azioni; più lento ma più controllato.
- Opzione: Voglio una versione diversa — scrivi cosa permettere o vietare; Claude prepara il testo da incollare.
- Esempio: Con la proposta, Claude modifica apps/hud/src/style.css senza chiedere, ma per "pnpm add lodash" compare comunque la tua conferma.

### ho-conferma-delle-decisioni

- Contesto: Molte decisioni vecchie (D-004 e da D-013 a D-029) sono "Proposta, applicata": Claude le ha già messe in pratica ma aspettano il tuo sì per diventare accettate. D-030 (cartella di sviluppo separata da quella dei dati veri) è invece solo una proposta. È lo stesso tema della riga "Conferma delle decisioni" di OPEN-QUESTIONS.
- Opzione consigliata: Le rivediamo una alla volta — Claude te le presenta in conversazione con una domanda ciascuna; quelle che confermi diventano accettate.
- Opzione: Confermo tutto in blocco — diventano tutte accettate subito; se una non ti va bene si cambia più avanti con una decisione nuova.
- Opzione: Rinvio — restano "applicate da confermare".
- Esempio: D-026 dice che Node esegue il TypeScript senza compilarlo; se lo confermi, in futuro non si torna indietro senza una nuova decisione.

### ho-conferma-di-d-034

- Contesto: D-034 riguarda le schede degli agenti (i file che dicono a ogni agente cosa può fare). Il punto da confermare: quando un agente passa un lavoro a un altro (delega), l'altro parte con un contesto separato e non può comunicare con l'esterno solo perché chi delega poteva.
- Opzione consigliata: Confermo — la regola diventa definitiva: una delega non allarga mai i permessi.
- Opzione: Voglio eccezioni — scrivi quali; Claude propone una decisione nuova, con il rischio di fughe di dati da valutare.
- Esempio: Il Segretario può mandare un messaggio Telegram; se delega al Coder la sistemazione di un file, il Coder non ottiene per questo il diritto di scrivere su Telegram.

### ho-conteggio-di-claude-p-nell-abbonamento

- Contesto: Quando Arianna usa Claude in automatico (claude -p) consuma lo stesso abbonamento che usi tu, nelle finestre di 5 ore e di 7 giorni. Non si sa se esista un credito separato per questo uso: lo puoi vedere solo tu nella pagina del tuo account. Lo stesso tema è in OPEN-QUESTIONS.
- Opzione consigliata: Guardo nel mio account e te lo dico — Claude scrive la risposta e chiude la riga qui e in OPEN-QUESTIONS.
- Opzione: Non importa — si assume che consumi l'abbonamento; la riga si chiude.
- Esempio: Fai lavorare il Coder per 10 minuti e poi controlli se la percentuale usata della sessione di 5 ore è salita.

### ho-conferma-di-d-047

- Contesto: D-047 è l'installer (pnpm arianna:install). Due scelte da confermare: rende privata la cartella data/ anche se esisteva già, ed esce con errore finché il controllo (doctor) non è tutto verde, anche quando l'installazione in sé è riuscita.
- Opzione consigliata: Confermo — l'installer resta severo: non dice "pronto" finché ci sono password di sviluppo o pezzi mancanti.
- Opzione: Successo se l'installazione riesce — più comodo, ma un "tutto ok" potrebbe nascondere che non è pronto per i dati veri.
- Esempio: Dopo un'installazione nuova con le password di prova, l'installer finisce con "installato, ma non pronto per i dati veri" ed esce con errore.

### ho-voci-vere-di-config-models-catalog-yaml

- Contesto: Il catalogo dei modelli (config/models.catalog.yaml) elenca i modelli locali con dimensioni e impronte di controllo (sha256, che garantiscono che il file scaricato sia quello giusto). Va completato con i modelli Qwen davvero scelti, dopo la prova di oMLX sul Mac Studio. Serve il Mac Studio, quindi non è urgente.
- Opzione consigliata: Quando arriva il Mac Studio — Claude completa il catalogo e tu assegni i modelli ai ruoli con pnpm arianna:init --reconfigure.
- Opzione: Subito, sul Mac attuale — Claude compila il catalogo con i modelli di adesso; andrà rifatto quando cambia macchina.
- Esempio: La voce di un modello dice cartella "qwen3-27b-4bit", RAM 20 GB, ruoli "orchestratore", e lo sha256 di ogni file.

### ho-conferma-di-d-048

- Contesto: D-048 è il wizard (le domande che scrivono config/arianna.toml) con il catalogo dei modelli. Le scelte di fondo le hai già fatte; restano da confermare dettagli: oMLX sulla porta 7001, il controllo che fallisce se i modelli scelti superano la memoria del Mac, la rilettura della configurazione ogni secondo.
- Opzione consigliata: Confermo — i dettagli restano come sono e D-048 diventa accettata.
- Opzione: Cambio un dettaglio — scrivi quale; Claude lo modifica.
- Esempio: Se scegli modelli che insieme chiedono 80 GB su un Mac da 64 GB, pnpm arianna:doctor fallisce e lo dice.

### ho-conferma-di-d-052

- Contesto: D-052 ha chiuso il test 1.4 scegliendo il modello locale da 27B come orchestratore (il "cervello" di Arianna), con due accorgimenti: una regola sulle virgolette nei pensieri del modello e un secondo tentativo quando la risposta non è nel formato richiesto (JSON).
- Opzione consigliata: Confermo — il 27B resta l'orchestratore con questi accorgimenti.
- Opzione: Voglio riprovare altri modelli — Claude usa la prova dei modelli (Impostazioni, Prove dei modelli) e propone un cambio se uno va meglio.
- Esempio: Se il modello risponde con testo libero invece del formato richiesto, Arianna gli richiede la stessa cosa una volta, senza la parte di ragionamento.

### ho-git-push-di-main-avanti-di-origin-main-dai-commi

- Contesto: È un promemoria vecchio di push, simile alla riga sul push a ogni task. Il ramo locale task/d-065-markdown è già dentro main, e il ramo remoto task/d-058-projects anche: si possono cancellare senza perdere nulla.
- Opzione consigliata: Faccio push e pulizia, poi togli la riga — il remoto si allinea e i rami inutili spariscono.
- Opzione: Unisci questa riga all'altra sul push — Claude tiene una sola riga per i push.
- Esempio: Git branch -d task/d-065-markdown e git push origin --delete task/d-058-projects.

### ho-chiamate-d-066-rispondere-alle-domande-rimaste-n

- Contesto: Riga vecchia: le domande sulle chiamate (D-066) e il provino con la tua voce risalgono a prima delle decisioni successive (D-067, D-068, D-069). Quasi certamente è superata dalle righe "Secondo provino della voce" e "Prova delle chiamate".
- Opzione consigliata: Superata, togli la riga — restano solo le righe più recenti su voce e chiamate.
- Opzione: Ho ancora domande sulle chiamate — scrivile qui; Claude le aggiunge come domande nuove.
- Esempio: La domanda "quale voce usare?" ora sta nella riga del secondo provino, quindi qui non serve più.

### ho-togliere-a-mano-data-scratch-review-d065

- Contesto: La cartella data/scratch/review-d065/ contiene file di prova lasciati dal revisore automatico; è fuori da git e non serve più. Claude non la cancella da solo perché le cancellazioni passano da te. Esiste ancora.
- Opzione consigliata: La cancello io — basta rm -r data/scratch/review-d065 dalla cartella del progetto; poi la riga si toglie.
- Opzione: Cancellala tu, Claude — Claude la toglie con la tua approvazione e chiude la riga.
- Opzione: Lasciala — occupa poco spazio; la riga si toglie comunque.
- Esempio: Dentro ci sono piccoli file di sonda usati per verificare un controllo di sicurezza, che nessun programma legge più.

### ho-prova-dal-vivo-di-d-058-fuori-da-arianna

- Contesto: D-058 permette al Coder (Claude che scrive codice) di lavorare su un tuo progetto. Va provato dal vivo su un progetto finto, fuori dalla cartella di Arianna. Consuma chiamate vere dell'abbonamento.
- Opzione consigliata: La faccio seguendo i prossimi passi — crei un progetto finto, lo aggiungi con il wizard e chiedi al Coder una pagina; se va bene la riga si chiude.
- Opzione: Rinvio — la riga resta; il Coder sui progetti resta non provato dal vivo.
- Esempio: Crei la cartella vuota "negozio-finto", la registri come progetto e in chat scrivi "fammi una landing page per una pasticceria inventata".

### ho-su-un-altra-macchina-pnpm-arianna-init-reconfigu

- Contesto: È un promemoria per il futuro: se usi Arianna su un altro computer, la sua vecchia configurazione con l'elenco cloud "allowlist" ora viene rifiutata e va riscritta con il wizard. Su questo Mac l'ha già convertita Claude.
- Opzione consigliata: Non ho altre macchine, togli la riga — se un giorno ne aggiungi una, il messaggio di errore spiega comunque cosa fare.
- Opzione: Ho un'altra macchina — su quella lanci pnpm arianna:init --reconfigure, poi la riga si chiude.
- Esempio: Sul portatile Arianna non parte e dice che allowlist non è più accettata; lanci il wizard e i progetti diventano blocchi [[project]].

### ho-password-vere-del-database

- Contesto: Oggi il database usa password di sviluppo, note a tutti. Prima di mettere dati veri vanno cambiate, ma solo dopo il criterio di uscita della Fase 1A. Non è ancora il momento.
- Opzione consigliata: Più avanti, a fine Fase 1A — la riga resta come promemoria; Claude te la ricorda quando la fase si chiude.
- Opzione: Subito — segui i passi di SECURITY.md (password nuova con psql, poi pnpm db:migrate e pnpm arianna:doctor); lo sviluppo continua con le nuove.
- Esempio: Con le password di sviluppo pnpm arianna:doctor resta rosso; dopo il cambio diventa verde su quel punto.

### ho-chiave-age-vera

- Contesto: Il vault (la cassaforte cifrata dei segreti) usa una chiave age: un file che apre i segreti. Quella vera la generi tu e solo tu la tieni, ma va fatta solo dopo il criterio della Fase 1A. Non è ancora il momento.
- Opzione consigliata: Più avanti, a fine Fase 1A — la riga resta come promemoria.
- Opzione: Subito, come eccezione — sarebbe un'eccezione alla regola delle fasi (prima il criterio della Fase 1A): la generi con i passi di SECURITY.md (sezione Vault) e la conservi anche fuori dal Mac.
- Esempio: Generi la chiave, lanci pnpm vault:init con la parte pubblica che inizia con "age1", e la parte privata la stampi e la metti in un cassetto.

### ho-scelta-delle-18-idee

- Contesto: Dalla ricerca sono uscite 18 idee (per esempio leggere le fatture dal file XML, un'esecuzione più robusta dei lavori, la memoria temporale). In OPEN-QUESTIONS c'è una tabella con la raccomandazione di Claude per ciascuna; manca la tua scelta.
- Opzione consigliata: Accetto le raccomandazioni di Claude — i "sì" entrano nella roadmap, i "no" e i "rinviare" restano nella tabella come scelte fatte.
- Opzione: Le scelgo una per una — Claude te le presenta in conversazione con una domanda ciascuna.
- Opzione: Rinvio — restano tutte da decidere.
- Esempio: Idea 10, "Fatture dall'XML FatturaPA": raccomandata sì, perché leggere il file XML è più affidabile che leggere una scansione.

### ho-conferma-di-d-039

- Contesto: D-039 è la chat e le sue API (task 1.11). Due punti da confermare: un messaggio di lavoro viene rifiutato se il controllo privacy ci trova dati sensibili, e le API locali non chiedono login fino al task 1.13 (sono raggiungibili solo da questo Mac).
- Opzione consigliata: Confermo — le due regole restano; il login arriva con il task 1.13.
- Opzione: Voglio il login subito — Claude anticipa una parte del 1.13; più lavoro adesso.
- Esempio: Se in una conversazione di lavoro incolli un codice IBAN inventato, il messaggio non parte e la chat ti dice perché.

### conf-D-122

- Contesto: Le domande della pagina "Sviluppo di Arianna" ora hanno una spiegazione: cosa si decide, le opzioni con le loro conseguenze (la consigliata per prima, cliccabile) e un esempio. Le spiegazioni stanno nei documenti, accanto alle domande, e Claude Code scrive così anche quelle nuove. Resta da confermare che il formato ti è utile.
- Opzione consigliata: Confermo — la decisione diventa "accettata" e ogni domanda nuova arriva con contesto, opzioni ed esempio
- Opzione: Confermo, ma più corte — Claude accorcia contesti ed esempi a una frase ciascuno; si legge prima, si spiega meno
- Opzione: Rifiuto — le domande tornano a una riga sola e i blocchi di spiegazione si tolgono dai documenti
- Esempio: Apri la domanda "Chi fa il commit nel clone?": leggi perché conta, clicchi "Tu, a mano" e la risposta si riempie; aggiungi sotto "ma avvisami quando i test falliscono" e premi Invia.

### oq-incognito-tetto-di-durata-con-la-pagina-aperta

- Contesto: Una conversazione incognita si cancella da sola dopo 10 minuti senza nessuna pagina aperta su di lei. Se invece lasci la scheda del browser aperta (anche dietro altre schede) resta viva senza limite, con i testi nel database. Si decide se mettere un tetto massimo.
- Opzione consigliata: Nessun tetto — finché la pagina è aperta l'incognita resta; la chiudi tu con "Termina" o chiudendo la scheda.
- Opzione: Tetto di 12 ore — dopo 12 ore dall'apertura si chiude comunque, con l'avviso un minuto prima; un lavoro lungo del Coder può venire interrotto.
- Opzione: Tetto di 2 ore — più prudente per la privacy, ma una sessione di lavoro lunga va riaperta.
- Esempio: Apri un'incognita alle 18:00 per parlare di un preventivo e dimentichi la scheda aperta; senza tetto alle 9:00 del giorno dopo i testi sono ancora nel database, con il tetto di 12 ore spariscono alle 6:00.

### oq-incognito-verifica-dal-vivo-del-profilo-di-claud

- Contesto: Nelle incognite di lavoro Claude Code parte con l'opzione che non salva la sessione sul disco. Non è ancora verificato se scrive comunque altro nella cartella del suo profilo (copie dei file toccati, cronologie, file di debug). Per saperlo serve un lavoro vero e guardare quella cartella prima e dopo; è fuori dal repository, quindi Claude non può farlo da solo.
- Opzione consigliata: Lo faccio io con Claude — apri una sessione in cui autorizzi esplicitamente la lettura dell'elenco dei file del profilo; si aggiunge un caso all'eval dal vivo e si scrive il risultato nella scheda di chiusura.
- Opzione: Lo controllo io a mano — guardi tu la cartella prima e dopo un'incognita di lavoro e scrivi qui cosa cambia.
- Opzione: Rimandiamo — le incognite di lavoro si usano solo con dati finti finché non è verificato.
- Esempio: Prima di un'incognita di lavoro la cartella del profilo ha 1.204 file; dopo ne ha 1.207 (tre file di debug). La scheda di chiusura allora dirà "Claude Code ha lasciato 3 file di debug nel suo profilo".

### oq-modelli-schede-cloud-da-rileggere

- Contesto: La futura pagina Modelli mostra una scheda per Sonnet, Opus, Fable e Codex con punti di forza, contesto e prezzi presi dalle pagine dei fornitori il 7 ottobre. Le frasi sono traduzioni di Claude (per esempio "Il più lento" per "Slower"), i prezzi sono quelli delle API e non la quota dell'abbonamento, e i nomi dei modelli di Codex vengono da una pagina di OpenAI.
- Opzione consigliata: Le rileggo prima dell'unione — leggi `config/cloud-models.catalog.yaml` e correggi o approvi; poi la pagina le mostra.
- Opzione: Togliere i prezzi API — restano frasi e contesto; niente cifre che potrebbero confondersi con la quota.
- Opzione: Vanno bene così — si uniscono come sono.
- Esempio: Nella scheda di Opus leggi "4 / 20 $ per milione di token (API)"; se pensi che faccia credere che ogni delega ti costi soldi, scegli di toglierli.
