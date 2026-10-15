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
| ~~oMLX invia telemetria o contenuti fuori dalla macchina?~~ | **Deciso (utente, 2026-10-14):** verifica prima dei dati veri: Claude legge il codice di oMLX installato e cerca ogni chiamata verso internet, poi eventuale prova con un sorvegliante di rete; entro la fine della Fase 1A. Fino ad allora solo dati finti e `--host 127.0.0.1`. **Fatto il 2026-10-15 (D-221):** codice della v0.6.3rc2 letto; la chat non esce dal Mac, il pannello `/admin` sì (aggiornamenti, benchmark su omlx.ai); il buco era oMLX senza chiave, chiuso da D-221. Resta facoltativa la prova con un sorvegliante di rete | |
| ~~Codex con provider locale invia telemetria o contenuti altrove?~~ | **Deciso (utente, 2026-10-14):** Codex si tratta come cloud; la verifica si fa solo se servirà usarlo con un modello locale su progetti privati | |
| ~~Codice clienti con NDA~~ | **Deciso (utente, 2026-10-14):** un progetto di un cliente nasce Privato (L2, mai al cloud) finché l'utente non legge il contratto e abbassa lui la label | |
| ~~Remote git (GitHub privato, NAS, nessuno)~~ | **Deciso (utente, 2026-10-14):** GitHub privato, com'è oggi (`origin`); in git solo codice e documenti, mai `data/`, configurazione o vault | |
| ~~`pgvector` al posto di Qdrant~~ | **Deciso (utente, 2026-10-14):** pgvector nel PostgreSQL di Arianna; Qdrant solo se Mem0 lo richiede davvero | |
| ~~Editor della knowledge base~~ | **Deciso (utente, 2026-10-14):** Obsidian sulla cartella `kb/`, accanto alle pagine Pensieri e Conoscenza | |
| Fonti e persone per il Mentor | Scegli 10-15 nomi e fonti primarie | Fase 5 |
| ~~STT/TTS italiani~~ | **Deciso dall'utente con il provino del 2026-10-04:** trascrizione con Parakeet v3 (D-066), voce con Qwen3-TTS e la voce Serena (D-067, D-069) | |
| Numero e operatore telefonico | Decidere dopo costi e qualità | Fase 4 |
| ~~Rizzo-PII: dove tenere il modello~~ | **Deciso (utente, 2026-10-14):** cartella sua `data/guard/models`, indicata dal catalogo; oMLX non la vede (D-203, ramo `task/guard-rizzo`) | |
| ~~Licenza degli sprite di pixel-agents (JIK-A-4, Metro City)~~ | **Chiusa (utente, 2026-10-14):** «li voglio tenere tanto arianna al momento è per uso personale»: gli sprite restano per uso personale, solo in `data/characters/`, mai in git; da togliere prima di condividere la cartella. Richiesta collegata: galleria dei personaggi con pulsante che scarica i PNG di pixel-agents (coda in `HANDOFF.md`) | |
| ~~Conferma delle decisioni della notte del 2026-10-05 (D-077, D-079 prima parte, D-080 prima parte, D-081…D-087)~~ | **Chiusa:** doppione delle conferme singole (`conf-D-077` … `conf-D-087b`), che restano aperte una per una | |
| ~~Incognito: tetto di durata con la pagina aperta~~ | **Deciso (utente, 2026-10-14):** nessun tetto; l'incognita resta finché una pagina la tiene aperta | |
| Incognito: verifica dal vivo del profilo di Claude Code | Un run vero con `--no-session-persistence` e l'elenco dei file del profilo di `claude` nella home prima e dopo (D-136, tappa 3) | Prima di usare le incognite di lavoro con dati veri |
| ~~Modelli: schede cloud da rileggere~~ | **Deciso (utente, 2026-10-14):** togliere i prezzi API dalle schede (l'utente usa gli abbonamenti); restano frasi e contesto. Lavoro piccolo in coda in `HANDOFF.md` | |
| ~~Modelli da Hugging Face: scelte di D-139~~ | **Deciso (utente, 2026-10-14):** le regole di D-139 vanno bene così; D-139 accettata | |

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

### oq-incognito-verifica-dal-vivo-del-profilo-di-claud

- Contesto: Nelle incognite di lavoro Claude Code parte con l'opzione che non salva la sessione sul disco. Non è ancora verificato se scrive comunque altro nella cartella del suo profilo, sotto la tua cartella utente (copie dei file toccati, cronologie, file di debug). Per saperlo serve un lavoro vero e guardare quella cartella prima e dopo; sta fuori dal repository, quindi Claude non può farlo da solo.
- Opzione consigliata: Lo facciamo insieme — apri una sessione in cui autorizzi la lettura dell'elenco dei file del profilo; si aggiunge un caso all'eval dal vivo e il risultato va nella scheda di chiusura dell'incognita.
- Opzione: Lo controllo io a mano — guardi tu la cartella prima e dopo un'incognita di lavoro e scrivi qui cosa cambia.
- Opzione: Rimandiamo — le incognite di lavoro si usano solo con dati finti finché non è verificato.
- Esempio: Prima di un'incognita di lavoro la cartella del profilo ha 1.204 file; dopo ne ha 1.207 (tre file di debug). La scheda di chiusura allora dirà "Claude Code ha lasciato 3 file di debug nel suo profilo".

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

