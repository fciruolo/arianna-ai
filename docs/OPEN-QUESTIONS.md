# Decisioni aperte e idee da scegliere

## Decisioni aperte

| Decisione | Proposta | Entro |
| --- | --- | --- |
| ~~Linguaggio del nucleo~~ | **Deciso: TypeScript** (D-003) | |
| ~~Conferma delle decisioni "Proposta, applicata" (D-004, D-013…D-030)~~ | **Chiusa:** confermate dall'utente il 2026-10-14 a gruppi per tema (privacy, codice e test, motore, metodo), insieme a D-032, D-033, D-035, D-036, D-038, D-039, D-047, D-048 e D-034 | |
| ~~Dove gira il server~~ | **Deciso: Mac Studio** (chiarito dall'utente il 2026-10-02: è la macchina di lavoro dove andrà l'installazione con i dati veri; `HANDOFF.md`, "Dove siamo"), dietro interfaccia sostituibile | |
| ~~Conteggio di `claude -p` e `codex exec` negli abbonamenti~~ | **Chiusa (utente, 2026-10-14):** la quota si considera condivisa con le chat dell'utente (ipotesi prudente); i limiti di Arianna si regolano così, si riapre se l'account mostra il contrario | |
| ~~Nomi esatti dei flag di confinamento (`--strict-mcp-config`, sorgenti delle impostazioni, sandbox)~~ | **Deciso:** fissati per `claude` 2.1.288, sandbox compresa (D-049, D-050, `packages/executors/src/claude/profile.ts`), e per `codex` 0.160.0 (D-138, `packages/executors/src/codex/profile.ts`), con i test di contratto e del canarino | |
| ~~Sandbox: nativa di Claude Code oppure `sandbox-runtime`~~ | **Decisa la nativa** (D-050, confermata): il canarino non esce. microVM solo se un giorno esce | |
| ~~oMLX può puntare a `data/models/`?~~ | **Deciso: sì** (D-048, D-071): il core avvia `omlx serve --model-dir data/models` dal 2026-10-04 | |
| ~~oMLX invia telemetria o contenuti fuori dalla macchina?~~ | **Deciso (utente, 2026-10-14):** verifica prima dei dati veri: Claude legge il codice di oMLX installato e cerca ogni chiamata verso internet, poi eventuale prova con un sorvegliante di rete; entro la fine della Fase 1A. Fino ad allora solo dati finti e `--host 127.0.0.1`. **Fatto il 2026-10-15 (D-221):** codice della v0.6.3rc2 letto; la chat non esce dal Mac, il pannello `/admin` sì (aggiornamenti, benchmark su omlx.ai); il buco era oMLX senza chiave, chiuso da D-221; codice installato (app `oMLX.app`) identico al tag letto. Resta facoltativa la prova con un sorvegliante di rete | |
| ~~Codex con provider locale invia telemetria o contenuti altrove?~~ | **Deciso (utente, 2026-10-14):** Codex si tratta come cloud; la verifica si fa solo se servirà usarlo con un modello locale su progetti privati | |
| ~~Codice clienti con NDA~~ | **Deciso (utente, 2026-10-14):** un progetto di un cliente nasce Privato (L2, mai al cloud) finché l'utente non legge il contratto e abbassa lui la label | |
| ~~Remote git (GitHub privato, NAS, nessuno)~~ | **Deciso (utente, 2026-10-14):** GitHub privato, com'è oggi (`origin`); in git solo codice e documenti, mai `data/`, configurazione o vault | |
| ~~`pgvector` al posto di Qdrant~~ | **Deciso (utente, 2026-10-14):** pgvector nel PostgreSQL di Arianna; Qdrant solo se Mem0 lo richiede davvero | |
| ~~Editor della knowledge base~~ | **Deciso (utente, 2026-10-14):** Obsidian sulla cartella `kb/`, accanto alle pagine Pensieri e Conoscenza | |
| ~~Fonti e persone per il Mentor~~ | **Deciso (utente, 2026-10-15):** lista di 15 fonti proposta da Claude e approvata, in `SPEC.md` (sezione del Mentor, «Fonti»); si rivede all'inizio della Fase 5 | |
| ~~STT/TTS italiani~~ | **Deciso dall'utente con il provino del 2026-10-04:** trascrizione con Parakeet v3 (D-066), voce con Qwen3-TTS e la voce Serena (D-067, D-069) | |
| ~~Numero e operatore telefonico~~ | **Deciso (utente, 2026-10-15, D-222):** niente numero né operatore, Arianna chiama solo via internet (D-066) | |
| ~~Rizzo-PII: dove tenere il modello~~ | **Deciso (utente, 2026-10-14):** cartella sua `data/guard/models`, indicata dal catalogo; oMLX non la vede (D-203, ramo `task/guard-rizzo`) | |
| ~~Licenza degli sprite di pixel-agents (JIK-A-4, Metro City)~~ | **Chiusa (utente, 2026-10-14):** «li voglio tenere tanto arianna al momento è per uso personale»: gli sprite restano per uso personale, solo in `data/characters/`, mai in git; da togliere prima di condividere la cartella. Richiesta collegata: galleria dei personaggi con pulsante che scarica i PNG di pixel-agents (coda in `HANDOFF.md`) | |
| ~~Conferma delle decisioni della notte del 2026-10-05 (D-077, D-079 prima parte, D-080 prima parte, D-081…D-087)~~ | **Chiusa:** doppione delle conferme singole (`conf-D-077` … `conf-D-087b`), che restano aperte una per una | |
| ~~Incognito: tetto di durata con la pagina aperta~~ | **Deciso (utente, 2026-10-14):** nessun tetto; l'incognita resta finché una pagina la tiene aperta | |
| ~~Incognito: verifica dal vivo del profilo di Claude Code~~ | **Deciso (utente, 2026-10-17):** si fa insieme in una sessione apposta (l'utente autorizza la lettura del solo elenco dei file del profilo); promemoria in «Prima dei dati veri» di `HANDOFF.md` | |
| ~~Modelli: schede cloud da rileggere~~ | **Deciso (utente, 2026-10-14):** togliere i prezzi API dalle schede (l'utente usa gli abbonamenti); restano frasi e contesto. Lavoro piccolo in coda in `HANDOFF.md` | |
| ~~Modelli da Hugging Face: scelte di D-139~~ | **Deciso (utente, 2026-10-14):** le regole di D-139 vanno bene così; D-139 accettata | |
| ~~Notifiche dal telefono: contenuto cifrato~~ | **Deciso (utente, 2026-10-23):** «Contenuto cifrato»: tipo e id della conversazione cifrati per il browser (RFC 8291, D-295) | |
| ~~Notifiche dal telefono: contatto per Apple~~ | **Deciso (utente, 2026-10-23):** la sua email nel `subject` di `[push]` (D-295) | |
| ~~Fase 1A: registro del gateway riga per riga~~ | **Deciso (utente, 2026-10-23):** «Pagina Registro del gateway», D-296 | |
| ~~Fase 1A: quota per l'eval dal vivo del criterio~~ | **Deciso (utente, 2026-10-23):** «proviamolo ora»: `pnpm eval:live --tag claude` lanciato il 2026-10-23 | |

### Domande delle proposte della notte del 2026-10-05

Tutte chiuse (D-078 con D-127; D-079 con D-119 e le scelte del 2026-10-13; D-080 con le conferme e le scelte del 2026-10-13; D-088 accettata il 2026-10-13). La tabella è stata tolta il 2026-10-15: le righe non barrate restavano aperte nella pagina "Sviluppo di Arianna". Testo e risposte in `docs/PROPOSTE.md` e `docs/DECISIONS.md`.

## Idee dalla ricerca — decise

Fasi e ore come in `SPEC.md`, sezione "Idee dalla ricerca". Le ore non sono incluse nelle stime, salvo dove indicato. La colonna "Raccomandazione" è mia: la scelta resta tua.

| # | Idea | Fase | Ore | Raccomandazione e scelta |
| --- | --- | --- | --- | --- |
| 1 | Pattern Dual LLM / CaMeL | 2 | 12-20 | Scelta (utente, 2026-10-14): **sì, tutto in locale**: uno script senza modello scarica le email via IMAP, un modello locale in quarantena compila solo una scheda fissa, l'orchestratore locale vede solo la scheda; le email non escono mai dal sistema per nessun motivo e vanno anche nella conoscenza (D-204) |
| 2 | Sandbox per gli agenti che eseguono codice | 1 | 6-10 | Fatto: confinamento degli esecutori e sandbox del Coder (task 1.6, D-056, D-095) |
| 3 | DBOS per esecuzione durevole | 0-1 | 6-10 | Scelta (utente, 2026-10-14): **no per ora**, si rivaluta a fine Fase 1 |
| 4 | Langfuse / Promptfoo / Inspect | 0-1 | 8-14 | Scelta (utente, 2026-10-14): **no per ora** |
| 5 | Funzioni native di Claude Code | 1 | 6-12 | Scelta (utente, 2026-10-14): **rinviata alla Fase 3** |
| 6 | Advisor tool nel router | 1 | 3-6 | Scelta (utente, 2026-10-14): **sì, ora**: il router chiede a Claude un parere con una domanda astratta passata dal gateway quando non è sicuro (lavoro in coda, D-204) |
| 7 | Schede e procedure nel formato Skills più MCP | 1 | 4-8 | Scelta (utente, 2026-10-14): **sì, piena in Fase 2**: le procedure nuove nascono come skill |
| 8 | Hermes Agent come harness | 1 | 10-20 | Scelta (utente, 2026-10-14): **no** |
| 9 | Scheduler deterministico | 1 | 4-8 | Scelta (utente, 2026-10-14): **sì**, ripetizioni in Fase 2 con il calendario delle routine (D-110) |
| 10 | Fatture dall'XML FatturaPA | 2 | 8-14 | Scelta (utente, 2026-10-14): **sì, per prima** in Fase 2 |
| 11 | OCR e parsing locali | 2 | 10-18 | Scelta (utente, 2026-10-14): **sì, dopo la 10**, tutto locale |
| 12 | Open banking PSD2 | 2+ | 15-30 | Scelta (utente, 2026-10-14): **no in v1**: estratto conto CSV scaricato dall'utente |
| 13 | Memoria temporale con Graphiti | 5 | 20-35 | Scelta (utente, 2026-10-14): **soluzione definitiva e d'avanguardia**: prima della memoria della Fase 2 un confronto misurato (Mem0 col grafo, Graphiti, altre memorie a grafo o temporali) sugli stessi eval, domande sulle date comprese; si adotta la migliore al posto di Mem0 scelto a priori (D-204) |
| 14 | Stack vocale locale pronto | 4 | 8-16 | Fatto: voce locale con Parakeet e Qwen3-TTS (D-066, D-067) |
| 15 | Home Assistant via MCP | 3+ | 6-12 | Scelta (utente, 2026-10-14): **dopo la Fase 3**; l'utente usa soprattutto Alexa: da guardare anche come comandare i dispositivi di Alexa |
| 16 | Aggiornare e confrontare i modelli locali | 1 | 8-14 | Fatto: Confronto dei modelli (D-199) e orchestratore 35B (D-201) |
| 17 | Ripasso FSRS con libreria | 5 | 8-15 | Scelta (utente, 2026-10-14): **sì**, in Fase 5 con il Mentor |
| 18 | Wiki compilato dal modello per il Mentor | 5 | 8-14 | Scelta (utente, 2026-10-14): **decidere in Fase 5**, con le fonti del Mentor |

Scelta dell'utente: **fatta il 2026-10-14**, una per una con le domande a opzioni; le idee 2, 14 e 16 erano già fatte (D-204).

## Spiegazioni delle domande

Contesto, opzioni ed esempio delle domande che non hanno posto sotto di sé (righe delle tabelle qui sopra, conferme delle decisioni di `DECISIONS.md`, righe "In attesa dell'utente" di `HANDOFF.md`), letti dalla pagina "Sviluppo di Arianna" (D-122). Un blocco per domanda, con la sua chiave come titolo: `conf-D-0NN` per una conferma, `oq-...` e `ho-...` per una riga (la chiave nasce dal testo della prima cella: se la riga cambia, cambia anche il titolo qui). Le domande di `PROPOSTE.md` hanno le stesse righe sotto la domanda. Quando una domanda si chiude, si toglie anche il suo blocco: un blocco senza domanda la pagina lo conta fra le righe saltate. Rilette il 2026-10-10: chiuse quelle già decise (righe barrate qui sopra, "(storico)" in `HANDOFF.md`, sezioni "Domande chiuse" in `PROPOSTE.md`, ciascuna con la sua fonte).

Parole che tornano spesso: **L0** = pubblico; **L1** = di lavoro, può andare a Claude o Codex passando dal gateway; **L2** = privato, resta sul Mac; **L3** = delicatissimo, nessun modello lo legge. Il **gateway** è il filtro unico di tutto ciò che esce verso il cloud; il **core** è il programma sempre acceso di Arianna; una **D-NNN** è una decisione scritta in `DECISIONS.md`.
