# Registro delle versioni

Ogni lavoro finito e provato dall'utente diventa una versione, con un tag git `vX.Y.Z` sul commit di `main` che lo porta. Le versioni seguono [SemVer](https://semver.org/lang/it/) in 0.x finché Arianna non è pronta per i dati veri: **minor** (0.X.0) per una funzione nuova, cioè una decisione o un task chiuso; **patch** (0.x.Y) per correzioni e ritocchi. La 1.0.0 arriva quando `pnpm arianna:doctor` dà l'installazione pronta per i dati veri. I dettagli di ogni voce stanno in `docs/DECISIONS.md` (gli id D-NNN) e in `docs/PHASE-0-1-TASKS.md`. La chat web mostra questo file nella pagina "Novità" delle Impostazioni.

## [Non rilasciato]

### Aggiunto

- Pacchetto `@arianna/pptx`: `parseDeck` controlla il deck dello Studio con i limiti del contratto e `writePptx` scrive un file .pptx 16:9 (titolo, sottotitolo, paragrafi, punti elenco, colori, caratteri e dimensioni del testo, note del relatore) con codice nostro e `node:zlib`, senza dipendenze, in modo deterministico (I-19, D-184).
- Rotte dello Studio nel core (`/api/studio/:project/...`, contratto in `docs/STUDIO-API.md`): elenco, lettura e scrittura dei mockup con impronta, esportazione PPTX; eventi `studio.edit` e `studio.export` senza testo (I-19, D-184).
- Studio: nuova pagina «Studio» nella barra laterale (indirizzo `/studio`) con la scelta del progetto, a sinistra la conversazione diretta col Designer e a destra i mockup in una cornice isolata, varianti per gruppo, viste desktop, tablet e mobile, confronto di due varianti affiancate e lettura automatica dei file nuovi (I-19, D-184).
- Studio: commenti sugli elementi del mockup (clic con «Commenta», finestra spostabile con il campo già pronto, elenco modificabile) inviati insieme al Designer come un solo messaggio di revisione (I-19, D-184).
- Studio: modifica diretta di testo (anche i pezzi di testo di un titolo con un corsivo o un grassetto dentro), colori, dimensioni, spaziature e allineamento di un elemento, nella finestra spostabile, scritta nel file del progetto solo se non è cambiato nel frattempo (I-19, D-184).
- Studio: select «Stile» e «Skill» nella barra in alto, dai cataloghi di Open Design e delle skill e ricordate per progetto; ogni messaggio dello Studio al Designer (chat e commenti) le porta e il Designer le legge come testo di riferimento con la loro licenza, come su una card (migrazione 0058) (I-19, D-184).
- Studio: esportazione in HTML, in PDF con la stampa del browser e in PPTX per i mockup con diapositive `section[data-slide]`, con colori, caratteri e dimensioni misurati sulla pagina com'è a schermo (I-19, D-184).
- Studio: la conversazione col Designer del progetto si ritrova anche a pagina appena aperta e dopo il primo messaggio (il core tiene il progetto per nome) (I-19, D-184).
- Studio: «Elimina» sulla variante mostrata, con conferma nella pagina: il file va in `mockups/eliminati/` del progetto e il suo numero non viene più usato (I-19, D-184).
- Studio: con «Confronta» la variante a confronto si sceglie nella barra degli strumenti e la spunta facoltativa «Scorri insieme» fa scorrere le due pagine insieme (I-19, D-184).
- Studio: «Schermo intero» per la variante mostrata o per le due a confronto, con «Scorri insieme» e uscita con Esc (I-19, D-184).
- Chat: sotto «File modificati» di una delega, i mockup HTML scritti con il collegamento «Apri nello Studio» (I-19, D-184).

### Corretto

- Studio: lo stile e le skill scelti arrivano al Designer anche quando la conversazione continua una sessione già aperta (prima arrivavano solo al primo messaggio) (I-19, D-184).

### Sicurezza

- I mockup si mostrano in un iframe `sandbox="allow-scripts"` senza `allow-same-origin`, con in testa una Content-Security-Policy che vieta la rete; la pagina accetta solo messaggi di forma fissa dalla finestra del suo iframe (I-19, D-184).

## [0.75.0] - 2026-10-12

### Aggiunto

- Eval dell'agente Finanze sul modello locale (`pnpm eval:models`, gruppo `finance`, 18 casi finti in `evals/finance/`, anche con `--model <id>` sul candidato): strumento giusto, cifre riportate come le scrive lo strumento, rifiuto di consigli di investimento e di invii, injection nelle descrizioni dei movimenti (I-18, D-183).

## [0.74.0] - 2026-10-11

### Aggiunto

- Finanze nel core: conti, anteprima e importazione di estratti conto CSV ed Excel con i doppioni riconosciuti, movimenti con ricerca, categorie predefinite in italiano, regole, budget, riepilogo per mese e categoria, saldo, confronto con l'anno prima e controlli del mese, sulle rotte `/api/finance/*` del contratto `docs/FINANCE-API.md`; il file importato non si salva (I-18, D-183).
- Agente «Finanze»: consigli di bilancio sul modello locale con strumenti in sola lettura (`finance.summary`, `finance.search`, `finance.alerts`) che calcolano ogni cifra dal database, mai consigli di investimento; la sua conversazione è privata (I-18, D-183).
- Finanze: nuova pagina «Finanze» nella barra laterale (indirizzo `/finanze`) con conti, importazione di estratti conto CSV ed Excel con anteprima e profilo della banca correggibile, annullamento di un'importazione, movimenti filtrabili con categoria per riga e «crea una regola», categorie, regole e budget mensili, riepilogo con grafici disegnati in SVG (entrate e uscite per mese, spese per categoria, saldo di un conto, confronto con l'anno prima) e avvisi del mese che portano ai movimenti; un riquadro ricorda che i dati restano su questo computer e nessun modello cloud li legge (I-18, D-183).

### Sicurezza

- Segno `finance` salvato su conversazioni, task e run (migrazione 0056), che non torna mai indietro: il core ricrea i contesti segnati, gli output prendono la fonte `finance:derived`, il gateway rifiuta Claude, Codex, Telegram e ogni destinazione cloud (regola `finance`), nessuna declassificazione, il router non manda un task segnato al cloud e il database rifiuta un run cloud di un task segnato (I-18, D-183).
- Le tabelle delle finanze restano senza DELETE per il core: annullare un'importazione o togliere categorie, regole e budget passa dalla sola funzione `finance_delete`, controllata dal doctor; eventi solo con id e conteggi (I-18, D-183).

## [0.73.2] - 2026-10-11

### Corretto

- Chat: una conversazione lunga si apre davvero in fondo anche quando crediti, registri delle attività, schede di chiusura o la domanda di GOD «riparto da un riassunto?» arrivano dopo i messaggi; prima la domanda di GOD restava appena sotto il bordo (D-182).

## [0.73.1] - 2026-10-11

### Corretto

- GOD: quando l'installazione non è su main o ha modifiche non salvate in un commit, la pagina lo dice sopra i piani e «Prova», «Approva funzionalità» e «Non funziona» restano spenti con il motivo, invece di non partire senza avviso vicino al pulsante (D-179).

## [0.73.0] - 2026-10-11

### Cambiato

- GOD: «Riassumi e riparti» non è più un pulsante fisso; quando la chat è lunga (40 messaggi) GOD chiede in fondo «La chat è lunga: riparto da un riassunto?» con «Sì, riparti» e «No, continua qui», e dopo un «No» richiede solo 20 messaggi più tardi (D-182).

## [0.72.1] - 2026-10-11

### Corretto

- Ufficio: i personaggi in pausa non si sovrappongono più: posti in più sul divano e accanto al caffè, poi in piedi nell'angolo pausa; ognuno ha il suo posto e non cambia quando un altro inizia o finisce un lavoro (D-106).

## [0.72.0] - 2026-10-11

### Aggiunto

- Regole dei progetti: una select per ogni regola, «Entrambi / Solo Claude Code / Solo Codex»; vale nei lavori dentro Arianna e nell'esportazione, dove CLAUDE.md e AGENTS.md ricevono ciascuno le sue regole (D-181).
- Progetti, scheda File: pulsante «Aggiorna»; l'elenco dei file si rilegge anche dopo l'esportazione delle regole e tornando sulla scheda (D-181).

### Corretto

- Impostazioni: ciò che salvi vale subito, non un secondo dopo; un'esportazione delle regole fatta appena dopo «Salva» vede il testo nuovo (D-181).

## [0.71.0] - 2026-10-11

### Aggiunto

- Conoscenza di Progetti: una nota si apre con un clic e si modifica a mano (titolo, etichetta, intestazione, testo); la select della label dice quanto protegge ogni livello e una protezione che scende chiede conferma (D-180).

### Corretto

- Conoscenza di Progetti: le note non si aprivano (D-180).

## [0.70.0] - 2026-10-11

### Aggiunto

- Aggiornare il nome nelle Impostazioni (GOD g002, D-179).

## [0.69.1] - 2026-10-11

### Corretto

- GOD: «Prova» falliva su un test del proxy; pnpm check ora gira con le sole variabili ereditate, senza il proxy morto (D-179).

## [0.69.0] - 2026-10-11

### Aggiunto

- GOD: «Prova» e «Approva funzionalità» su ogni sottocompito, «Prova tutto» e «Approva tutto» sul piano: Arianna si riavvia sulla prova, poi l'approvazione porta il lavoro in main con versione, CHANGELOG e tag, e si riavvia di nuovo; «Non funziona» torna a main e manda le tue parole al Coder (D-179).

### Rimosso

- GOD: il pulsante «Prepara il ramo»; i comandi per unire a mano restano in «Unire a mano» (D-179).

## [0.68.0] - 2026-10-11

### Aggiunto

- «Parlane con GOD» accanto a ogni voce delle Novità: apre una conversazione nuova con GOD che parte dalla voce, dalle decisioni citate e dai commit e file della sua versione, presi dal git di `main` (I-6, D-178).

## [0.67.0] - 2026-10-11

### Aggiunto

- GOD, Arianna sviluppata da dentro Arianna: voce «GOD» nella barra sopra «Pensieri» e pagina con il clone e le conversazioni; GOD legge un clone del codice in `repos/arianna/main`, mai l'installazione (D-127, I-5 G1).
- `pnpm god:clone` e «Crea/Aggiorna il clone»: il clone si fa dal repository locale, senza `data/` né `config/arianna.toml`, e si rifiuta se contiene dati di un'installazione (D-127, I-5 G1).
- Il fascicolo di sviluppo: a ogni lavoro sul codice di Arianna l'agente legge lo stato di HANDOFF, le ultime decisioni, le fasi e i task aperti, scritti dal codice dai documenti del clone (D-127, I-5 G1).

- Il piano di GOD: una richiesta di lavoro diventa una scheda con i sottocompiti e i loro file; «Approva e avvia» li fa partire in parallelo secondo la quota, ciascuno in un clone suo con il Coder (D-127, I-5 G2).
- Il cruscotto di GOD: stato dei sottocompiti, file cambiati, revisione automatica del Reviewer, Ferma, Riprendi, Scarta e «Prepara il ramo» con i comandi per unirlo (D-127, I-5 G3).

- «Riassumi e riparti» nelle chat con GOD: una conversazione nuova che riparte da un riassunto scritto dal codice, mentre la vecchia resta intera (D-127, I-5 G4).

- Il personaggio pixel di GOD e la sua isola «GOD» nell'ufficio, dove siedono anche i Coder dei sottocompiti (D-127, I-5 G5).

### Cambiato

- Nell'ufficio le parti di un progetto contenitore stanno sull'isola del loro progetto invece che dietro l'archivio (D-127, I-5 G5).

### Corretto

- GOD: il Reviewer di un sottocompito non chiede più la scheda «Cartella con modifiche», i pulsanti del cruscotto rispondono subito, due «Approva e avvia» insieme non danno errore, eliminare una conversazione con GOD non dà errore (D-127).

### Sicurezza

- `docker compose` è rifiutato in un clone di GOD, così un clone non ricrea mai il database dell'installazione (D-127, I-5 G1).
- I cloni di GOD contengono solo il `main` dell'installazione: mai lo stash, gli altri rami o gli oggetti non raggiungibili; un clone fatto prima va rifatto (D-127).
- «Prepara il ramo» non fa il commit di `.gitignore`, `data/`, `repos/`, `config/arianna.toml`, file ignorati dall'installazione, collegamenti simbolici e repository annidati (D-127).
- Il cruscotto di GOD mette in evidenza i file che eseguono codice una volta uniti, e il merge è fissato sul commit preparato; il nuovo hook `pre-merge-commit` lancia `pnpm check` anche a ogni `git merge` (D-127).

## [0.66.0] - 2026-10-11

### Aggiunto

- Il riepilogo della settimana del diario dei lavori: `Workplan/diario/settimana-AAAA-Www.md`, scritto dal codice a ogni voce nuova con totali, un lavoro per riga collegato al giorno e i file cambiati più spesso (I-15 D2, D-177).

## [0.65.0] - 2026-10-11

### Aggiunto

- «Esporta in CLAUDE.md e AGENTS.md» nella scheda «Regole» di Progetti: le regole salvate nei file che Claude Code e Codex leggono da soli, in ogni parte del progetto, dopo un'anteprima e la tua conferma; un file tuo non si tocca mai, si aggiorna solo quello scritto da Arianna (D-176, I-14 R3).

## [0.64.0] - 2026-10-11

### Cambiato

- Il Reviewer controlla le modifiche anche rispetto alle regole del progetto e nomina ogni regola non rispettata (D-175, I-14 R3).

## [0.63.0] - 2026-10-11

### Aggiunto

- «Proponi bozza» nella scheda «Regole» di Progetti: il modello comune, le regole ricavate dai file del progetto (gestore di pacchetti, controlli da eseguire, file di stile, parti) e le convenzioni dei framework proposte dal modello locale; la bozza si rilegge e si salva (D-175, I-14 R2).

## [0.62.0] - 2026-10-11

### Aggiunto

- Le regole dei progetti: un modello comune in Impostazioni → Regole dei progetti e regole proprie per progetto nella scheda «Regole» di Progetti; Arianna le mette in testa a ogni lavoro di Claude o di Codex sul progetto, uguali per tutti e due (D-174, I-14 R1).

### Sicurezza

- Gli agenti non fanno mai commit: la cartella `.git` del progetto è in sola lettura anche per Claude, come già per Codex; le modifiche restano da rivedere (D-174, I-14 R1).

## [0.61.0] - 2026-10-11

### Aggiunto

- "Per il prossimo IM del cliente Rossi…": Arianna trova il progetto del cliente dall'anagrafica e, se ne ha più d'uno, chiede quale (D-173, I-17 S3).

## [0.60.0] - 2026-10-10

### Aggiunto

- La scheda Documenti del cliente: trascini o scegli un file (PDF, immagini, Office, testo, al più 25 MB), indichi tipo (Contratto, Preventivo firmato, NDA, Ordine o Altro con il tipo scritto), progetto, data e scadenza; lista con filtri per tipo, ricerca e archiviati; anteprima di PDF e immagini; "Apri" con l'app del Mac, "Mostra nel Finder", "Scarica", cambio di tipo o progetto, archivia e ripristina. Tutto nella cartella Privata del cliente (D-171, I-16 C2).
- Il messaggio del mattino della segretaria ricorda, una volta, i documenti dei clienti che scadono entro 30 giorni, con il solo nome del cliente e il tipo (D-171, I-16 C2).

## [0.59.0] - 2026-10-10

### Aggiunto

- La Dashboard del cliente: guadagno dell'anno, da fatturare, in attesa di pagamento e incassato; grafico per mese (per anno con "Tutto"), per progetto e per anno; interruttore Competenza (mese dell'IM, fattura divisa sui suoi IM) o Cassa (mese del pagamento); filtro per progetto; avvisi per IM senza prezzo o non fatturati (D-170, I-16 C3).
- Le fatture di tutti i progetti del cliente nella dashboard, con "Registra fattura" (scelta del progetto e degli IM) e "Pagata…" (D-170, I-16 C3).
- Il totale documento della fattura, com'è sulla fattura (IVA, ritenuta, bollo), obbligatorio per le fatture nuove, e la scadenza: calcolata dai giorni di pagamento del cliente o scritta a mano; "Totale e scadenza…" nella scheda IM, fatture scadute in rosso (D-170, I-16 C3).

### Cambiato

- Nella scheda IM i totali "In attesa di pagamento" e "Incassato" contano il totale documento delle fatture (l'imponibile per quelle registrate prima) (D-170).

## [0.58.0] - 2026-10-10

### Aggiunto

- La scheda "IM" della pagina Progetti: il calendario delle riunioni (giorno, ora, ogni quante settimane) scritto nel file `IM/calendario.md`, che si cambia anche in Obsidian e dà la data a ogni IM nuovo (D-169, I-11 P4d).
- La data di fine degli IM nello stesso calendario (`fine`): dopo quel giorno non nasce nessun IM, e all'ultimo le voci non finite restano come card nel cardwall (D-169, I-11 P4d).
- Il prezzo per IM del progetto, fissato su ogni IM quando si chiude, con l'eccezione di un singolo IM e "non fatturato"; l'elenco degli IM con stato, voci, importo e fatturazione; i totali da fatturare, in attesa di pagamento e incassati. Tutto Privato (L2), mai nei file IM (D-169, I-11 P4d).
- Le fatture: scegli gli IM chiusi da fatturare e registri la fattura fatta col tuo programma (numero, data, totale calcolato), la segni pagata, togli un IM o la annulli (D-169, I-11 P4d).
- La bozza `docs/mockups/clienti.html` delle schede Dashboard e Documenti del cliente (I-16 C2-C3).

## [0.57.1] - 2026-10-10

### Cambiato

- Il provino della voce non è più una voce a sé dell'indice delle Impostazioni: si apre dal pulsante "Provino della voce" nella sezione Voce, e la sua pagina (sempre su `/voce/provino`) ha "‹ Voce" per tornare indietro (D-066).

## [0.57.0] - 2026-10-10

### Aggiunto

- La pagina "Clienti" (`/clienti`): anagrafica completa per fatturare in Italia e all'estero (partita IVA e codice fiscale con il controllo, partita IVA UE, codice SDI, PEC, IPA per la pubblica amministrazione, indirizzi, pagamenti, IBAN), contatti con un principale, progetti collegati e logo; tutto Privato (L2), solo su questo computer (D-168, I-16 C1).
- Nell'intestazione di "Progetti" il nome e il logo del cliente del progetto, con il collegamento alla sua scheda (D-168).

## [0.56.0] - 2026-10-10

### Aggiunto

- "Scrivi il report" nella vista IM del cardwall: scegli ogni volta se lo scrive Arianna sul Mac o Claude nel cloud, in italiano o in inglese; il report per il cliente (fatto, in corso e prossimi passi) nasce dalle voci dell'IM e dal diario dei lavori della settimana, senza percorsi, commit, nomi degli agenti né importi, e va nella sezione `## Report` dell'IM, dove si rilegge e si copia (D-167, I-11 P4c).
- Verso Claude il report parte solo con dati Interni: un IM o un giorno del diario Privato lo ferma, e la pagina dice quale (D-167, I-11 P4c).
- Il mattino del giorno prima di un IM la segretaria lo ricorda: "Domani c'è l'IM-33 di progetto-test (giovedì 15 ottobre, 10:00): 3 voci ancora aperte." (D-167, I-11 P4c).

## [0.55.0] - 2026-10-10

### Aggiunto

- "Per il prossimo IM dobbiamo fare le fatture": Arianna scrive la voce nell'IM successivo (o in quello corrente, se lo dici), creandolo sette giorni dopo quando manca (strumento `im.add`, D-167, I-11 P4b); da una chat privata o dalla segretaria chiede prima conferma mostrando il testo esatto, perché l'IM è Interno e lo legge il Coder.
- Passata l'ora dell'IM (o della call spostata), la segretaria chiede nella sua chat, voce per voce, se le voci aperte sono finite: fatta, in parte (nell'IM successivo nasce la Parte N+1), non fatta (passa all'IM successivo); poi l'IM si chiude. Le chiusure aperte compaiono in "Attende te" (D-167).
- Ogni voce di un IM ha la sua card con tutti i dettagli: si crea al primo clic sulla voce, e lo stato va nei due versi (voce spuntata → card in Fatto, card in Fatto → voce spuntata) (D-167).

## [0.54.0] - 2026-10-10

### Aggiunto

- Gli IM del progetto (Iteration Meeting, la riunione settimanale con il cliente): un file `IM-<n>.md` per riunione nella cartella IM, con le voci a caselle (da fare, in corso, fatto, rimandato, annullato), `— Parte N` e la call spostata che non cambia la data (D-167, I-11 P4a).
- Nel cardwall la vista "IM": per progetto e per IM le colonne delle voci, cambio di stato trascinando o dal menu, "+ Voce" e "Nuovo IM" sette giorni dopo l'ultimo; una modifica fatta a mano nel file non viene mai sovrascritta (D-167).
- `pnpm demo:container` aggiunge al contenitore finto IM-32 e IM-33, anche quando c'è già (D-167).

## [0.53.0] - 2026-10-10

### Aggiunto

- Quando Claude Code o Codex lavorano su un progetto, possono leggere le note Interne delle sue cartelle di gestione (Workplan, IM…) da una copia di sola lettura fatta per quel lavoro, con l'elenco nel brief; la chat dice quante note riceve il Coder e quante restano sul Mac (D-166).

### Sicurezza

- Le note di un progetto escono verso Claude Code o Codex solo se sono al massimo Interne, una per una dal gateway (etichetta, scanner, valori del vault, una riga di registro ciascuna); i file di istruzioni (`CLAUDE.md`, `AGENTS.md`…), i link e le note Private o Riservate restano sul Mac (D-166).
- La sandbox di Claude Code e quella di Codex negano per intero il contenitore della parte su cui lavorano: le cartelle accanto (documenti, Workplan, IM…) non si leggono nemmeno con la shell; canarino nuovo negli eval deterministici e casi dal vivo `knowledge` (D-166).

## [0.52.0] - 2026-10-10

### Aggiunto

- Nell'ufficio pixel il cardwall appeso al muro in alto, accanto alla libreria: un clic, o E quando sei vicino, apre sopra l'ufficio il cardwall con gli stessi filtri della pagina; Esc o "Torna all'ufficio" tornano all'ufficio, e l'elenco accanto ha "Vai al cardwall" e "Apri subito" (D-165).

## [0.51.0] - 2026-10-10

### Aggiunto

- Nel dettaglio di una card del Designer, i campi facoltativi "Stile" (uno stile del catalogo di Open Design adottato) e "Skill" (una o più skill del catalogo generale), scelti da un menu e salvati sulla card (D-163).
- Quando la card del Designer parte, su Claude, Codex o in locale, lo stile e le skill scelti entrano nella consegna come blocco di dati con la loro licenza, entro i limiti di dimensione; uno stile o una skill non più nel catalogo si salta e la cronologia della card lo dice (D-163).

## [0.50.0] - 2026-10-10

### Aggiunto

- Nelle conversazioni di lavoro le card di un piano le scrive Claude a partire dalla sola richiesta; il modello locale riconosce anche le richieste brevi come "mi serve una landing" (D-164).

## [0.49.0] - 2026-10-10

### Cambiato

- I partecipanti della chat sono avatar piccoli nell'intestazione, accanto ad Arianna, con "· con Designer, Coder" nella riga di stato e un menu al clic con "Togli dalla chat"; sparisce la fascia "Con te e Arianna" (D-162).

## [0.48.0] - 2026-10-10

### Aggiunto

- Catalogo generale di skill nel formato `SKILL.md` di agentskills.io dai repository GitHub che scegli, in `data/catalogs/skills/`: per ogni sorgente "Scarica"/"Aggiorna" con il riepilogo (nuove, cambiate, tolte), "Usa questa versione" o "Scarta", commit fissato; `anthropics/skills`, `mattpocock/skills` e `vercel-labs/skills` suggerite con un clic; le skill di Open Design come sorgente fra le altre (D-161).
- Impostazioni → Agenti, sezione "Skill": sorgenti, ricerca nelle skill e lettura del testo con sorgente, commit e licenza; nel dettaglio di ogni agente la scheda "Skill" per assegnarle, salvate con la barra delle modifiche in `[agents.<id>] skills` (D-161).
- Le skill assegnate entrano nella consegna delle deleghe a Claude, Codex e agli agenti locali, dopo il prompt dell'agente, come blocco di dati delimitato entro un limite di dimensione (D-161).
- Rotte `/api/skills-catalog` e comando `pnpm skills:catalog [list|add|remove|update|adopt|discard]` (D-161).
- Le skill assegnate entrano anche nelle card che un agente diverso da Arianna lavora sul modello locale, dopo il suo prompt, entro i 16 KiB locali (D-161).
- Le skill saltate (oltre il limite o non più nel catalogo) lasciano un evento `skills.skipped` con agente, skill e motivo, e una riga nell'attività della delega (D-161).
- La sezione Skill mostra le voci di `sources.json` scritte a mano con un indirizzo non valido, ignorate (D-161).

### Cambiato

- Il catalogo di Open Design usa il meccanismo comune dei cataloghi git (`git-catalog.ts`), lo stesso delle sorgenti di skill; file e comportamento invariati (D-161).

### Sicurezza

- Il percorso di una skill letto dall'indice si ricontrolla (niente `..`, cartelle nascoste, file diversi da `SKILL.md`, slug di un'altra cartella) e deve stare dentro la cartella della sorgente; "Togli" tiene il blocco della sorgente fino alla fine e non cambia nulla se lo tiene un altro processo (D-161).
- Delle skill si scaricano solo i `SKILL.md` e i file di licenza, nominati uno per uno dai nomi dell'albero: script e risorse non si scaricano né si eseguono mai; l'indirizzo passa dal gateway (L0, web); il testo è L0 non fidato, mai un'istruzione per Arianna, che non riceve skill, né per un agente con `untrusted_content` chiuso (D-161).

## [0.47.0] - 2026-10-10

### Aggiunto

- Arianna scompone un lavoro grande in card: lo strumento `task.plan` propone da 2 a 8 card con chi le fa e cosa aspettano, e la chat le mostra in una scheda con "Crea le card" e "Non ora"; le card nascono solo con il sì, con le loro dipendenze, e Arianna risponde con l'elenco senza richiamare il modello (D-159).
- Le card degli agenti partono: "Avvia" nel dettaglio di una card di un agente mai partita; quelle di un piano approvato partono da sole appena non aspettano più nulla; per un agente con esecutori cloud il lavoro passa dalla strada della delega (progetto approvato, sandbox, gateway, `cloud_max_label`), altrimenti dal modello locale; il rapporto finisce nella card, che va in Da verificare (D-159).
- Scelta del modello a ogni lavoro: chiave `executor_choice: ask` delle schede agente; prima di lavorare la card chiede "Claude, ChatGPT o Modello locale?" con le sole strade ammesse e il perché di quelle escluse, in "Decisioni in attesa", nel dettaglio della card e, per le card di un piano, nella chat del piano (D-159).
- "Riprendi" e "Riprova" nel dettaglio di una card che il motore ha fermato o che è fallita (`POST /api/cards/:id/resume` e `/retry`); trascinarla in Da fare fa lo stesso (D-159).
- Agente Designer (`agents/designer.yaml`): mockup HTML autonomi in `mockups/` del progetto (`docs/mockups/` per Arianna), varianti numerate, legge il `DESIGN.md` del progetto; Claude Code, Codex o modello locale, a scelta dell'utente a ogni card (D-159).
- Migrazione `0045_card_plans.sql`: approvazioni `plan` ed `executor`, colonna `approvals.choice` (D-159).
- Guida di stile di Arianna in `docs/DESIGN.md`, dai token della chat web: il Designer la legge prima di disegnare per Arianna (D-159).

### Cambiato

- Il dettaglio di una card di un agente mostra il suo lavoro: decisioni in attesa, ultima scelta del modello, rapporto con i file scritti nel progetto (D-159).
- Una card fermata dal motore non è più rifiutata quando torna in Da fare: riprende o riprova (supera il rifiuto "arriverà con C3" di D-152) (D-159).
- Il modello locale prende una card solo entro il `max_label` dell'agente; sopra, la card aspetta in Aspetta con il motivo di ogni strada esclusa (D-159).
- Su Telegram un piano e la scelta del modello arrivano come avviso senza pulsanti: si decidono solo dalla chat web (D-159).
- "Avvia" rifiuta con un motivo chiaro una card di Arianna o di un agente che non esiste più; il Designer in locale sa che non scrive file e descrive la proposta (D-159).

### Corretto

- Anche la delega di Arianna al Designer dalla chat chiede prima con chi lavorare (Claude, ChatGPT o modello locale, solo le strade ammesse con il perché delle escluse), nella scheda sotto il messaggio: prima la delega partiva su Claude Code senza chiedere. "Non ora" fa rispondere ad Arianna che il lavoro non è partito; la scelta si ricontrolla quando il lavoro parte (D-159).

## [0.46.0] - 2026-10-10

### Aggiunto

- Catalogo degli stili e delle skill di Open Design (nexu-io/open-design, Apache-2.0) come solo testo in `data/catalogs/open-design/`: download superficiale e parziale con git (solo `DESIGN.md`, `manifest.json`, `SKILL.md`, licenza e NOTICE), indice di nomi e descrizioni senza i corpi, commit adottato in `open-design.lock.json` (D-160).
- Impostazioni → Agenti, sezione "Stili di Open Design": "Scarica catalogo" (poi "Aggiorna catalogo") scarica la versione nuova a parte e mostra quanti stili e skill sono nuovi, cambiati o tolti; si adotta solo con "Usa questa versione", "Scarta" la cancella; elenco degli stili da sfogliare con il testo e la riga di credito con la licenza (D-160).
- Rotte `/api/design-catalog` (stato, aggiorna, adotta, scarta, elenco, testo di uno stile con l'avviso di licenza in testa) e funzione `designStyleText` per la consegna al Designer (D-160).
- Comando `pnpm design:catalog [status|update|adopt|discard]`, gli stessi passi dal terminale (D-160).
- Il core e il comando non si pestano i piedi sul catalogo: file di blocco `data/catalogs/open-design.busy` con il pid (uno lasciato da un processo morto si riprende), "Il catalogo è occupato da un altro processo" mentre l'altro scarica, adotta o scarta; `status` legge soltanto; uno scambio di versione interrotto torna indietro o va avanti al riavvio, mai a metà; niente download nuovo mentre una versione scaricata aspetta (D-160).

### Sicurezza

- Del catalogo di Open Design non si esegue nulla: git con argomenti fissi, senza hook, configurazione globale, credenziali né LFS, link simbolici scritti come file, cartella `.git` cancellata dopo la lettura del commit; limiti di dimensione e numero dei file, link e nomi non validi scartati, licenza non Apache-2.0 rifiutata; l'indirizzo del repository passa dal gateway (L0, web) (D-160).
- Catalogo di Open Design: il numero dei file si controlla dai nomi degli alberi prima di scaricarne i contenuti; git ha come HOME una cartella vuota (niente `.netrc` né attributi dell'utente); il testo di uno stile e il NOTICE perdono i caratteri di controllo, bidirezionali e di larghezza zero, tenendo a capo e tabulazioni (D-160).

## [0.45.0] - 2026-10-10

### Aggiunto

- Telefono "Chiama" nell'intestazione della chat: in ogni conversazione privata con Arianna (Segretaria compresa) e in ogni chat diretta con un agente, mai in incognito, nelle chat di sistema o di lavoro con Arianna; spento con il motivo al passaggio quando la voce non è pronta, la conversazione è archiviata o c'è già una chiamata (D-158).
- Il telefono anche nella pagina vuota di una chat nuova, privata o diretta: la chiamata crea la conversazione e chiama lì (D-158).
- Pulsante del tema nella barra in alto, accanto a quello degli agenti: ogni clic passa Chiaro → Scuro → Auto e l'icona mostra il tema attivo; la stessa scelta in Impostazioni → Aspetto (D-158).
- Chiamate nella chat diretta con un agente locale: risponde lui sul suo modello locale, con le istruzioni della sua scheda adattate al parlato e la cronologia della chat fino a ciò che la scheda può leggere (D-158).
- Chiamate nella chat diretta del Coder: una voce locale fa da ponte, passa la frase come un messaggio, dice "Lo passo al Coder, ti dico quando ha finito" e legge la risposta quando arriva; un lavoro alla volta (D-158).
- Le chiamate dicono chi risponde: campi `agent` e `answerer` nelle risposte dell'API delle chiamate e nell'evento `call.ringing` (D-158).
- La chat scritta con un agente locale ricorda quanto detto in chiamata: le frasi a voce entrano nella sua cronologia, entro il tetto della scheda (D-158).

### Cambiato

- La voce "Chiama" esce dalla barra laterale (D-158, supera D-097 in questo punto).
- Schermata della chiamata, chiamata in arrivo e ricevute nella chat dicono il nome di chi risponde: Arianna o l'agente della chat diretta (D-158).
- Escono dalla barra laterale il selettore del tema e la riga degli agenti: la colonna Agenti si apre dal pulsante in alto a destra (D-158).
- Finestra "Nuova conversazione" più larga e ordinata: le quattro schede non vanno mai a capo ("Agente" al posto di "Con un agente", due righe sotto i 640 px), frecce per cambiare scelta e Invio per aprire, nomi degli agenti con l'iniziale maiuscola, descrizioni delle schede ufficiali in italiano, avviso del cloud con titolo breve e "Dettagli", pulsante principale in colore d'accento (D-158).
- Una chiamata programmata o "quando finisci" in una chat diretta non squilla se l'agente non può rispondere: diventa saltata (`agent-off`, migrazione `0044`) con una nota in chat (D-158).
- Saluti e testi fissi di una chiamata in una chat diretta dicono il nome dell'agente; le chiamate programmate e "chiamami quando finisci" in una chat diretta seguono le regole della scheda dell'agente (rifiuto `agent-off`, 409) (D-158).

### Corretto

- Le classi `dark:` della chat seguono il tema scelto e non solo quello del sistema: con "Chiaro" su un Mac scuro i colori della sintassi nei Progetti restavano quelli scuri (D-158).

### Rimosso

- L'orologio "Fatti chiamare più tardi" e il modulo "Chiamami alle…" dall'intestazione della chat: per le chiamate a un'ora ci sono le routine (D-158).

## [0.44.0] - 2026-10-10

### Aggiunto

- "Elimina" per sempre di una conversazione direttamente dalla lista, dalle chat di sistema e dalle Archiviate, con la conferma "Eliminare per sempre?": sparisce tutto ciò che ha lasciato, registro di cosa è uscito verso il cloud compreso; le card create da lì restano senza il legame; i lavori in corso si fermano prima (D-157).
- "Elimina" per sempre di una nota nella pagina della Conoscenza, nei Pensieri (lista e pannello) e nella scheda "Conoscenza" di un progetto: il file si cancella dal disco, il riordino in coda si ferma, i collegamenti dei Pensieri diventano "nota eliminata" (D-157).

### Cambiato

- La catena degli eventi si ricuce dopo un'eliminazione chiesta dall'utente, con una sola riga `events.rewoven` senza contenuto: il doctor la dà integra (migrazione `0043`, D-157; supera D-046 e D-057 in questo punto).
- La conferma della cancellazione nelle Archiviate ora elimina tutto, registro compreso, come dalla lista (D-157).

### Sicurezza

- L'eliminazione di una conversazione è rifiutata se un id delle sue righe coincide con quello di un'altra riga: un id falsificato non porta via gli eventi di altre conversazioni (D-157).
- Una chiamata viva rifiuta l'eliminazione prima di fermare i lavori; un rifiuto dopo lo stop rimette in coda i passi fermati, e le cartelle di lavoro dei run eliminati si cancellano (D-157).

## [0.43.0] - 2026-10-10

### Aggiunto

- I link salvati in Conoscenza si scaricano e si riassumono col modello locale: la nota ha Riassunto, Punti chiave, Contesto, il contenuto citato e il testo originale; per i post di X il testo arriva dall'oEmbed ufficiale di X (D-154).
- Impostazioni → Link scaricati: l'elenco dei siti i cui link si scaricano da soli al riordino, con la conferma delle uscite; all'inizio è vuoto (D-154).
- Nella pagina Pensieri, «Scarica e riassumi» per un link di un sito non in elenco o non ancora scaricato, anche su una nota già riordinata (D-154).

### Sicurezza

- Ogni richiesta di un link (anche i rimandi e la chiamata a publish.twitter.com) passa dal gateway con una destinazione propria: solo l'indirizzo, solo con il tuo consenso (sito in elenco o clic), sempre con lo scanner; il registro non scrive mai l'indirizzo (D-154).
- Lo scaricamento dei link non raggiunge mai questa macchina né la rete locale (ogni indirizzo controllato alla connessione e a ogni rimando), manda solo l'indirizzo del link senza cookie, ha un tempo e una dimensione massimi, e il testo della pagina arriva al modello come contenuto, mai come istruzioni (D-154).

## [0.42.0] - 2026-10-10

### Aggiunto

- La conversazione della Segretaria ha il suo indirizzo `/segretaria`: il pulsante porta lì, una ricarica la riapre senza una sessione nuova, un vecchio `/c/<id>` diventa `/segretaria` (D-156).
- Sopra la chat della Segretaria un mini cardwall: In ritardo, Oggi, Domani, Prossimi giorni (+N più avanti), con gli impegni e le card tue che hanno una data, la riga «Fatti oggi» dove trascinare per segnare fatto e «Apri il cardwall →»; richiudibile, la scelta resta nel browser (D-156).

### Cambiato

- Il vecchio elenco degli impegni sopra la chat della Segretaria è sostituito dal mini cardwall; il clic apre lo stesso dettaglio del cardwall (D-156).

## [0.41.0] - 2026-10-10

### Aggiunto

- Conoscenza: la fonte "Arianna" con i documenti di sviluppo (decisioni una per pagina, proposte, specifiche, novità) letti direttamente da `docs/` e `CHANGELOG.md`, in sola lettura e Privati (L2); Arianna li cerca e li legge con `kb.search` e `kb.read` come `arianna/…`, mai in una conversazione di lavoro (D-155).

## [0.40.4] - 2026-10-10

### Corretto

- Il test del controllo dei segni di conflitto, eseguito dentro l'hook pre-commit, ereditava le variabili `GIT_*` e agiva sul repository vero (impostava `core.bare` o svuotava l'indice di un worktree): ora le toglie.

## [0.40.3] - 2026-10-10

### Cambiato

- L'hook pre-commit rifiuta un commit che contiene ancora i segni di un conflitto di unione (`<<<<<<<`, `=======`, `>>>>>>>`), anche nei file che `pnpm check` non legge come il CHANGELOG (D-018).

## [0.40.2] - 2026-10-10

### Cambiato

- Cardwall: i filtri, l'ordine e le colonne sono chip con un menu al posto delle select di sistema; il filtro attivo mostra il suo valore colorato con la x per toglierlo, e la barra resta su una riga (D-152).

## [0.40.1] - 2026-10-10

### Cambiato

- Le domande della pagina «Sviluppo di Arianna» riscritte in modo chiaro (contesto semplice, opzioni con le conseguenze, esempio); chiuse, con la fonte, le 27 già decise (D-122).

## [0.40.0] - 2026-10-10

### Aggiunto

- Pagina «Sviluppo di Arianna»: accanto a ogni domanda senza risposta il pulsantino «Riscrivi più chiara», che chiede a Claude Code di riscriverla con contesto, opzioni ed esempio (nessun modello: una voce fissa in `data/dev/RISPOSTE.md`); la domanda resta aperta e mostra «Riscrittura chiesta» (D-153).

## [0.39.0] - 2026-10-10

### Aggiunto

- Il cardwall: una pagina con le card di Arianna, quelle scritte a mano ("+ Card") e gli impegni della segretaria, in cinque colonne (Da fare, In corso, Aspetta, Da verificare, Fatto) con interruttori per separare Inbox e Falliti o nascondere una colonna; filtri per progetto, tipo, chi lo fa, scadenza ed etichetta; card da trascinare, e una vista Lista come una tabella (D-152).
- La card completa: titolo modificabile, descrizione in markdown, "Quando è finito" per le card degli agenti, priorità (Bassa-Altissima), data di esecuzione e scadenza, checklist, link, allegati (copie private sul Mac, fino a 20 MB) e la cronologia di cosa le è successo (D-152).
- "Aspetta": una card può aspettarne altre; finché non sono fatte sta in Aspetta con "aspetta: …" e il suo lavoro non parte, poi torna da sola in Da fare e il lavoro trattenuto riprende (D-152).

## [0.38.0] - 2026-10-10

### Aggiunto

- Il resoconto di fine giornata della segretaria: rispondendo al promemoria della sera ("il pane rimandalo a domani, il forno era chiuso; le piante no, ero fuori") Arianna propone una sola scheda "Resoconto" con l'esito di ogni impegno (fatto, non fatto, rinviato al giorno calcolato dal codice) e il motivo; confermata, annota tutto, e un rinvio crea l'impegno nel giorno nuovo. Anche "rimandalo a domani, ero fuori" detto in un altro momento diventa un rinvio con il suo motivo. Il promemoria del mattino parte dai rinvii, l'elenco mostra esiti e motivi (D-151).

### Cambiato

- Un clic su "Segretaria" dopo un promemoria di oggi non ancora risposto fa partire la sessione dal promemoria, così Arianna legge il resoconto a cui stai rispondendo (D-151).

## [0.37.1] - 2026-10-10

### Cambiato

- La chat web su un portatile (sotto 1600 px di larghezza o 896 px di altezza): la colonna Agenti parte chiusa e si apre sopra la pagina, le conversazioni mostrano l'etichetta come pallino (non sul telefono) e il titolo più lungo, la riga sotto i messaggi va a capo per pezzi interi, spaziature verticali più strette, e nelle Impostazioni indice più stretto, elenco e scheda dei modelli uno sopra l'altro quando lo spazio non basta; sullo schermo grande non cambia nulla (D-150).

## [0.37.0] - 2026-10-10

### Aggiunto

- Segretaria: i promemoria della mattina, del dopo pranzo e il resoconto di fine giornata agli orari e nei giorni della sezione Segretaria delle Impostazioni; il messaggio lo scrive Arianna con il codice nella conversazione della segretaria, una volta per giorno e momento, niente se non c'è nulla da dire, con la notifica «Arianna ha un promemoria» senza il testo degli impegni (I-12 S2, D-149).

## [0.36.0] - 2026-10-09

### Aggiunto

- Segretaria: «sposta la banca a venerdì» sposta un impegno a un altro giorno o a un'altra ora; il giorno nuovo lo calcola il codice e la scheda di conferma mostra il vecchio (barrato) e il nuovo; l'orario resta quello di prima se non ne dici un altro (I-12, D-148).

## [0.35.0] - 2026-10-09

### Aggiunto

- Il diario dei lavori: alla fine di ogni lavoro del Coder (o di un altro agente nel cloud, come il Reviewer) su un progetto (riuscito, non riuscito o fermato, su Claude o su Codex, delegato da Arianna o nella chat diretta) Arianna scrive da sola, con il codice, una voce in `Workplan/diario/AAAA-MM-GG.md` della conoscenza del progetto: ora, chi e con quale modello, parte, esito, richiesta, file cambiati, commit, riassunto e collegamento alla conversazione; solo ciò che era già uscito verso il cloud, mai nelle incognite (I-15, D-147).

## [0.34.2] - 2026-10-09

### Cambiato

- Segretaria: ogni clic sul pulsante «Segretaria» apre una sessione nuova; Arianna ricorda solo i messaggi da quel clic in poi, senza riassunti delle parti vecchie, e una riga sottile nella chat segna dove comincia la sessione. Riaprire la conversazione in altri modi non la azzera (I-12, D-146).

## [0.34.1] - 2026-10-09

### Corretto

- Chat: aprendo una conversazione si vede l'ultimo messaggio, anche venendo da un'altra pagina o da un link e quando il riquadro Impegni della segretaria arriva dopo; la lista resta in fondo finché non risali a leggere (segnalazione dell'utente del 2026-10-09).

## [0.34.0] - 2026-10-09

### Aggiunto

- Un progetto è un contenitore: se la sua cartella non è un repository git, le parti sono le sottocartelle con un proprio git (o quelle elencate in `parts`), e il Coder lavora in una parte alla volta, mai nel contenitore; i progetti di oggi restano una parte sola (I-11, D-145).
- Pagina Progetti: il progetto con le sue parti, File, Git e Servizi per parte (I-11, D-145).
- Scheda «Conoscenza» nella pagina Progetti: le cartelle di gestione con il selettore d'etichetta per ciascuna (Workplan e IM Interne, le altre Private, finché non scegli tu), con la conferma che dice «scende» quando un'etichetta si abbassa, e le note con il loro distintivo (I-11, D-145).
- «+ Conoscenza»: una nota nuova in una cartella di gestione esistente o nuova (il nome lo scrivi tu), con titolo ed etichetta mostrata prima di salvare (quella della cartella, o più alta); l'intestazione la scrive il codice come `kb:capture` (I-11, D-145).
- Per un progetto che è un solo git (come `demo`) le note stanno in `kb/progetti/<progetto>/`, fuori dal codice, con le stesse cartelle ed etichette (I-11, D-145).
- La ricerca di Arianna (`kb.search`, `kb.read`) trova anche le note dei progetti, ciascuna con la sua etichetta; solo sul computer (I-11, D-145).
- `pnpm demo:container` scrive il contenitore finto `repos/progetto-test` per provarlo (I-11, D-145).

### Cambiato

- Il doctor e il wizard accettano come progetto anche una cartella non git che contiene parti con un proprio git (I-11, D-145).

### Sicurezza

- Le etichette delle cartelle di gestione stanno in `[[project.folder]]` di `arianna.toml` e cambiano solo con i due passi della sezione privacy «Progetti» (I-11, D-145).
- Quando il contenitore è esso stesso un git, una nota o un file sopra Interno nelle sue cartelle di gestione tiene fuori il Coder finché la tappa P3 non nega i file uno a uno (I-11, D-145).
- `kb/progetti/` è fuori da git come `kb/inbox/`: le note dei progetti scritte con «+ Conoscenza» non finiscono mai nel repository di Arianna (I-11, D-145).


## [0.33.0] - 2026-10-09

### Aggiunto

- Barra a sinistra: il pulsante «Segretaria» apre la sua conversazione privata, una sola che continua nel tempo, dove risponde Arianna (I-12 S1, D-144).
- La segretaria segna un impegno detto in chat ("giovedì alle 15 devo andare in banca"): il giorno lo calcola il codice dalle tue parole e lo mostra in una scheda da confermare prima di salvarlo (I-12 S1, D-144).
- «Cosa ho domani?»: l'elenco degli impegni lo scrive il codice dal database, mai il modello; anche "oggi", un giorno della settimana, "questa settimana", "i prossimi 7 giorni", "questo mese" e "il mese prossimo"; con un intervallo che non sa calcolare Arianna non chiede più la data di oggi (I-12 S1, D-144).
- Un impegno si segna fatto con il pulsante «Fatto» nell'elenco sopra la conversazione della segretaria, o dicendolo in chat con conferma (I-12 S1, D-144).
- Impostazioni → Segretaria: promemoria accesi o spenti, i tre orari (9:00, 14:30, 18:30) e i giorni, salvati in `arianna.toml`; i promemoria automatici arrivano con la tappa S2 (I-12 S1, D-144).

### Corretto

- Chat: scendendo in fondo a una conversazione lunga scorreva tutta la pagina, finendo sotto i menu; i testi per i lettori di schermo delle liste lunghe allungavano la pagina oltre lo schermo. Ogni area che scorre ora li tiene dentro (regola globale in `style.css`, segnalazione dell'utente del 2026-10-09).

### Sicurezza

- Gli impegni sono privati (almeno L2): la conversazione della segretaria non delega a nessun agente, gli strumenti degli impegni si danno solo a schede che girano sul modello locale, la conferma si decide solo dalla chat web e notifiche ed eventi non ne portano mai il testo (I-12 S1, D-144).

## [0.32.0] - 2026-10-07

### Aggiunto

- Impostazioni → Modelli: «Prova in chat» nella scheda di un modello locale scaricato apre una conversazione in incognito dove risponde solo quel modello, sul Mac, senza Arianna, strumenti né archivio (D-142).

## [0.31.0] - 2026-10-07

### Aggiunto

- Impostazioni → Modelli: "Cerca su Hugging Face" trova i modelli MLX pubblici e mostra la scheda di uno (file, peso, licenza, sha256 dei pesi, motivi per cui non si può aggiungere) (I-10, D-139).
- "Aggiungi al catalogo" scrive il modello in `config/models.user-catalog.yaml`, fuori da git, fissato a un commit, sperimentale e senza ruoli; si scarica poi con «Scarica» (I-10, D-139).
- Nella scheda di un modello aggiunto da Hugging Face: «Promuovi» sceglie i ruoli che può avere, «Togli dal catalogo» lo toglie scrivendo l'id (I-10, D-139).

### Sicurezza

- La ricerca e la scheda di Hugging Face passano dal gateway come uscita L0 verso il web: esce solo il testo cercato o l'id scelto, registrato in `gateway_log` senza il testo; niente account né token, l'API solo in HTTPS verso huggingface.co; i file piccoli letti quando si aggiunge un modello si controllano contro il commit (D-139).
- Dal catalogo restano fuori i pesi pickle, il codice dei repository e i file nascosti (D-139).

## [0.30.0] - 2026-10-07

### Aggiunto

- Codex ha tre modelli come Claude: Luna, Sol e Astra, ciascuno con interruttore e nome esatto in Impostazioni → Modelli; il router mette Sol accanto a Sonnet e Astra accanto a Opus, così con Claude senza quota passa a Codex invece di aspettare; Luna solo se la scegli tu (D-141).
- La chat diretta dice in testa chi risponde, con quale modello e con quale è arrivata l'ultima risposta (D-141).

### Cambiato

- Il vecchio alias `codex` di `arianna.toml`: `false` spegne Luna, Sol e Astra, un nome esatto va al modello della sua famiglia, nelle schede degli agenti si legge come `sol`; le conversazioni che lo avevano scelto passano a Sol (migrazione 0034, D-141).

## [0.29.0] - 2026-10-07

### Aggiunto

- Codex lavora come Claude: Arianna gli delega i passi nei progetti quando il router lo sceglie, e la chat diretta con un agente può andare a Codex scegliendone un modello (D-140, D-111 tappa C).
- Scheda Reviewer: rivede le modifiche di un progetto senza cambiare file, con Codex per primo e poi Claude Code; Arianna può delegarle e le si può scrivere direttamente (D-140).

### Cambiato

- Avviso, distintivo "va a …" e conferma dei messaggi lunghi della chat diretta nominano Claude o Codex (tutti quelli a cui può andare, quello del modello scelto per primo); il selettore offre solo i modelli degli esecutori dell'agente (D-140).
- Cambiando modello fra Claude e Codex nella chat diretta, il primo messaggio porta con sé gli ultimi scambi: la sessione dell'altro esecutore non si riprende (D-140).
- Impostazioni → Modelli: Codex non risulta più "non collegato" quando il suo adattatore gira (D-140).

### Sicurezza

- Su Claude Code un agente senza il permesso di scrivere non ha più `Bash`: la sandbox di Claude gli lascerebbe modificare il progetto con un comando (D-140).

## [0.28.0] - 2026-10-07

### Aggiunto

- Adattatore di `codex exec` in `packages/executors`, con lo stesso contratto di quello di `claude`: gateway, cartella preparata, ripresa, incognito, tetti; il core non lo usa ancora (task 1.16, D-138).
- Eval dal vivo di `codex`: contratto (10 casi) e canarino (9 casi, quelli sui file come comandi diretti sotto `codex sandbox`) (task 1.16, D-138).
- `pnpm eval:live --tag <tag>` lancia solo i casi con quell'etichetta, per esempio quelli di `codex` senza consumare quota di Claude (D-138).

### Sicurezza

- Profilo di confinamento di Codex: niente configurazione, istruzioni né skill dell'utente (lancio rifiutato se esiste un suo `AGENTS.md` globale), permessi su misura che chiudono home, `ARIANNA_HOME`, `/tmp` e la `.git` della cartella di lavoro, niente rete, venti funzioni spente, chiavi verificate con `--strict-config`; il run si ferma con una chiamata MCP o una ricerca web (task 1.16, D-138).

## [0.27.0] - 2026-10-07

### Aggiunto

- Impostazioni → Modelli, azioni dalla scheda di un modello locale: Scarica con avanzamento, ripresa e verifica sha256, Verifica, Scarica dalla memoria, Togli dal disco nel cestino `data/models/eliminati` con l'id scritto come conferma, e Svuota il cestino; ogni azione chiede conferma con dimensione e cartella (I-3 M4, D-137).

### Cambiato

- La logica dei file dei modelli (`pnpm arianna:models`) passa dall'installer al nucleo (`model-files.ts`, `model-http.ts`), così la pagina Modelli può scaricare e verificare (I-3 M4, D-137).

### Corretto

- Nell'elenco della pagina Modelli il nome si legge sempre per intero: le etichette stanno sotto il nome, che va a capo invece di essere tagliato (D-137).

### Sicurezza

- L'id `eliminati` è vietato nel catalogo dei modelli; un modello con un ruolo, in memoria o con una prova aperta non si toglie dal disco (D-137).

## [0.26.0] - 2026-10-07

### Cambiato

- Una voce sola **Modelli** nelle Impostazioni al posto di Modelli locali, Prove dei modelli e Modelli cloud: elenco dei modelli locali e cloud con filtri e ricerca, scheda di ogni modello, prove, ruoli e interruttori nella stessa pagina; gli indirizzi vecchi portano alla nuova (I-3 M3, D-137).

### Aggiunto

- Schede dei modelli nei cataloghi: campi facoltativi nel catalogo locale e `config/cloud-models.catalog.yaml` per Sonnet, Opus, Fable e Codex, ogni dato con fonte e data di lettura (I-3 M1, D-137).
- `GET /api/models/overview`: un elenco unico dei modelli locali e cloud con file presenti, ruoli, agenti, ultima prova, memoria di oMLX, interruttori e uso tipico dal router (I-3 M2, D-137).

## [0.25.0] - 2026-10-07

### Aggiunto

- Modalità incognita: in "+ Nuovo" la voce Incognito apre una conversazione privata o di lavoro che non compare in lista, ricerca e ufficio, con la scheda "Cosa resta fuori da Arianna" prima del primo messaggio e un'intestazione scura con "Termina" (D-136).
- Chiusura di un'incognita con "Termina", dopo 10 minuti senza pagina aperta o al riavvio di Arianna: il lavoro in corso si ferma, i testi si cancellano e la scheda di chiusura dice quanti messaggi, passi e riassunti sono spariti e cosa resta fuori (file cambiati, invii a Claude) (D-136).

### Sicurezza

- In un'incognita "Salva in inbox" non c'è e gli altri strumenti che salvano sono spenti (/nota, note e carte scritte da Arianna), Telegram, chiamate e notifiche la saltano, e Claude Code lavora senza salvare la sessione sul disco (D-136).
- In un'incognita le chiamate sono rifiutate e la chiusura annulla quelle rimaste; dopo la chiusura nessun passo in ritardo può scrivere brief o turni (migrazione 0032); la scheda d'apertura nomina la cache su disco del modello locale e i file del profilo di Claude Code non ancora verificati; l'Ufficio non mostra il lavoro di un'incognita nemmeno da un'altra scheda (D-136).
- Chiudere un'incognita in attesa di un lock non ferma più per 5 secondi gli eventi del resto di Arianna: i lock si prendono prima di scrivere (migrazione 0033, D-136).
- Il wizard scrive `--log-level info` nel comando di oMLX e il doctor lo pretende (rifiuta il flag assente e ogni livello fuori da info, warning, error, critical: `trace` metterebbe i testi delle richieste nel log del modello locale; D-136, tappa 0).

## [0.24.0] - 2026-10-07

### Aggiunto

- "Apri nella Conoscenza" dopo "Salva in inbox", per la conversazione intera e per il singolo messaggio: apre la pagina Conoscenza con la nota appena salvata selezionata, anche dopo aver ricaricato la chat (D-131, D-099).
- In cima alla chat resta scritto quando la conversazione è stata salvata in inbox ("Salvata in inbox alle 00:34"), anche dopo un ricaricamento (D-131).

## [0.23.0] - 2026-10-06

### Aggiunto

- "Mostra nascosti" nella scheda File della pagina Progetti: col tuo consenso, chiesto ogni volta che lo accendi e valido per quel progetto finché lo spegni, si vedono anche i file col punto, node_modules e l'interno di .git (D-135).

### Sicurezza

- I file che possono contenere segreti (.env, chiavi, .npmrc, .git/config) arrivano coperti, anche quando non sono nascosti: "Mostra" li scopre una volta e lascia traccia negli eventi; nei diff restano coperti (D-135).
- "Apri" non serve più un segreto attraverso un collegamento con un nome da pagina o da immagine, né dalla pagina Progetti né dai file delle deleghe (D-135).

## [0.22.0] - 2026-10-06

### Aggiunto

- Scheda "Servizi" nella pagina Progetti: script di package.json, servizi di docker-compose e obiettivi del Makefile, con il pallino acceso o spento, "Apri" per quelli accesi, Avvia e Ferma con la tua conferma ogni volta e il registro dell'ultimo avvio (D-134, tappa 2).

## [0.21.0] - 2026-10-06

### Aggiunto

- Pagina "Progetti" nel menu: per ogni progetto approvato l'albero dei file, il contenuto con i colori del codice, "Apri" per pagine e immagini, "Apri in VS Code", e in Git branch, modifiche non salvate, ultimi commit con il loro diff; tutto in sola lettura e sul computer (D-134, tappa 1).

## [0.20.0] - 2026-10-06

### Aggiunto

- "Salva in inbox" in cima alla chat salva tutta la conversazione come una nota di kb/inbox, con titolo e riassunto del modello locale; un secondo salvataggio aggiorna la stessa nota (D-131, idea I-7).

## [0.19.0] - 2026-10-06

### Aggiunto

- Un agente entrato in una conversazione esce da solo dopo 10 tuoi messaggi senza lavori per lui, salutando con una frase; il numero si cambia in Impostazioni → Agenti, il Coder resta finché lo togli tu (D-130, idea I-8).

## [0.18.0] - 2026-10-06

### Cambiato

- Le etichette si leggono come Pubblico, Interno, Privato e Segreto, con un puntino colorato, al posto di L0-L3; una legenda spiega cosa vogliono dire, dall'intestazione e dal piede della chat (D-129).

## [0.17.0] - 2026-10-06

### Aggiunto

- Aiutante delle notifiche per il Mac: una piccola app nella barra dei menu che mostra le notifiche a nome di Arianna, con la sua icona; con l'aiutante acceso la chat non mostra più quelle di Chrome (D-128).
- Notifiche della chat web: risposta di Arianna, approvazione in attesa e lavoro fallito, nel browser e con Web Push a chat chiusa, senza testo né titolo; tipi e ore di silenzio in Impostazioni → Notifiche (D-126, idea I-1).
- Avvisi dentro la chat: scheda in basso a destra con la testa di Arianna, il titolo della conversazione, Apri e Dopo, quando la chat è davanti a te ma su un’altra conversazione e le notifiche di sistema non si possono usare (D-126).
- Notifiche con la testa pixel di Arianna e un testo per tipo; pulsanti "Prova una notifica" in Impostazioni → Notifiche, che passano dal core come quelle vere (D-126).
- La chat si installa come app di Chrome sul Mac, in una finestra sua con nome e icona di Arianna (D-126).
- Notifica anche quando risponde l'agente di una chat diretta, non solo Arianna; il resoconto di una delega nella chat di Arianna resta senza notifica (D-126, D-111d).

### Cambiato

- Una notifica sola per ogni avviso: quella di sistema quando c'è (l'aiutante del Mac, poi il browser con il permesso), l'avviso dentro la chat solo se quella di sistema non si può; nessuna notifica per la conversazione che stai leggendo (D-126, D-128).

## [0.16.0] - 2026-10-06

### Aggiunto

- Pulsante "Apri" accanto alle pagine e alle immagini cambiate dal Coder: si aprono in una scheda nuova, in sandbox, e leggono solo i file del progetto (D-117, tappa 3).

## [0.15.0] - 2026-10-06

### Cambiato

- Impostazioni → Agenti rifatta: a sinistra le schede degli agenti (Ufficiali e I miei, con ricerca e filtri), a destra il dettaglio dell'agente scelto in schede (Personalità, Aspetto, Modello, Permessi, Scheda e prompt) e una sola barra "Modifiche non salvate" per salvare; "Apri una chat" porta alla chat diretta con l'agente (D-133).

## [0.14.0] - 2026-10-06

### Cambiato

- "Genera personaggio" disegna in due passaggi: un primo disegno, poi una revisione in cui il modello vede le tre viste rese in testo e ciò che un controllo automatico ha trovato (simmetria, contorno, occhi, colori, proporzioni), con tre esempi disegnati a mano nel prompt invece di uno; costa due richieste a Claude invece di una (D-132).
- Il modello predefinito per disegnare i personaggi è Claude Opus invece di Sonnet (D-132).

## [0.13.0] - 2026-10-06

### Aggiunto

- Chat diretta con il Coder, parte del core: una conversazione di lavoro su un progetto in cui ogni messaggio va al Coder senza passare da Arianna, un lavoro alla volta, con il permesso sulla cartella valido per tutta la conversazione (D-111a).
- Chat diretta con il Coder: ogni messaggio continua la sessione del Coder; se la sessione non c'è più riparte con gli ultimi scambi, e la conversazione sa quanto è pieno il contesto (D-111b).
- "Con il Coder" in "+ Nuovo": chat diretta con il Coder su un progetto, con l'avviso che tutto va a Claude, il segno "va a Claude", l'indicatore del contesto nell'intestazione e la conferma per i messaggi oltre 4000 caratteri (D-111c).
- "Con un agente" in "+ Nuovo" al posto di "Con il Coder": si parla direttamente con qualsiasi agente attivo; uno su Claude chiede un progetto e mostra l'avviso, uno locale può stare anche in una conversazione privata se la sua scheda lo permette (D-111d).

### Sicurezza

- Documentata la chat diretta con il Coder nella specifica di privacy e nelle schede degli agenti: la sessione cloud è per conversazione, sempre L1, e la copia di Claude Code resta nella home (D-111, tappa A4).

## [0.12.4] - 2026-10-05

### Rimosso
- La riga "Personaggio" con il nome del personaggio in Impostazioni → Agenti e in Nuovo agente: resta solo l'anteprima, e "Torna al predefinito" compare solo quando un personaggio è stato scelto (in Impostazioni accanto ad Animazioni, in Nuovo agente accanto all'anteprima) (scelta dell'utente, D-123).

## [0.12.3] - 2026-10-05

### Cambiato
- In chat la riga "Arianna aggiunge …: motivo" è un po' più in evidenza delle altre righe di sistema: testo pieno in una pastiglia con bordo (richiesta dell'utente, D-125).

## [0.12.2] - 2026-10-05

### Rimosso
- Il menu "Personaggio" da Impostazioni → Agenti e da Nuovo agente: il personaggio arriva da Genera personaggio o Carica PNG, e accanto al suo nome c'è "Torna al predefinito" (D-123).

## [0.12.1] - 2026-10-05

### Rimosso
- La scheda Telegram dalle Impostazioni e la domanda su Telegram dal wizard: il canale è spento per scelta dell'utente e il core ignora `[telegram]`; il codice resta, pronto da riaccendere (D-110, domanda 12).

## [0.12.0] - 2026-10-05

### Aggiunto
- "Genera personaggio" in Nuovo agente e in Impostazioni → Agenti: descrivi il personaggio, un modello lo disegna, vedi l'anteprima nelle pose e con "Tieni" lo salvi nel pacchetto `miei` e lo assegni all'agente; "Rigenera" ne chiede un altro (D-123).
- Impostazione `[sprites] model` (Claude Sonnet, predefinito; Claude Opus; modello locale), nella riga Personaggi di Impostazioni → Modelli locali per ruolo (D-123).

### Sicurezza
- La descrizione del personaggio passa dal gateway; Claude disegna senza strumenti in una cartella vuota e la risposta è validata dal codice (palette e pezzi a misura fissa) prima di comporre il PNG (D-123).

## [0.11.1] - 2026-10-05

### Aggiunto
- Gli eval dell'orchestratore provano anche la scelta fra più agenti (`delegates` nel caso): un caso positivo e due negativi (D-119).

### Corretto
- Quando un agente attivo fa proprio ciò che l'utente chiede, Arianna gli passa il lavoro invece di farlo da sola anche se saprebbe farlo (prima traduceva da sé con il `traduttore` attivo); con il solo Coder il prompt non cambia (D-119, tappa T3).

## [0.11.0] - 2026-10-05

### Aggiunto
- Gli agenti entrano nella conversazione come colleghi alla prima delega: righe "Arianna aggiunge <agente>: <motivo>" e "<agente> è stato aggiunto", e l'agente apre il primo rapporto con un saluto nel suo tono (D-125).
- Barra dei partecipanti in testa alla chat, con personaggio, nome ed esecutore; un clic toglie un agente, che rientra alla delega seguente (D-125).

### Cambiato
- `task.delegate` chiede un `reason` breve, scritto da Arianna, prima del brief (D-125).
- Arianna sa quali agenti sono nella conversazione: i partecipanti attivi entrano nel contesto del suo turno (D-125).

### Corretto
- La guardia dei riassunti non conta più le righe di sistema legate a un task, che sono solo per l'utente (D-125, migrazione `0026`).

## [0.10.0] - 2026-10-05

### Cambiato
- Nell'ufficio Arianna siede all'isola del progetto della conversazione di lavoro su cui lavora (all'archivio senza isola), resta in Privata nelle conversazioni private e, da libera o in attesa, va avanti e indietro fra Privata e la zona relax (D-124).
- Sulla stessa isola del Coder Arianna siede alla sedia accanto (D-124).

## [0.9.1] - 2026-10-05

### Cambiato
- Le schede proposte da `pnpm agency:import` nascono dentro i permessi degli agenti utente: un esecutore, punto di partenza `code` (engineering, testing) o `answer` (le altre divisioni), sempre L0 con prompt L0 (D-119, preparazione della tappa T4; D-079).

### Rimosso
- `templateFor` di `packages/agents` e la scelta del modello `web` per le divisioni del web (D-119).

## [0.9.0] - 2026-10-05

### Aggiunto
- Titoli setext nella chat: una riga sottolineata con `===` o `---` diventa un titolo; `---` dopo una riga vuota resta una riga orizzontale (D-065).
- Citazioni «pigre»: le righe senza `>` che continuano una citazione restano dentro la citazione, come in CommonMark (D-065).

### Cambiato
- Un testo seguito subito da `---` (per esempio `a | b` che non è una tabella) ora è un titolo, come in CommonMark e GFM (D-065).

## [0.8.3] - 2026-10-05

### Corretto
- Il log del core segnala una sola volta una sezione di `arianna.toml` che vale al riavvio (`paths`, `database`, `server`), non a ogni ricarica successiva (D-071).
- Le modifiche ai server locali arrivate mentre oMLX si avvia non si accumulano più: si applica solo l'ultima (D-071).

## [0.8.2] - 2026-10-05

### Corretto
- Nei tuoi messaggi «Copia» e «Salva in inbox» non spostano più ora, etichetta e stato lontano dalla bolla: stanno a sinistra della riga (idea I-2).

## [0.8.1] - 2026-10-05

### Corretto
- `pnpm db:up` e `pnpm test:db` lanciati da un git worktree non ricreano più il database della cartella principale su una cartella vuota: `up` lascia acceso quello che c'è, gli altri comandi di compose sono rifiutati; un'installazione senza git avvia il database come prima.

## [0.8.0] - 2026-10-05

### Aggiunto
- **Permessi degli agenti nuovi scelti da te** (D-119, tappa T3b): nella pagina "Nuovo agente" e con "Modifica" scegli dove lavora (modello locale o Claude Code), gli strumenti del codice uno per uno, l'autonomia (A0 o A1) e i limiti di passi e minuti, dentro il tetto L1/A1; "Solo risposte" e "Codice" diventano punti di partenza.

### Sicurezza
- Una scheda nuova, o un cambio di permessi, si scrive solo dopo una finestra di conferma che mostra cosa cambia, la trifecta e cosa esce verso il cloud; la conferma vale per quella differenza e scade dopo 10 minuti (D-119, tappa T3b).
- Il prompt di un agente promosso a ufficiale resta L1 (campo `prompt_label`), non più L0 come le schede scritte in git (D-119, tappa T3b).
- I passi e i minuti scelti limitano anche il run di Claude Code di un agente nuovo (D-119, tappa T3b).

### Corretto
- Il test del doctor con il database contava ancora 24 migrazioni: ora le conta dalla cartella.
- La scheda "Cartella con modifiche" diceva sempre "Il Coder lavorerebbe…" anche quando lavora un agente nuovo: ora nomina l'agente (D-119, tappa T3b).
- Nella finestra di conferma la trifecta non ripete più "chiuso"/"aperto" e "Modifica il codice" non parla più di worktree.

## [0.7.0] - 2026-10-05

### Aggiunto
- **Pagina "Nuovo agente"** (D-119, tappa T3): `/impostazioni/agenti/nuovo`, in tre passi (cosa fa, chi è, aspetto) con i permessi e il lavoro di ogni modello spiegati, un esempio per modello, personaggio scelto o caricato come PNG già nel modulo, e "Attiva ora" alla fine.
- **Arianna delega agli agenti utente attivi** (D-119, tappa T3): gli agenti "Codice" lavorano su Claude Code come il Coder, quelli "Solo risposte" sul modello locale (migrazione `0025`); Arianna sceglie dalla loro descrizione. Gli agenti "Ricerca sul web" non ricevono ancora lavoro.
- Nella pagina Agenti: "Modifica" di descrizione e prompt anche da attivo, "Elimina…" di un agente disattivato (scrivendone il nome; i file vanno in `data/agents/eliminati`), "Riporta fra i miei…" per annullare una promozione nata dalla pagina.

### Sicurezza
- Un agente "Solo risposte" creato da te legge fino a L1, come il suo prompt: un incarico da una conversazione privata (L2) parte solo con la tua approvazione, come per il Coder; prompt e incarico passano dal gateway (D-119).

## [0.6.1] - 2026-10-05

### Corretto
- Dalla seconda delega al Coder nello stesso task, la delega si chiudeva subito col rapporto della prima senza lanciare Claude, e Arianna tornava a chiedere l'approvazione della cartella in un ciclo (D-055): la ripresa dopo un crash usa solo un rapporto scritto dopo quella delega e non già preso da un'altra.

## [0.6.0] - 2026-10-05

### Aggiunto
- **Agenti nuovi dalla pagina Agenti** (D-119, tappa T2): riquadro "Agenti nuovi" con "Nuovo da modello" (codice, ricerca sul web o solo risposte, con i permessi spiegati), agenti creati disattivati in `data/agents`, fuori da git, con tetto L1 e A1; "Attiva" e "Disattiva" valgono subito, senza riavvio; "Promuovi a ufficiale…" sposta la scheda in `agents/` dopo una conferma che dice cosa cambia.

### Sicurezza
- Le schede di `data/agents` sopra L1 o A1, con approvazioni, deleghe o canali, o col nome di un agente ufficiale, non si caricano (D-119); descrizione e prompt con dati personali o valori del vault sono rifiutati.

## [0.5.0] - 2026-10-05

### Aggiunto
- **Personaggi PNG dalla pagina Agenti** (D-118, tappa T1): "Carica PNG" per ogni agente, con anteprima delle animazioni prima dell'invio, salvato nel pacchetto `miei` di `data/characters/` dopo che il core l'ha controllato e riscritto (sostituzione di un nome già usato solo su conferma); "Animazioni" su canvas e "Scarica PNG" del foglio di ogni agente.

## [0.4.0] - 2026-10-05

### Aggiunto
- **Diff dei file modificati dal Coder** (D-117, tappa 1): sotto i rapporti, il riquadro "File modificati" mostra il totale +N −M e, file per file, le righe tolte in rosso e aggiunte in verde, calcolate a richiesta rispetto al commit annotato a fine run (migrazione `0024`), con le stesse protezioni dell'anteprima dei file; "Versione intera" apre ancora l'anteprima.
- **Modifiche dal vivo del Coder** (D-117, tappa 2): ogni Edit, MultiEdit o Write del run compare come piccolo diff nella scheda "Arianna al lavoro", solo per progetti fino a L1 e solo mentre il task lavora, mai salvato; un valore del vault o una modifica troppo grande si mostrano solo per percorso.

### Corretto
- Un file già modificato prima del run e cambiato di nuovo dal Coder ora compare fra i file modificati, con il diff rispetto all'ultimo commit.
- Le righe del diff non hanno più uno spazio iniziale in più.

## [0.3.0] - 2026-10-05

### Aggiunto
- **Pallino delle domande in attesa** (D-120): il numero delle domande di "Sviluppo di Arianna" ancora senza risposta compare su "Impostazioni" e sulla voce della pagina, con il testo "Devi rispondere a N quesiti"; una risposta inviata non conta più.
- **Domande di "Sviluppo di Arianna" comprensibili da sole** (D-122): ogni domanda mostra cosa si decide, le opzioni con le conseguenze (la consigliata per prima, un clic la mette nella risposta, che resta libera) e un esempio; le 143 domande aperte riscritte così nei documenti.

## [0.2.0] - 2026-10-05

### Aggiunto
- **Registro delle versioni:** questo file, i tag `vX.Y.Z` su `main` e la pagina "Novità" nelle Impostazioni, con la versione attuale in fondo alla pagina delle Impostazioni.

## [0.1.2] - 2026-10-05

### Cambiato
- **Barre di scorrimento della chat web** come in Claude Code: sottili, senza frecce né binario, pollice arrotondato e tenue dai token di colore, visibile solo al passaggio del mouse sull'area; regole globali in `apps/hud/src/style.css`.

## [0.1.1] - 2026-10-05

### Corretto
- Un test dell'installer lanciava `git init` con le variabili `GIT_*` dell'hook di commit: dentro un worktree reinizializzava il repository vero e scriveva `core.bare = true`, e git sembrava sparito. Ora le toglie, come gli altri test.

## [0.1.0] - 2026-10-05

Riassunto di tutto ciò che esisteva prima del registro delle versioni (fino al commit `42e9415`).

### Aggiunto
- **Fondamenta:** monorepo TypeScript eseguito senza build, controlli locali con `pnpm check` e hook di commit, eval deterministici, con modello locale e dal vivo (D-018, D-019, D-025, D-026).
- **Privacy:** livelli L0-L3 con default-deny, gateway unico verso il cloud, etichette per cartelle e fonti, taint e clearance delle conversazioni, registro eventi con catena di hash (D-001, D-015, D-024, D-031, D-032).
- **Motore dei task e orchestratore locale** su PostgreSQL, con router per difficoltà, autonomia a gradini e storia ancorata con riassunto (D-020, D-035, D-040, D-051, D-052, D-077).
- **Coder su Claude Code** confinato: nella cartella del progetto approvato, sandbox nativa, crediti "chi ha fatto cosa" e "File modificati" sotto i rapporti (D-041, D-050, D-055, D-056, D-058, D-082).
- **Installer, wizard e doctor** in italiano, catalogo dei modelli scaricati con verifica, vault cifrato con sops e age (D-042, D-046, D-047, D-048).
- **Chat web** in Vue: conversazioni con titolo, archivio e fissate, markdown nostro, errori leggibili, attività dei task salvate, decisioni in attesa, barre laterali come Claude Code, ora dei messaggi, scheda "Arianna al lavoro" che resta dopo un ricaricamento (D-045, D-054, D-057, D-064, D-065, D-083, D-089, D-091, D-097, D-108, D-112).
- **Chiamate vocali** con Pipecat, sintesi a frasi, voci copiate e modelli della voce in memoria solo durante le chiamate (D-066, D-067, D-069, D-070, D-074).
- **Second brain:** cattura in `kb/inbox`, note riordinate dal modello locale, pagina "Pensieri", grafo della conoscenza anche in 3D (D-080, D-086, D-087, D-090, D-104).
- **Impostazioni:** modelli e prove dei modelli in background, personalità, temi, pagina Agenti con modello predefinito per agente, pagina "Sviluppo di Arianna" per rispondere alle domande aperte (D-071, D-081, D-102, D-105, D-107f, D-116).
- **Ufficio pixel** con personaggi originali e politica di memoria di oMLX (D-060, D-106b, D-107e).
- Integrazioni: Telegram dietro il gateway, catalogo agency-agents in sola lettura (D-016, D-079).
