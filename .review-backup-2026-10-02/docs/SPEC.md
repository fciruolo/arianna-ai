# Progetto Arianna

Oct 2, 2026 · @Fausto Ciruolo

## Visione e obiettivi

Arianna è un assistente personale e un sistema di agenti che gira sul tuo hardware: usa modelli locali per tutto ciò che è privato e Claude Code o Codex (con i tuoi abbonamenti, senza API) per il lavoro che può uscire dalla macchina.

**Obiettivi**

- **Un solo sistema** per coding e vita personale (fatture, documenti, scadenze, famiglia, affitti), con agenti diversi ma una memoria condivisa.
- **Autonomia vera:** gli dai un obiettivo, il sistema lo scompone, sceglie il modello giusto per ogni passo, esegue e ti interrompe solo dove serve una tua decisione.
- **Privacy per costruzione:** i dati sensibili vengono letti solo da modelli locali, e questa regola è imposta dal codice, non dalla buona volontà del prompt.
- **Interazione naturale:** chat, voce, chiamate in entrata e in uscita (ti chiama lui quando gli serve qualcosa).
- **Due volti:** un'interfaccia HUD in stile Jarvis e un "ufficio" pixel-art dove vedi gli agenti lavorare, ispirato a pixel-agents.
- **Conoscenza viva:** una knowledge base stile Notion, interrogabile e aggiornata dagli agenti.
- **Formazione continua:** un agente che segue fonti autorevoli e ti fa studiare le tecnologie più recenti.

**Non-obiettivi della v1:** niente multi-utente, niente SaaS, niente app mobile nativa (si usa il browser e Telegram), niente addestramento di modelli.

**Come si misura il successo:** dopo tre mesi lo usi ogni giorno, non deve essere riavviato più di una volta a settimana, e nessun dato classificato come privato compare mai nei log o nelle richieste verso il cloud.

## Requisiti

Il sistema deve coprire sette aree, costruite in cinque fasi in modo che ogni fase sia già utile da sola.

| Area | Requisito | Fase |
| --- | --- | --- |
| Chat | Chat web e Telegram con lo stesso agente, stesso storico, risposte in streaming | 1 |
| Coding | Agenti che lanciano Claude Code e Codex sui repository, ciascuno in un worktree git isolato | 1 |
| Router | Scelta automatica del modello per compito, livello di privacy, costo e difficoltà | 1 |
| Privacy | Classificazione di ogni dato e documento; i dati privati arrivano solo a modelli locali | 1 |
| Approvazioni | Le azioni irreversibili (invio mail, pagamenti, push, cancellazioni) aspettano il tuo ok | 1 |
| Memoria | Knowledge base con ricerca ibrida su documenti, fatture, note, conversazioni | 2 |
| Todo e cardwall | Kanban e todo list dove anche gli agenti creano, spostano e chiudono i task | 2 |
| Autonomia | Obiettivi di lunga durata, scheduler, ripresa dopo un riavvio | 2 |
| HUD Arianna | Dashboard con stato degli agenti, code, costi e attività recenti | 3 |
| Ufficio pixel | Vista pixel-art degli agenti al lavoro, ispirata a pixel-agents | 3 |
| Voce | Parlare con Arianna in tempo reale, con riconoscimento e sintesi vocale locali | 4 |
| Chiamate | Telefonate in uscita (ti chiama lui) e in entrata | 4 |
| Apprendimento | Un agente mentor che segue fonti selezionate e ti fa studiare | 5 |

**Requisiti non funzionali**

- **Locale prima di tutto:** la parte privata funziona anche senza internet.
- **Riavviabile:** se un processo cade, i task in corso riprendono dallo stato salvato.
- **Osservabile:** ogni decisione del router, ogni chiamata a un modello e ogni azione di un agente è registrata e consultabile.
- **Costi sotto controllo:** il consumo di abbonamenti e di token locali è visibile, con soglie e avvisi.
- **Sostituibile:** nessun modello, framework o fornitore è cablato nel codice; si cambia da configurazione.
- **Una persona sola:** niente multi-utente, quindi niente complessità di permessi tra utenti.

## Principi e livelli di privacy

Ogni dato ha un'etichetta di riservatezza, e un controllo nel codice, non nel prompt, decide quali modelli possono leggerlo.

| Livello | Cosa contiene | Chi può leggerlo |
| --- | --- | --- |
| L0 Pubblico | Documentazione, articoli, repository open source, web | Qualsiasi modello |
| L1 Interno | Il tuo codice non sensibile, appunti di lavoro, idee | Modelli locali, Claude Code, Codex (solo repository in allowlist) |
| L2 Privato | Fatture, documenti fiscali e contratti, dati di famiglia, affitti, codice di clienti con NDA | Solo modelli locali |
| L3 Segreto | Password, chiavi, IBAN, documenti d'identità | Nessun modello in chiaro: gli agenti usano riferimenti al vault e l'operazione è eseguita dal codice |

**Regole che il codice deve imporre**

1. **Default-deny:** un dato senza etichetta è L2 finché non lo classifichi tu o una regola per cartella e sorgente.
2. **Contaminazione di sessione:** se un agente legge anche solo un dato L2, la sua sessione resta locale fino alla fine; non può più chiamare il cloud.
3. **Le etichette salgono, non scendono da sole:** per declassare serve la tua approvazione esplicita.
4. **Un solo punto d'uscita:** tutto ciò che va verso Claude Code, Codex o il web passa da un gateway che controlla etichette, registra cosa esce e blocca se c'è un dato L2 o L3.
5. **Clienti con NDA:** finché non verifichi i singoli contratti, tratta il loro codice come L2, quindi solo locale.

Il rischio principale non è un modello che "decide" di barare, ma un agente cloud che riceve per errore un file privato in un contesto più ampio del previsto. Per questo il controllo sta sull'uscita, non sulle istruzioni all'agente.

## Architettura

&#91;embedded content: architettura · 4 livelli, 1 punto di uscita\]

Le interfacce parlano con un solo nucleo; il nucleo usa i modelli locali direttamente e arriva al cloud (Claude Code e Codex) soltanto attraverso il gateway della privacy, che lascia passare solo i dati L0 e L1.

## Router dei modelli

Il router assegna ogni passo a un esecutore guardando prima la privacy, poi la difficoltà, poi il costo; i due percorsi cloud sono le CLI ufficiali, lanciate come processi con il tuo login e senza API.

**I tre esecutori**

- **Locale:** un endpoint locale (oggi oMLX sul Mac Studio, domani vLLM o llama.cpp se cambi hardware) con un modello grande per i compiti privati e uno piccolo e veloce per classificare, riassumere ed estrarre.
- **Claude Code:** il binario ufficiale `claude`, non modificato, lanciato in modalità `-p` con `--output-format stream-json`, `--resume` per riprendere le sessioni e `--allowedTools` o `--permission-mode` per limitare ciò che può fare. Il modello (Sonnet, Opus, Fable) si sceglie per ogni chiamata con `--model`.
- **Codex:** `codex exec --json` con accesso "Sign in with ChatGPT"; su un server senza browser si usa il login con codice dispositivo.

**Come scegliere (regole prima, giudizio dopo)**

1. **Filtro privacy:** il livello più alto dei dati coinvolti esclude i modelli non ammessi.
2. **Filtro di budget:** se la quota di un abbonamento è quasi finita, si scende di livello o si rinvia il task.
3. **Stima di difficoltà:** un piccolo modello locale legge il compito e stima ambiguità, file coinvolti e rischio; il risultato è un punteggio, non una decisione finale.
4. **Scelta e fallback:** si parte dal modello più economico adatto; se i test falliscono o l'agente si blocca, si sale (Sonnet, poi Opus, poi Fable) e l'esito viene registrato.

| Tipo di compito | Livello | Esecutore |
| --- | --- | --- |
| Fatture, documenti, mail personali, KB privata | L2 | Locale (modello grande) |
| Classificare, riassumere, estrarre, etichettare | Qualsiasi | Locale (modello piccolo) |
| Bugfix, test, refactor quotidiani | L0, L1 | Claude Code con Sonnet |
| Architettura, bug difficili, migrazioni ampie | L0, L1 | Claude Code con Opus; Fable per i casi più duri |
| Secondo parere e review indipendente | L0, L1 | Codex, per avere un modello di famiglia diversa |
| Ricerca web e studio | L0 | Claude Code o Codex con web, oppure locale più ricerca |
| Voce in tempo reale | Qualsiasi | Locale, per latenza e privacy |

La tabella è un punto di partenza: il router salva per ogni task modello, tempo, costo stimato ed esito, così dopo qualche settimana puoi correggere le regole con i dati invece che a intuito. Fable ha misure di sicurezza aggiuntive su alcuni ambiti, quindi evitalo per lavoro di sicurezza offensiva.

**Vincoli sull'uso degli abbonamenti (da rispettare nel codice)**

- Le condizioni ufficiali di Claude Code dicono che l'accesso con abbonamento è pensato per l'uso ordinario di Claude Code e che i limiti pubblicizzati dei piani Pro e Max presuppongono un uso individuale e ordinario; permettono invece di accedere al binario non modificato con il proprio abbonamento.
- Per questo Arianna non deve mai leggere, copiare o riusare i token OAuth, né offrire il login ad altre persone: lancia il binario ufficiale e basta, solo per te.
- L'opzione `--bare` ignora il login con abbonamento e richiede una chiave API, quindi qui non va usata.
- Alcune fonti riportano che dal 15 giugno 2026 l'uso programmatico (`claude -p`, Agent SDK) attinge a un pool di crediti separato e limitato; non l'ho trovato nelle pagine ufficiali che ho letto, quindi è da verificare nel tuo account prima di progettare i consumi.
- Per Codex, la documentazione OpenAI prevede l'accesso con ChatGPT per l'uso locale e raccomanda una chiave API per i flussi programmatici come CI/CD; le credenziali in cache vanno tenute nel portachiavi del sistema (impostazione cli\_auth\_credentials\_store = keyring) e non nel file auth.json in chiaro. Le regole cambiano spesso: tieni l'accesso a Claude Code dietro un'interfaccia sostituibile, così puoi passare a un altro esecutore senza riscrivere gli agenti.

## Sistema di agenti

Un orchestratore, Arianna, trasforma i tuoi obiettivi in task sul cardwall e li affida ad agenti specializzati, ognuno con modelli, strumenti e livello di privacy massimo ben definiti.

| Agente | Compito | Modelli | Privacy massima |
| --- | --- | --- | --- |
| Arianna (orchestratore) | Riceve obiettivi da chat, voce e scheduler; li scompone, assegna, riassume | Locale | L2 |
| Coder | Lavora sui repository con Claude Code o Codex, ciascun task in un worktree git | Claude Code, Codex | L1 |
| Reviewer | Rilegge il diff con un modello diverso da quello che ha scritto il codice | Codex o Claude Code | L1 |
| Archivista | Importa documenti e fatture, estrae dati, classifica, aggiorna la KB | Locale | L3 (via vault) |
| Segretario | Mail, calendario, bozze di risposta, promemoria, scadenze | Locale | L2 |
| Ricercatore | Cerca sul web, confronta fonti, scrive sintesi | Claude Code, Codex, locale | L0 |
| Mentor | Segue le fonti scelte e prepara studio e esercizi | Locale e cloud | L0 |
| Ops | Controlla servizi, backup, spazio disco, consumi | Locale | L1 |

**Come è fatto un agente.** Ogni agente è una "scheda" dichiarativa (file YAML più un prompt in markdown) con tre parti: strumenti ammessi, livello di privacy massimo e politica sul modello. Aggiungere un agente significa aggiungere un file, non scrivere codice.

**Come lavora**

1. Arianna crea un task sul cardwall con obiettivo, criteri di completamento e livello di privacy.
2. Il router sceglie l'esecutore; l'agente lavora in una sandbox (cartella o worktree dedicato, rete limitata).
3. Ogni passo è un evento salvato in un registro; se il sistema si riavvia, il task riparte dall'ultimo evento.
4. Alla fine l'agente allega la prova (test passati, diff, documento prodotto) e sposta la carta in "Da verificare".

**Autonomia a gradini.** Ogni agente ha un livello: A0 propone soltanto; A1 agisce in sandbox; A2 esegue azioni reversibili; A3 esegue anche azioni visibili all'esterno avvisandoti dopo. Si parte da A1 per tutti e si sale per ogni agente solo dopo che ha lavorato bene per un po'.

**Approvazioni.** Le azioni si dividono in lettura (libere), modifiche locali reversibili (libere in sandbox), azioni visibili all'esterno (mail, commit su `main`, calendario) e irreversibili (pagamenti, cancellazioni, push forzati). Le ultime due chiedono conferma su chat, web o per telefono.

**Freni.** Ogni task ha un tetto di passi, di tempo e di costo; se l'agente gira in tondo o sfora, si ferma e ti chiede cosa fare, invece di continuare a consumare.

## Orchestrazione locale

L'orchestrazione si divide in tre livelli e solo uno dipende dal modello: il controllo è codice deterministico, il giudizio spetta a un modello locale con strumenti vincolati, il lavoro di coding è affidato ai processi Claude Code e Codex.

| Livello | Cosa fa | Dove gira | Rischio |
| --- | --- | --- | --- |
| Controllo | Macchina a stati dei task, code, router, gateway, approvazioni, scheduler | Codice deterministico locale | Basso: si testa come ogni software |
| Giudizio | Scomporre un obiettivo, stimare la difficoltà, scegliere gli strumenti | Modello locale | Medio: un modello da circa 27B quantizzato è più fragile di uno cloud su obiettivi lunghi con molti passaggi |
| Lavoro | Scrivere e modificare codice, ricercare | Claude Code e Codex come processi locali (l'inferenza va nel cloud); per codice L2, Codex con un provider locale | Medio: la qualità del codice con modello locale è inferiore |

**Regole**

- Il modello propone e il codice decide: le azioni passano da uno schema JSON vincolato e da un elenco chiuso di strumenti.
- Piani corti e sessioni brevi, con riavvio automatico del server locale, perché con oMLX hai visto crolli dopo molta attività.
- Un "advisor" cloud può aiutare a pianificare i casi difficili solo su compiti L0 e L1, senza dati privati.
- Il modello orchestratore si sceglie con un test di accettazione nella suite di valutazione: precisione delle chiamate agli strumenti, rispetto dello schema, recupero dopo un errore e rifiuto di azioni fuori elenco.

## Memoria e knowledge base

La conoscenza vive in file markdown che puoi aprire con qualsiasi editor, e un indice di ricerca ibrido li rende interrogabili dagli agenti, rispettando i livelli di privacy.

**Tre livelli di memoria**

- **Archivio:** i documenti originali (PDF, fatture, contratti, scansioni) restano immutati in una cartella cifrata, con checksum e metadati. Gli agenti non li modificano mai.
- **Knowledge base:** pagine markdown con intestazione strutturata (tipo, etichetta di privacy, collegamenti, proprietà) in un repository git. È il "Notion evoluto": pagine, database con viste tabella, kanban e calendario, e collegamenti tra pagine.
- **Memoria degli agenti:** fatti stabili su di te (preferenze, persone, abitudini), episodi (cosa è successo e quando) e procedure (come si fa una cosa). Mem0 con Qdrant, che già usi, è un buon candidato per questo livello.

**Ricerca.** Ogni interrogazione combina ricerca testuale, ricerca semantica con embedding e collegamenti tra pagine, poi un riordinamento fatto da un modello locale. Esistono indici separati per livello: gli embedding dei contenuti L2 sono calcolati solo da modelli locali e una sessione cloud non può interrogarli.

**Importazione dei documenti**

1. Un documento arriva (cartella osservata, mail, foto dal telefono).
2. OCR locale e classificazione del tipo e del livello di privacy.
3. Estrazione dei campi (per una fattura: fornitore, importo, IVA, scadenza, stato del pagamento).
4. Creazione della pagina nella KB, collegamento alle entità (cliente, immobile, progetto) e aggiornamento dello scadenziario.
5. Se la classificazione è incerta, il documento resta L2 e finisce in una coda di revisione per te.

**Editor e viste.** Si parte con la cartella di markdown aperta in un editor che già usi (per esempio Obsidian) più una vista web in sola lettura per i database; in una fase successiva si costruisce un editor a blocchi integrato con cardwall e agenti. Così la KB è utile dal primo giorno e non dipende dal tuo editor.

**Backup.** Repository git cifrato, snapshot giornalieri dell'archivio e una copia fuori sede, con un ripristino provato almeno una volta.

## Valutazione: RAG, grafi e harness

Per Arianna servono un RAG ibrido, tabelle SQL per i dati estratti e un harness sottile per gli agenti locali; grafi di conoscenza e GraphRAG si aggiungono solo se una misura sui tuoi documenti ne mostra il bisogno. Il verdetto è una mia valutazione di progetto, da confermare con la suite di test descritta sotto.

| Tecnica | Verdetto | Motivo e momento |
| --- | --- | --- |
| RAG ibrido (testo, vettori, riordino) | Sì, Fase 2 | Risponde a domande come "cosa dice il contratto su disdetta e rinnovo"; gira tutto in locale ed è la base della KB |
| Dati strutturati in Postgres (fatture, scadenze, contratti) | Sì, Fase 2, prima di qualsiasi grafo | Le domande su importi, date e totali hanno una risposta esatta con SQL, mentre un RAG sui numeri sbaglia più facilmente |
| Collegamenti tra pagine (wikilink e proprietà) | Sì, Fase 2 | È un grafo "povero" a costo zero: persone, immobili, clienti e progetti collegati nell'intestazione delle pagine; la ricerca può allargarsi di un passo lungo i collegamenti |
| Riordino dei risultati con un modello locale | Sì, Fase 2 | Migliora la precisione a basso costo |
| Output strutturato vincolato (schema JSON) | Sì, Fase 1 | Rende affidabile l'estrazione dei campi dalle fatture anche con modelli locali piccoli |
| GraphRAG o grafo estratto da un modello | Rinviare | L'indicizzazione richiede molte chiamate al modello, e quello locale è lento; serve per domande globali ("come sono cambiate le spese della casa in tre anni"), che si provano prima con SQL e riassunti per cartella |
| Memoria temporale a grafo (fatti con data di validità) | Valutare in Fase 5 | Utile per "cosa era vero allora"; Mem0 ha un'opzione a grafo da verificare; non entra nel nucleo |
| Contesto lungo al posto del RAG | Solo per task cloud L0 e L1 | Per codice e documentazione pubblica conviene dare i file interi a Claude Code; per i dati L2 il modello locale ha un contesto limitato, quindi il RAG resta necessario |
| Harness per il coding | Non scriverlo: usare Claude Code e Codex | Sono già harness completi (ciclo, strumenti, permessi, sessioni); tu scrivi solo l'adattatore. L'Agent SDK di Anthropic, secondo le condizioni ufficiali, richiede una chiave API, quindi non fa per te |
| Harness per gli agenti locali | Scriverne uno sottile in TypeScript, oppure riusarne uno open source esistente (per esempio Hermes Agent, che già conosci) | Ciclo con strumenti MCP, tetti di passi e costo, eventi nel registro e sandbox; da confrontare con una prova di due giorni in Fase 1 prima di impegnarsi |
| Harness di valutazione (suite di test) | Sì, dalla Fase 0 | Senza una suite di casi non puoi migliorare il router, il gateway o l'estrazione, né cambiare modello in sicurezza |
| Fine-tuning | No | Con pochi dati e modelli che cambiano spesso bastano prompt e test |
| MCP e skill | Sì | Gli stessi strumenti funzionano per Arianna, Claude Code e Codex |

**La suite di valutazione.** Si costruisce con dati finti e contiene quattro gruppi di casi: il gateway (nessun dato L2 o L3 deve uscire), il router (il modello scelto è ammesso e ragionevole), l'estrazione (i campi di fatture finte sono corretti) e il ritrovamento (le domande ricevono la pagina giusta). Gira a ogni modifica insieme ai test.

**Come decidere sul grafo.** Dopo la Fase 2 scrivi una cinquantina di domande vere sulla tua KB, tra cui quelle che richiedono di unire più documenti. Se RAG, SQL e collegamenti le risolvono, il grafo non serve; se le domande trasversali falliscono in modo sistematico, si prova GraphRAG su una sola area (per esempio la casa e gli affitti) e si misura il guadagno prima di estenderlo.

**Ordine di adozione:** 1. estrazione strutturata in Postgres; 2. RAG ibrido con riordino; 3. espansione lungo i collegamenti; 4. suite di valutazione estesa alle domande vere; 5. grafo, solo se la misura lo giustifica.

## Idee dalla ricerca (da scegliere)

Diciotto idee emerse dalla ricerca del 2 ottobre 2026; nessuna è ancora nel progetto finché non la scegli. Le ore sono indicative e si sommano a quelle di fase, tranne dove l'idea sostituisce lavoro già previsto (3, 14, 17).

| N | Idea | Fase | Ore |
| --- | --- | --- | --- |
| 1 | Pattern Dual LLM / CaMeL per gli agenti che leggono mail e web | 2 | 12-20 |
| 2 | Sandbox a microVM (Docker Sandboxes o sandbox-runtime) per gli agenti che eseguono codice | 1 | 6-10 |
| 3 | Esecuzione durevole con DBOS al posto della coda scritta a mano | 0-1 | 6-10 |
| 4 | Langfuse, Promptfoo e Inspect AI per tracce e test | 0-1 | 8-14 |
| 5 | Funzioni native di Claude Code (agent view, channels, /goal, Remote Control) | 1 | 6-12 |
| 6 | Advisor tool nel router: modello economico che consulta uno più forte | 1 | 3-6 |
| 7 | Schede agente e procedure nel formato Skills (SKILL.md) più MCP | 1 | 4-8 |
| 8 | Hermes Agent come harness degli agenti locali | 1 | 10-20 |
| 9 | Scheduler deterministico, senza "heartbeat" che consuma token | 1 | 4-8 |
| 10 | Fatture lette dall'XML FatturaPA, senza OCR | 2 | 8-14 |
| 11 | OCR e parsing locali (Docling, PaddleOCR-VL) per carta e scansioni | 2 | 10-18 |
| 12 | Open banking PSD2 (i dati passano da un terzo: eccezione alla regola L2) | 2+ | 15-30 |
| 13 | Memoria temporale con Graphiti | 5 | 20-35 |
| 14 | Stack vocale locale pronto (speech-to-speech, Qwen3-TTS) | 4 | 8-16 |
| 15 | Home Assistant come strumento via MCP | 3+ | 6-12 |
| 16 | Aggiornare i modelli locali e confrontarli con la suite di test | 1 | 8-14 |
| 17 | Ripasso FSRS con Armin o OpenTutor | 5 | 8-15 |
| 18 | Wiki compilato dal modello per il Mentor | 5 | 8-14 |

## Todo list e cardwall

Todo e cardwall sono la stessa lista di task vista in due modi, con un campo "assegnato a" che dice se tocca a te o a un agente.

**Colonne del cardwall**

1. **Inbox:** tutto ciò che arriva (da te, dagli agenti, da mail e scadenze), da smistare.
2. **Pronti:** triati, con obiettivo e criteri di completamento scritti.
3. **In corso:** un agente ci sta lavorando; ogni agente ha un limite di carte aperte.
4. **Attende te:** serve una tua decisione o approvazione, con il motivo scritto in una riga.
5. **Da verificare:** l'agente ha finito e allega le prove (diff, test, documento prodotto).
6. **Fatto:** chiuso da te, o in automatico per i task di basso rischio.

**Cosa c'è su una carta:** titolo, obiettivo, criteri di completamento, area (Coding, Clienti, Casa e affitti, Famiglia, Studio), livello di privacy, agente e modello usati, costo stimato, scadenza, dipendenze, carte figlie e un registro cronologico di ciò che è successo.

**Regole**

- Gli agenti con autonomia A0 e A1 creano carte solo in Inbox; solo da A2 in su possono metterle direttamente in Pronti.
- Una carta non passa a Fatto senza prove allegate.
- Una carta con livello L2 non può essere assegnata a un agente che usa il cloud.
- Le scadenze (fatture da pagare, affitti, rinnovi, documenti) generano carte in automatico dallo scadenziario della KB.
- La vista Todo mostra solo le carte assegnate a te, ordinate per scadenza e priorità, ed è quella che ricevi ogni mattina in chat o a voce.

## Interfacce

Sono tre viste sugli stessi dati e sugli stessi eventi: la chat per parlare, l'HUD per controllare, l'ufficio pixel-art per vedere gli agenti lavorare.

**Chat (Fase 1).** Una chat web con risposte in streaming e un bot Telegram che parlano con la stessa Arianna e lo stesso storico. Le richieste di approvazione compaiono come schede con pulsanti "approva" e "rifiuta", e l'allegato con le prove.

**HUD Arianna (Fase 3).** Un pannello scuro in stile Jarvis, pensato per essere letto, non solo bello:

- stato di ogni agente, con il modello in uso e se sta lavorando in locale o nel cloud;
- il cardwall in miniatura e la lista "Attende te";
- un flusso di eventi in tempo reale;
- misuratori di quota e costo per Claude Code, Codex e per il carico del modello locale;
- un indicatore del perimetro di privacy, che mostra quanti task girano in locale e cosa è uscito verso il cloud nelle ultime 24 ore;
- la sfera vocale per parlare con Arianna.

Si costruisce in Vue 3 e Tailwind, che già conosci, e riceve gli eventi via WebSocket dal nucleo.

**Ufficio pixel-art (Fase 3).** pixel-agents è un progetto con licenza MIT che trasforma gli agenti di codice in personaggi pixel-art in un ufficio: camminano alla scrivania, scrivono quando modificano file, leggono quando cercano, e mostrano un fumetto quando aspettano il tuo input. Esiste come estensione di VS Code e come comando `npx pixel-agents` che serve la stessa interfaccia in un browser; legge gli eventi di Claude Code tramite hook e transcript, ed espone un'interfaccia `HookProvider` per aggiungere altri strumenti.

La strada più rapida è in due passi: prima si usa così com'è per vedere le sessioni di Claude Code lanciate da Arianna (da verificare che le sessioni non interattive compaiano, perché dipende dagli hook e dai transcript); poi si scrive un `HookProvider` per Arianna, così anche gli agenti locali e Codex hanno un personaggio. Le aree dell'ufficio si possono far corrispondere alle aree del cardwall, e il fumetto "in attesa" alla colonna "Attende te". L'ufficio si incorpora nell'HUD come pannello.

**Accesso da fuori casa.** Il server non espone porte su internet: ci si collega con una VPN privata (per esempio WireGuard o Tailscale) dal telefono e dal portatile, e la chat funziona come app installabile (PWA).

## Voce e chiamate

La voce si costruisce su un framework open source per agenti vocali in tempo reale, con riconoscimento e sintesi eseguiti in locale, e la telefonia si aggiunge dopo come canale in più.

**Framework.** Le due scelte mature sono Pipecat (Python, licenza BSD, pipeline a frame, trasporto via WebRTC, WebSocket o SIP) e LiveKit Agents (Python e Node, licenza Apache 2.0, con server WebRTC e telefonia SIP integrati). Per te conviene Pipecat: è Python puro, si compone con i modelli locali e non richiede un servizio cloud nel percorso dei dati. LiveKit resta l'alternativa se la telefonia diventa centrale.

**Pipeline locale**

1. Rilevamento della voce e dei turni di parola (VAD), con interruzione possibile mentre Arianna parla.
2. Riconoscimento vocale locale, con un modello della famiglia Whisper ottimizzato per Apple Silicon o per GPU; da provare con l'italiano e con il tuo accento prima di scegliere.
3. Un modello locale piccolo e veloce che conversa e decide cosa fare.
4. Sintesi vocale locale; da valutare qualità e latenza in italiano su due o tre candidati prima di fissarla.

**Regola fondamentale: la voce non pensa a lungo.** Un modello grande locale risponde troppo lentamente per una conversazione fluida. Il modello vocale risponde in meno di un secondo, e per tutto ciò che richiede lavoro ("controlla le fatture di settembre") delega a un agente con uno strumento dedicato, dice "ci lavoro e ti avviso" e porta il risultato quando è pronto.

**Chiamate in uscita e in entrata.** Servono un numero e un collegamento SIP forniti da un operatore, quindi l'audio della telefonata passa dalla rete telefonica anche se riconoscimento e sintesi restano in casa. Per questo, sul canale telefonico:

- Arianna non legge ad alta voce dati L2 (importi, IBAN, dati dei familiari) a meno che tu non lo abbia attivato esplicitamente per quella chiamata;
- le approvazioni importanti richiedono un codice detto a voce o una conferma sulla chat, non un semplice "sì";
- risponde solo al tuo numero, verificato, e ignora tutti gli altri.

**Quando ti chiama.** Il canale predefinito è Telegram; la telefonata scatta solo in tre casi: una scadenza vicina senza risposta, una carta in "Attende te" marcata urgente, o un briefing programmato che hai richiesto. Ci sono fasce orarie di silenzio, un massimo di chiamate al giorno e, se non rispondi, un messaggio scritto invece di insistere.

## Modulo apprendimento

L'agente Mentor segue le fonti che scegli, ti porta ogni giorno ciò che conta davvero per il tuo lavoro e trasforma le novità in studio, esercizi e piccoli progetti, invece che in un'altra coda di link da leggere.

**Fonti.** Si parte da una lista che decidi tu, divisa in tre gruppi:

- **Primarie:** documentazione e note di rilascio dei prodotti che usi, release su GitHub delle tue dipendenze, paper su arXiv.
- **Persone:** gli sviluppatori e i divulgatori americani che vuoi seguire (i nomi li scegli tu, e il sistema ti suggerisce candidati che poi accetti o scarti).
- **Sintesi:** newsletter e podcast tecnici, trascritti in locale quando c'è solo l'audio.

**Cosa salva.** Link, titolo, data, un riassunto scritto da un modello e al massimo brevi citazioni; non conserva copie integrali di articoli o trascrizioni altrui, e rispetta le condizioni d'uso di ogni piattaforma, quindi dove un servizio non permette la raccolta automatica ti manda una segnalazione manuale.

**Come trasforma le novità in studio**

1. **Radar delle tecnologie:** una pagina della KB che classifica ogni tecnologia come "adotta", "prova", "valuta" o "lascia", aggiornata dalle novità.
2. **Filtro anti-hype:** una novità entra nel radar solo se ha una fonte primaria (note di rilascio, documentazione, codice) e almeno una seconda fonte indipendente; altrimenti resta marcata "non verificata".
3. **Briefing quotidiano di cinque minuti**, letto in chat o ascoltato a voce, con al massimo tre voci rilevanti per il tuo stack.
4. **Piano di studio per argomento:** obiettivi, ordine delle letture e un mini-progetto finale che diventa una carta del cardwall da fare in sandbox.
5. **Ripasso a intervalli:** schede di domande generate dalle fonti e pianificate con un algoritmo di ripetizione dilazionata (per esempio FSRS), con quiz anche a voce.
6. **Tutor socratico:** su richiesta ti interroga, ti fa spiegare il concetto con parole tue e segnala i punti deboli.
7. **Collegamento ai tuoi progetti:** per ogni novità importante il Mentor scrive in due righe cosa cambierebbe nel tuo stack e, se vale la pena, crea una carta di valutazione.

Il livello di padronanza di ogni argomento viene salvato nella KB, così Arianna sa cosa stai imparando e a che punto sei.

## Sicurezza e minacce

Il pericolo principale non è l'attacco da fuori, ma un agente che legge un contenuto ostile (una mail, una pagina web, un PDF) e viene indotto a usare ciò che sa o ciò che può fare.

**La combinazione da non permettere mai:** un agente che nello stesso momento ha accesso a dati privati, legge contenuti non fidati e può comunicare verso l'esterno. Ogni scheda agente deve toglierne almeno uno dei tre.

| Minaccia | Esempio | Contromisura |
| --- | --- | --- |
| Prompt injection | Una mail o una pagina contiene istruzioni nascoste per l'agente | Agenti che leggono contenuti non fidati senza strumenti di invio; gateway in uscita; contaminazione di sessione |
| Fuga di dati L2 | Un file privato finisce nel contesto di Claude Code o Codex | Default-deny, gateway unico d'uscita con controllo delle etichette, registro di ciò che esce |
| Azioni distruttive | Un agente cancella file o fa un push forzato | Sandbox e worktree, approvazione per le azioni irreversibili, backup provati |
| Furto di credenziali | Una chiave finisce in un prompt o in un log | Vault dei segreti, i modelli non vedono mai le chiavi, redazione automatica nei log |
| Accesso remoto abusivo | Qualcuno raggiunge il pannello da internet | Nessuna porta pubblica, solo VPN, autenticazione con passkey, token di sessione brevi |
| Catena di fornitura | Un pacchetto, un server MCP o una skill installati contengono codice ostile | Versioni bloccate, solo componenti fidati, ogni server MCP in un container senza accesso a dati privati |
| Costi fuori controllo | Un agente in loop consuma la quota o l'energia | Tetti di passi, tempo e costo per task, avvisi sul consumo |
| Uso scorretto degli abbonamenti | Strumenti che riusano i token di Claude o ChatGPT | Solo i binari ufficiali non modificati, uso personale, nessun token estratto o salvato |
| Perdita del server | Guasto o furto della macchina | Backup cifrati con copia fuori sede e ripristino provato |

**Registro delle azioni.** Ogni chiamata a un modello, ogni uso di uno strumento e ogni approvazione finisce in un registro che si può solo aggiungere, con una catena di hash per rendere evidenti le manomissioni. I contenuti L2 nei log sono ridotti a riferimenti, non copiati in chiaro.

**Backup e disco.** Disco cifrato sul server, backup quotidiani cifrati, e una prova di ripristino ogni trimestre messa come carta ricorrente sul cardwall.

## Stack tecnologico e hardware

Il nucleo è in TypeScript con un servizio vocale in Python, tutto in container, con un solo database e un solo archivio vettoriale, per tenere basso il numero di pezzi da far funzionare.

| Livello | Scelta proposta | Motivo |
| --- | --- | --- |
| Nucleo e API | TypeScript su Node.js, monorepo con pnpm, WebSocket per gli eventi | Unico linguaggio con interfacce, SDK degli agenti e pixel-agents |
| Database | PostgreSQL (task, eventi, registro, configurazione) | Affidabile, un solo posto per stato e code |
| Code e flussi | Coda basata su Postgres (per esempio pg-boss o Graphile Worker) | Nessun servizio in più; si passa a Temporal solo se serve |
| Vettori e memoria | Qdrant con Mem0, che già usi | Un solo archivio vettoriale, già conosciuto |
| Modelli locali | Server compatibile con l'API OpenAI dietro un'interfaccia sostituibile (oggi oMLX) | Si cambia server o hardware senza toccare gli agenti |
| Agenti cloud | `claude` e `codex` lanciati come processi, via un adattatore per ciascuno | Rispetta il vincolo "senza API" e isola il rischio di cambi di regole |
| Strumenti | Server MCP per gli strumenti condivisi tra Arianna, Claude Code e Codex | Gli stessi strumenti funzionano in tutti gli esecutori |
| Interfacce | Vue 3 e Tailwind per HUD e cardwall; pixel-agents incorporato | Competenza che hai già; l'ufficio pixel-art si riusa |
| Voce | Python con Pipecat, VAD Silero, Whisper locale, TTS da scegliere | Pipeline aperta e tutta locale |
| Segreti | `sops` con `age`, oppure un gestore di segreti self-hosted | Semplice, versionabile, senza servizi extra |
| Rete | VPN privata (WireGuard o Tailscale), nessuna porta pubblica | Accesso da fuori senza esporre il server |
| Osservabilità | Log strutturati più tracce dei modelli (per esempio Langfuse self-hosted, opzionale) | Serve per correggere il router con i dati |

**Decisione da prendere:** se preferisci restare su PHP e Laravel per l'API e le interfacce, funziona, ma il nucleo che gestisce processi, flussi in streaming e WebSocket diventa più scomodo e finiresti con due stack. La mia proposta è TypeScript per il nucleo, e Laravel solo se vuoi riusare qualcosa che hai già.

**Hardware.** Il Mac Studio M1 con 32 GB basta per le fasi 1, 2 e 3 con un modello locale da circa 27 miliardi di parametri quantizzato, ma è lento per la voce: lì serve un modello piccolo dedicato. Con oMLX hai visto crolli dopo molta attività per l'accumulo della cache; il router deve quindi poter ripiegare su un secondo server locale (per esempio llama.cpp o LM Studio) e riavviare automaticamente quello in difficoltà. Se in seguito il carico cresce, l'aggiornamento (Mac Studio più recente o un server con GPU) si fa cambiando solo il server dietro l'interfaccia.

## Costruire o adottare

Si scrivono le parti che contengono le tue regole (privacy, router, task, registro) e si adotta il resto dietro interfacce tue, così ogni componente si sostituisce senza toccare gli agenti.

| Parte | Scelta | Da cosa partire |
| --- | --- | --- |
| Gateway della privacy, etichette L0-L3 | Scrivere | Nessuno: è la tua politica |
| Router, orchestratore, schede agente | Scrivere | Studiare Hermes Agent per ciclo e memoria |
| Modello dei task, cardwall, registro eventi | Scrivere | Ispirarsi alla bacheca di Vibe Kanban |
| HUD (Vue) | Scrivere | Nulla di pesante; solo riferimenti visivi |
| Esecuzione durevole | Adottare | DBOS, su Postgres |
| Voce | Adottare | Pipecat, Silero, Parakeet o Whisper, TTS da provare |
| Ufficio pixel-art | Adottare | pixel-agents (MIT) in modalità standalone incorporata nell'HUD, con un tuo HookProvider; asset da sostituire se condividi la cartella |
| Fatture e documenti | Adottare | Parser FatturaPA, Docling o PaddleOCR-VL |
| Memoria e ricerca | Adottare | Qdrant e Mem0; Graphiti solo dopo la misura |
| Ripasso | Adottare | Una libreria FSRS, non un motore tuo |
| Sandbox | Adottare | Docker Sandboxes o sandbox-runtime |
| Test e tracce | Adottare | Promptfoo, Inspect AI, Langfuse |
| Coding | Adottare | Claude Code e Codex, come processi |
| Sicurezza degli agenti | Studiare | Pattern CaMeL, senza dipendere dal codice |
| Altri assistenti locali | Studiare | OpenJarvis (Apache-2.0): formato delle skill, brief giornaliero, rilevamento hardware; non come base |

**Regole di integrazione:** libreria o servizio dietro un'interfaccia tua e mai fork di un progetto grande; licenze permissive (MIT, BSD, Apache) e controllo di quelle copyleft prima di incorporare codice; versioni bloccate e revisione di ogni dipendenza che vede dati privati; un componente alla volta, con test nella suite di valutazione.

## Installazione e portabilità

Tutto sta in una cartella (`ARIANNA_HOME`) e si sposta o replica su un altro Mac o server, anche tramite Synology Drive. Un installer (`arianna install`) controlla i prerequisiti, scarica i modelli locali (i Qwen che usi già) leggendo un manifest con dimensione e checksum, avvia Postgres e Qdrant in Docker con i volumi dentro `data/` e lancia una diagnosi (`arianna doctor`). I pesi dei modelli non si sincronizzano: viaggia il manifest e si riscaricano dove servono. I database non si sincronizzano mai dal vivo, solo come dump cifrati (`arianna export` e `arianna import`). Al primo avvio un wizard (`arianna init`) guida la configurazione; poi tutto è modificabile dal file `arianna.toml` o dalla pagina Impostazioni. I modelli si scelgono da un catalogo corto deciso da te, che oggi contiene solo il Qwen già provato; un modello nuovo entra come sperimentale e diventa verificato solo dopo gli eval. Dettagli e stime (28-44 ore, già incluse nei totali) in `docs/INSTALLER-PORTABILITY.md`.

## Roadmap

&#91;embedded content: roadmap · 6 fasi, 6 criteri di uscita\]

Le fasi si fanno in ordine e ogni rombo è un controllo manuale da superare prima di andare oltre; i dati veri entrano nel sistema solo dopo il criterio della Fase 1, quando hai verificato che nessun dato L2 esce.

## Stime di tempo

Il progetto richiede circa 270-434 ore effettive di lavoro con Claude Code, cioè 338-543 ore con un margine del 25%; sono mie stime, non misurate, da ricalibrare dopo la Fase 0.

Le ore sono quelle davanti al progetto per uno sviluppatore esperto che fa scrivere quasi tutto il codice a Claude Code, comprese revisione, test e correzioni; non contano le attese di download, di modelli o di hardware.

| Fase | Ore effettive | Incertezza principale |
| --- | --- | --- |
| 0 Fondamenta | 14-23 | Bassa: repository, CI, registro eventi, primo test |
| 1 Nucleo e chat | 74-111 | Alta: affidabilità del modello orchestratore locale e correttezza del gateway |
| 2 Memoria e cardwall | 64-96 | Media: qualità di OCR e ricerca sui tuoi documenti veri |
| 3 HUD e ufficio pixel | 43-69 | Bassa: integrazione di pixel-agents con un provider tuo |
| 4 Voce e chiamate | 50-90 | Alta: latenza, qualità del TTS in italiano, telefonia SIP |
| 5 Studio e mentor | 25-45 | Media: scelta e qualità delle fonti |
| Totale | 270-434 | Con margine del 25%: 338-543 |

| Ore a settimana | Fino alla Fase 1 (già utile) | Progetto completo |
| --- | --- | --- |
| 10 | 11-17 settimane | 34-54 settimane |
| 20 | 6-8 settimane | 17-27 settimane |
| 30 | 4-6 settimane | 11-18 settimane |

Le Fasi 0 e 1 con margine valgono 110-168 ore. Le idee scelte dalla lista si aggiungono a queste ore. Regola di controllo: alla fine della Fase 0 confronta ore previste e reali; se lo scarto supera il 30%, si rifanno le stime delle fasi successive.

## Sviluppo con Claude Code

Per costruire Arianna conviene Claude Code nel terminale, dentro un repository git, perché il progetto è un grosso insieme di codice con test, worktree, hook e sottoagenti da governare, e la sessione si può riprendere e controllare passo per passo.

**Regola d'oro dello sviluppo:** durante la costruzione non dare a Claude Code i tuoi documenti reali. Il sistema che protegge i dati privati si sviluppa e si collauda con dati finti (fatture inventate, documenti di prova), e i dati veri entrano solo quando il gateway della privacy è testato.

**Struttura del repository**

```text
arianna/
  CLAUDE.md              regole del progetto per Claude Code
  docs/SPEC.md           questo documento, esportato in markdown
  docs/DECISIONS.md      registro delle decisioni (una voce per scelta)
  apps/core/             API, orchestratore, eventi, scheduler
  apps/hud/              interfaccia Vue (chat, HUD, cardwall)
  apps/voice/            servizio vocale Python
  packages/policy/       etichette di privacy e gateway d'uscita
  packages/router/       scelta del modello e adattatori (locale, claude, codex)
  packages/agents/       schede degli agenti (YAML più prompt)
  kb/                    knowledge base di esempio con dati finti
  .claude/               permessi, hook, sottoagenti, skill
```

**Cosa deve dire il CLAUDE.md.** Il progetto è privacy-first e nessun codice deve inviare dati L2 o L3 a un esecutore cloud; ogni modifica al gateway o al router ha test; si lavora a fasi con criteri di completamento; non si leggono mai file fuori dal repository; i comandi di build, test e lint; e le convenzioni (TypeScript rigoroso, niente dipendenze nuove senza una voce in DECISIONS.md).

**Flusso di lavoro**

1. Esporta questo documento come markdown in `docs/SPEC.md`.
2. Apri Claude Code nella cartella e usa la modalità piano: chiedigli di produrre il piano dettagliato della Fase 0 e della Fase 1, da approvare prima che scriva codice.
3. Un task alla volta, ognuno in un branch o worktree, con test scritti prima per `packages/policy` e `packages/router`.
4. Alla fine di ogni task: test, lint, commit con messaggio chiaro e aggiornamento di DECISIONS.md.
5. Alla fine di ogni fase: verifica dei criteri di completamento della roadmap, a mano, prima di passare alla successiva.
6. Usa un sottoagente revisore, e a fine fase un secondo parere con Codex sul diff.

**Primo prompt da dare**

```text
Leggi docs/SPEC.md e CLAUDE.md. Non scrivere codice ancora.
Proponi il piano dettagliato della Fase 0 (fondamenta) e della Fase 1
(nucleo agenti, router, chat), con l'elenco dei task, le dipendenze
e i test per ciascuno. Segnala le ambiguità della specifica e le
decisioni che devo prendere io, una per una.
```

**Da fare a mano prima di iniziare:** accedere a Claude Code e a Codex con i tuoi account, controllare nel tuo account come vengono conteggiati i consumi non interattivi, e scegliere dove farà girare il server nei primi mesi (il Mac Studio o una macchina dedicata).

## Rischi e decisioni aperte

Otto scelte erano aperte, una è già presa (linguaggio del nucleo); nessuna blocca la Fase 0, ma la scelta del server e la verifica dei consumi vanno fatte prima della Fase 1.

| Decisione | Opzioni | Proposta |
| --- | --- | --- |
| Linguaggio del nucleo | TypeScript, oppure PHP e Laravel | **Deciso: TypeScript** (2026-10-02), per avere un solo stack con interfacce e agenti |
| Dove gira il server | Mac Studio attuale, oppure macchina dedicata | Iniziare sul Mac Studio dietro un'interfaccia sostituibile |
| Consumi non interattivi degli abbonamenti | Verifica nel tuo account | Controllare prima della Fase 1 come vengono conteggiati `claude -p` e `codex exec` |
| Codice dei clienti con NDA | Locale o cloud | Locale (L2) finché non leggi i singoli contratti |
| Fonti e persone per il Mentor | La tua lista | Scegli tu 10-15 nomi e fonti primarie per iniziare |
| Sintesi e riconoscimento vocale in italiano | Due o tre candidati locali | Provarli con la tua voce all'inizio della Fase 4 |
| Numero e operatore telefonico | Operatore SIP italiano o estero | Decidere in Fase 4, dopo aver verificato costi e qualità |
| Editor della knowledge base | Obsidian oppure editor su misura | Obsidian all'inizio, editor su misura solo se serve |

| Rischio | Mitigazione |
| --- | --- |
| Le regole sugli abbonamenti cambiano | Adattatori sostituibili, test di contratto per ogni esecutore, controllo periodico delle pagine ufficiali |
| Il modello locale è troppo lento per compiti L2 grandi | Modello piccolo per estrazione e classificazione, elaborazioni notturne, aggiornamento dell'hardware dietro la stessa interfaccia |
| Il progetto cresce troppo | Fasi con criteri di uscita; dopo la Fase 1 lo usi davvero per qualche settimana prima di continuare |
| Troppa fiducia negli agenti | Autonomia a gradini, approvazioni, tetti di costo e registro delle azioni |
| Dati reali nel posto sbagliato durante lo sviluppo | Dati finti, regole nel CLAUDE.md e un hook che impedisce di leggere fuori dal repository |

**Prossimo passo:** esporta il documento in markdown come `docs/SPEC.md`, apri Claude Code nel repository vuoto e usa il primo prompt della sezione "Sviluppo con Claude Code".

## Fonti

Pagine aperte e lette per intero, controllate il Oct 2, 2026:

- [Claude Code: note legali e di conformità](https://code.claude.com/docs/en/legal-and-compliance), per le regole su abbonamento e autenticazione.
- [Claude Code: esecuzione programmatica](https://code.claude.com/docs/en/headless), per `claude -p`, i formati di output e `--bare`.
- [Autenticazione di Codex](https://learn.chatgpt.com/docs/auth), per il login con ChatGPT, la chiave API e la cache delle credenziali.
- [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents), licenza MIT, funzionamento e interfaccia `HookProvider`.
- [Pipecat](https://github.com/pipecat-ai/pipecat), licenza BSD-2-Clause, servizi supportati e trasporti.

Fonti secondarie viste solo come estratto di ricerca, da verificare: un [articolo sul pool di crediti per l'uso programmatico di Claude Code](https://tech-insider.org/claude-code-agent-pricing-split-2026/) e un [confronto tra framework vocali](https://futureagi.com/blog/best-voice-ai-frameworks-2026/) per la licenza di LiveKit Agents.
