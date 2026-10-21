# Registro delle versioni

Ogni lavoro finito e provato dall'utente diventa una versione, con un tag git `vX.Y.Z` sul commit di `main` che lo porta. Le versioni seguono [SemVer](https://semver.org/lang/it/) in 0.x finché Arianna non è pronta per i dati veri: **minor** (0.X.0) per una funzione nuova, cioè una decisione o un task chiuso; **patch** (0.x.Y) per correzioni e ritocchi. La 1.0.0 arriva quando `pnpm arianna:doctor` dà l'installazione pronta per i dati veri. I dettagli di ogni voce stanno in `docs/DECISIONS.md` (gli id D-NNN) e in `docs/PHASE-0-1-TASKS.md`. La chat web mostra questo file nella pagina "Novità" delle Impostazioni.

## [Non rilasciato]

### Aggiunto

- Progetti seguiti: si può seguire anche un account GitHub (`https://github.com/<account>`, al più 5) dalla pagina «Sviluppo di Arianna» o con `pnpm projects:followed add`; «Controlla nuovi repository» mostra i repository pubblici creati dall'ultimo controllo (fork e archiviati esclusi) con descrizione, data, licenza e «Segui», che li aggiunge ai progetti seguiti; il primo controllo segna come già visti quelli che ci sono (D-271).
- Pagina «Seguiti» nella colonna di sinistra (gruppo Sistema) e comando `/seguiti`: in un posto solo progetti e account seguiti con la casella «Segui», le release di oMLX, le novità di Open Design e l'elenco dei cataloghi di skill e di agenti con la versione in uso e in attesa e il rimando a dove si gestiscono; in Sviluppo di Arianna, Modelli e Skill e stili al loro posto c'è «Ora in Seguiti» (D-272).
- «Seguiti» mostra progetti, account, oMLX e Open Design come schede grandi in una griglia (nome, descrizione, ultima release, ultimo controllo, numero di novità e le prime tre; un clic apre il dettaglio) e ha una casella di ricerca che filtra sulla pagina schede e novità (release, funzioni, commit, repository nuovi) con la parola evidenziata; un progetto seguito dai repository nuovi di un account tiene la descrizione di GitHub (D-272).

## [0.153.0] - 2026-10-21

### Aggiunto

- Impostazioni → Modelli ha la scheda «Server dei modelli (oMLX)»: versione installata (letta con `--version` dal comando dell'endpoint di oMLX), ultima release stabile di `jundot/omlx` su GitHub con le sue novità raggruppate dal modello locale e il link alla release, la pre-release più recente solo come informazione; controllo da solo una volta al giorno e con «Controlla ora» (esce solo il nome del progetto), pallino su Impostazioni e su Modelli quando c'è una versione stabile più nuova; nessun aggiornamento automatico: prima Claude rilegge il codice della release, poi installi tu il DMG a core fermo (D-265).

## [0.152.0] - 2026-10-21

### Sicurezza

- Il doctor legge le impostazioni di oMLX 0.7.1 (D-221): rifiuta «Allow inference without API key» (`auth.allow_unauthenticated_inference`, che apre la chat anche sul Mac), Splash (`integrations.splash_path`, un modello con `external_engine` o un file GGUF nelle cartelle dei modelli o in `gguf/` della cartella di oMLX, che 0.7.1 farebbe leggere a Splash, un programma a parte che riceverebbe i testi), i flag `--http-proxy`, `--https-proxy` e `--no-proxy`, e controlla anche un comando che lancia `omlx-cli` dall'app per Mac o `python3 -m omlx.cli`.
- Prima di avviare oMLX il core spegne la sua lettura dei modelli dalla cache di Hugging Face nella home (`huggingface.hf_cache_enabled: false` nel `settings.json` della sua cartella in `data/`, le altre impostazioni restano com'erano); il doctor rifiuta la cache accesa e il flag `--hf-cache` (D-263).

## [0.151.0] - 2026-10-20

### Aggiunto

- Arianna legge le pagine web pubbliche in chat (`web.fetch`): nelle conversazioni Pubbliche qualsiasi pagina, in quelle Interne solo gli indirizzi che hai scritto tu, mai in quelle Private, con dati di Finanze o in incognito; al più 5 pagine per risposta e 30 al giorno, il testo arriva come contenuto non fidato e il passo in chat mostra «Ho letto sito — titolo» con il link (D-262).
- Il Coder su Claude Code può leggere una pagina web pubblica tramite Arianna: solo gli indirizzi che hai scritto tu nei tuoi messaggi della richiesta (mai quelli scritti da un modello nel brief) e le pagine dei siti che elenchi in Impostazioni → «Siti che il Coder può leggere» (vuoto all'inizio), al massimo 10 per lavoro; ogni indirizzo passa dal gateway e ogni pagina resta nel registro con sito ed esito (D-262).

## [0.150.0] - 2026-10-20

### Aggiunto

- Server MCP di Arianna: quando il Coder lavora su Claude Code può cercare e leggere da solo le note Pubbliche e Interne della base di conoscenza (mai quelle Private, mai le note dei progetti) e rileggere le skill che gli hai assegnato; ogni risposta passa dal gateway con una riga nel registro, chiave valida solo per quel lavoro (D-261, task 1.10).

### Sicurezza

- Nei soli lavori del Coder con il server MCP Claude Code parte senza `--safe-mode` (che spegnerebbe anche il server di Arianna): CLAUDE.md, memoria, hook, skill, plugin e agenti del tuo profilo restano spenti uno per uno, e il lavoro si ferma se all'avvio compare qualcosa del tuo profilo (D-261).

## [0.149.0] - 2026-10-19

### Aggiunto

- Su di te nelle chiamate: in una chiamata su una conversazione privata Arianna (e un agente locale nella sua chat diretta, entro la sua scheda) conosce tutti i fatti che hai scritto di te, in una di lavoro solo quelli «Condivisibili», come nella chat scritta; non li dice ad alta voce se non glieli chiedi, e la risposta prende l'etichetta dei fatti letti; agli agenti nel cloud non arriva nessun fatto (D-260).

## [0.148.1] - 2026-10-19

### Corretto

- Routine con la chiamata: un «sì» detto da solo, che il riconoscimento della voce scrive spesso in inglese o in russo («See ya.», «Сиє.»), ora apre la lettura dei titoli; la domanda chiede «sì grazie, oppure no grazie», due parole che la voce trascrive bene (D-259).
- Routine con la chiamata: il saluto con i conteggi e la domanda restano nella chat della routine come parole della chiamata, e il modello della chiamata sa cosa ha chiesto (D-259).
- Chiamate: il log della voce dice, senza le parole, quando inizia e finisce un tuo turno, se la trascrizione è vuota e come risponde il core, così un turno perso si ritrova (D-259).

## [0.148.0] - 2026-10-19

### Aggiunto

- Routine con la chiamata: nella pagina «Routine» si sceglie «Chiamata» e all'ora della routine, oltre al resoconto in chat, Arianna ti chiama sulla voce di questo Mac (notifica «Arianna ti chiama»); prima dice solo i numeri, i titoli fino all'etichetta scelta (Pubblico, Interno o Privato) solo se rispondi «sì»; se non rispondi lascia una nota e, se lo chiedi, richiama una volta dopo 10, 15 o 30 minuti, mai nelle ore di silenzio; anche Arianna in chat può proporre una routine con la chiamata (D-259).

## [0.147.0] - 2026-10-19

### Aggiunto

- Routine: la fonte «Aggiorna la Dashboard» aggiorna all'ora della routine tutti i riquadri o solo quelli scelti, con lo stesso «Aggiorna» del modello locale; il resoconto dice quanti sono in aggiornamento (D-258).

## [0.146.0] - 2026-10-19

### Aggiunto

- Vista «Calendario» nella pagina «Routine»: la settimana con le ore di ogni routine (in pausa tenue, proposta tratteggiata), l'esito delle esecuzioni già fatte, la linea dell'ora attuale, frecce e «Oggi»; su telefono un giorno alla volta. La scelta fra «Elenco» e «Calendario» resta in questo browser (D-257).
- Nel calendario un clic su un'ora libera apre «Nuova routine» con quel giorno e quell'ora; un clic su una routine la apre in modifica (D-257).
- Nel calendario le routine si spostano trascinandole, a passi di 15 minuti e anche su un altro giorno; per una routine di più giorni Arianna chiede «Tutti i giorni» o «Solo <giorno>», che la divide in due; «Spostata · Annulla» rimette com'era, anche una divisione, in un solo passo; Esc annulla il trascinamento, su telefono parte con una pressione lunga (D-257).

## [0.145.0] - 2026-10-19

### Aggiunto

- In una conversazione privata con Arianna basta chiedere «ogni lunedì e giovedì alle 9 fammi il resoconto…»: Arianna propone la routine con giorni, ora e fonti scelti da un elenco chiuso, e in chat compare la scheda con «Attiva» e «Scarta»; niente parte prima di «Attiva» (D-256).
- La pagina «Routine» mostra in cima le routine proposte in chat, con «Da approvare» e gli stessi due pulsanti; la chat della routine compare nella lista solo dopo «Attiva» (D-256).

## [0.144.0] - 2026-10-18

### Aggiunto

- Pagina «Routine» nella barra a sinistra (gruppo Personale): appuntamenti ricorrenti con giorni, ora e cosa mettere nel resoconto, ciascuno come una carta con prossima esecuzione, ultimo esito, «Prova adesso», pausa, modifica e «Togli» (D-254).
- All'ora di una routine Arianna scrive il resoconto nella sua chat, preparato dal codice senza modello: da fare, decisioni in attesa, card in corso, fatto e fallito dall'ultimo resoconto, pensieri da riordinare; una card Segreta è solo contata (D-254).
- Dopo il resoconto, se la routine lo chiede, tre righe di sintesi del modello locale senza strumenti; se il modello non è pronto entro 20 minuti il resoconto resta senza, e lo dice (D-254).
- Le scadenze nel resoconto le calcola il codice rispetto al giorno del resoconto: «scaduta da 9 giorni (9 ott)», «scade oggi», «scade domani», «scade fra 4 giorni» (D-254).
- La sintesi del modello locale riceve i totali come numeri e le scadenze già calcolate; un controllo del codice boccia ogni numero che non è nei dati (per esempio «9 da fare» quando sono 16) e un «scade oggi» detto di una voce che non scade oggi, senza bocciare ore, anni e frasi corrette: una seconda prova, poi «Sintesi non disponibile» (D-254).
- Se il Mac era spento all'ora della routine, entro due ore il resoconto arriva con le scuse per il ritardo; oltre, una sola riga dice che è stata saltata (D-254).
- Le chat delle routine hanno una «R» nella lista delle conversazioni; archiviare la chat mette in pausa la routine (D-254).

## [0.143.0] - 2026-10-18

### Aggiunto

- Le tue skill personali di Claude Code nel catalogo delle skill: «Importa le mie skill» in Impostazioni → Skill e stili (e `pnpm skills:catalog import-claude`) copia solo i `SKILL.md` e le licenze, mai script né collegamenti simbolici; «Aggiorna» rilegge la cartella, «Togli» cancella la copia (D-255).

### Sicurezza

- Le skill personali di Claude Code entrano Private (L2): arrivano solo agli agenti che lavorano su questo computer finché non le segni «condivisibili» una per una; un testo cambiato torna privato, e il secondo controllo dei dati personali le legge sempre (D-255).
- Le skill personali non vanno mai a Opus per il rapporto di sicurezza né a Sonnet per la traduzione delle descrizioni, e gli eventi le nominano solo come «local/claude-code» (D-255).

## [0.142.1] - 2026-10-18

### Corretto

- Le risposte del modello locale non cominciano più con un «Ecco» o un «Ecco la tabella:» di troppo: l'istruzione chiede di partire dalla risposta e una ripulitura prudente toglie solo la riga che annuncia, mai una frase come «Ecco perché la polizza scade il 3 marzo» (D-253).
- Il pensiero dal vivo dell'orchestratore locale non cita più come trovati gli esempi del prompt (la polizza 7720 di `polizza-incendio.md`): gli esempi sono segnati come inventati, sotto `kb/esempio/`, e gli eval dei modelli bocciano una risposta che li nomina (D-253).

## [0.142.0] - 2026-10-18

### Aggiunto

- L'ufficio pixel si veste per le feste, in 2D e in 3D: con la festa del giorno (o una festa scelta a mano) compaiono alberelli e lucine a Natale, zucche e ragnatele ad Halloween, maschere, stelle filanti e coriandoli a Carnevale, cesti, bandierine e uova a Pasqua, ombrelloni e palloni in Estate, pentole d'oro, bandierine e trifogli a San Patrizio; con il movimento ridotto le lucine restano ferme (D-252).

## [0.141.1] - 2026-10-18

### Corretto

- Il cardwall mostra la complessità delle card nate da un piano: un piccolo segno S, M o L sulla card, con «Complessità: piccola/media/grande» al passaggio del mouse (D-235).
- Quando il piano di «/progetta» lo scrive un modello diverso da quello chiesto dal progetto (`planner = "opus"` con Opus spento), la card «Piano» e la scheda del piano lo dicono: «Scritto da Sonnet: Opus è spento», o «Scritto dal modello locale: Claude non è disponibile»; la nota resta sulla card anche dopo la decisione (D-235).

## [0.141.0] - 2026-10-18

### Cambiato

- Le risposte di Arianna col modello locale si scrivono in testo libero: tabelle, elenchi e blocchi di codice vanno a capo come con Claude invece di arrivare su una riga sola; il JSON resta solo per decidere cosa fare (D-251).

## [0.140.0] - 2026-10-18

### Aggiunto

- Il pensiero degli agenti dal vivo in chat, come in Claude Code: scorre in grigio mentre l'agente ragiona («Sta pensando… 7 s»), poi si richiude in «Ha ragionato per 12 s» che si riapre con un clic, e la risposta si scrive pezzo per pezzo; vale per il modello locale (campo `thought` e ragionamento del server), Claude (`--include-partial-messages`) e Codex (riassunti per passo) (D-249).
- Il pensiero si salva con la risposta, con la sua etichetta, e sparisce con la conversazione eliminata; mai nelle incognite (D-249).

### Cambiato

- Il pensiero dell'orchestratore non è più solo nel log del run: si vede in chat, ma non entra mai in un brief, nel contesto mandato al cloud né negli eval (D-249, cambia D-051).

### Sicurezza

- Il profilo di confinamento di `claude` aggiunge solo `--include-partial-messages`; i pezzi del pensiero passano dallo stesso controllo dei valori del vault dei frammenti della risposta (D-249).

## [0.139.1] - 2026-10-17

### Corretto

- Nella chat diretta col Designer gli stili di Open Design come «x-ai», «stripe», «vercel» o «figma» non fermano più il messaggio verso Claude: il controllo dei dati personali non legge più i testi dei cataloghi adottati, che prendeva per nomi di persona (41 stili su 152) (D-250).
- Nella chat diretta con un agente, un messaggio fermato dal gateway non lascia più la chat in «Attende te» senza niente da fare: Arianna scrive perché non l'ha mandato (per esempio un nome di persona da togliere) e il lavoro si chiude; le attese rimaste così si chiudono al riavvio (D-250).
- La riga «provo un'altra strada» compare solo dove un'altra strada c'è: nella chat diretta e sulle card degli agenti l'errore si legge senza (D-250).

### Sicurezza

- L'esenzione dal secondo controllo vale solo per il testo esatto che il core compone dai file adottati, nel suo frammento: un carattere diverso o lo stesso testo altrove si controlla come prima; il messaggio dell'utente, le regole, le note e la chat si controllano sempre (D-250).

## [0.139.0] - 2026-10-17

### Aggiunto

- Immagini e file nella chat privata: incolla con ⌘V, trascina sul campo o «Allega file» nel menu «+»; PNG, JPEG, WebP e GIF fino a 10 MB, testi .txt, .md, .csv e .json fino a 256 KiB, al massimo 4 per messaggio, con l'anteprima piccola nella bolla (D-247).
- Ruolo «Guarda le immagini allegate» (`vision`) in Impostazioni → Modelli: Qwen3.5 9B legge le immagini sul Mac e passa ad Arianna la sua lettura; si carica solo quando c'è un'immagine da leggere e si scarica subito dopo (D-247).

### Sicurezza

- Ogni allegato è Privato (L2) e va solo in una conversazione privata con Arianna o con il modello locale: in una conversazione di lavoro, con Claude o ChatGPT, in incognito o nella coda dei messaggi è rifiutato prima dell'invio, con il testo che resta nel campo; il database lo rifiuta anche lui (migrazione 0074) (D-247).
- Gli allegati stanno in `data/attachments` (0600, fuori da git), mai SVG, serviti con sandbox e nosniff; «Elimina» li cancella con la conversazione, quelli incollati e mai mandati spariscono dopo un giorno (D-247).

## [0.138.0] - 2026-10-17

### Aggiunto

- Pagina «Dashboard»: «Fissa alla Dashboard» su una risposta della chat la tiene in un riquadro con titolo, etichetta, data e conversazione d'origine; la domanda per gli aggiornamenti la riscrive il modello locale e tu la correggi; «Aggiorna» la rifà solo al modello locale, anche per le risposte di Claude o ChatGPT, e l'etichetta del riquadro può solo salire; riquadri stretti o larghi, da riordinare e togliere; la domanda si modifica dalla Dashboard («Salva e aggiorna»); un riquadro può essere un grafico a barre, linee o torta, coi dati scritti dal modello locale e controllati, con la tabella dei dati a richiesta (D-248).

## [0.137.1] - 2026-10-17

### Corretto

- Il Designer e il Coder lavorano anche in una cartella di progetto appena creata con `git init` e senza ancora un commit: prima, dopo la scelta «Claude», il task falliva con un errore generico dopo tre tentativi senza avviare l'agente; un guasto di git nel leggere la cartella ora chiude il lavoro con il motivo, che Arianna dice in chat, invece di far fallire il task (D-058).

## [0.137.0] - 2026-10-17

### Aggiunto

- Tema «Base» in Impostazioni → Aspetto, il tema predefinito: la chat com'è, con i sette colori che si leggevano male (testo delle bolle nello scuro, accento, verde, verde acqua e ambra nel chiaro) corretti per il contrasto AA (D-246).
- Feste automatiche: a Natale (8 dicembre - 6 gennaio), San Patrizio (15-17 marzo), Halloween (25 ottobre - 1° novembre), Carnevale (dal giovedì al martedì grasso), Estate (agosto) e Pasqua (dalle Palme a Pasquetta) Base lascia il posto al tema della festa; un tema scelto a mano non viene mai sostituito (D-246).
- Interruttore «Feste automatiche» in Impostazioni → Aspetto, acceso di base, che vale subito su tutti i dispositivi (D-246).
- Costumi delle sei feste per Arianna e il Coder in tutte le pose: berretto di Natale, cilindro verde, cappello da strega e zucca, maschera di Carnevale e cappellino a cono, cappello di paglia e occhiali da sole, orecchie da coniglio e uovo dipinto (D-246).

### Cambiato

- Impostazioni → Aspetto mostra le feste in un gruppo a parte, e dice quale festa è in uso oggi al posto di Base (D-246).

## [0.136.1] - 2026-10-16

### Corretto

- «Prendi da Wikiquote» trova le battute vere anche per I Simpson, Futurama, The Big Bang Theory, I Griffin, American Dad e Prison Break: pagine delle stagioni, sezioni «Frasi» e «Dialoghi» e note dopo il nome come le scrive il sito; fra una pagina e l'altra aspetta di più, e se Wikiquote chiede di rallentare riprova dopo un minuto invece di fermarsi (D-245).

## [0.136.0] - 2026-10-16

### Aggiunto

- Tema «The Big Bang Theory» (l'appartamento di Pasadena, fan art per uso personale): pareti ocra, arancio e una bolla blu petrolio su carta millimetrata; Penny è Arianna, Howard il Coder, Sheldon GOD, Leonard il revisore, Bernadette le finanze, Raj il designer e Amy il modello locale, in pixel art con personalità, battute e pagina di Wikiquote, e l'ufficio pixel, in 2D e in 3D, con il parquet, le tende alle finestre, la lavagna con le equazioni, l'isola della cucina col cibo da asporto, l'ascensore guasto col nastro giallo, le librerie di fumetti e il divano col posto di Sheldon (D-243).

## [0.135.2] - 2026-10-16

### Cambiato

- I pacchetti di personaggi del repository (originali e serie) non hanno più un numero massimo di personaggi; quelli caricati o scaricati in data/ ne tengono fino a 200 (prima 64) (D-244).

## [0.135.1] - 2026-10-16

### Cambiato

- Impostazioni → Personaggi: la barra laterale ha il campo «Cerca un personaggio» (nome o serie, Invio apre il primo trovato) e ogni serie si apre e si chiude dal suo titolo, con «Apri tutte / Chiudi tutte»; di base è aperta la serie del personaggio scelto e il browser ricorda le altre (D-224).

## [0.135.0] - 2026-10-16

### Aggiunto

- Tema «Futurama» (la sede della Planet Express, fan art per uso personale): verde della Planet Express, viola e un cielo di stelle; Leela è Arianna, Bender il Coder, il Prof. Farnsworth GOD, Amy la revisora, Hermes le finanze, Zoidberg il designer e Fry il modello locale, in pixel art con personalità, battute e pagina di Wikiquote, e l'ufficio pixel, in 2D e in 3D, con oblò, il logo della ditta, il tavolo delle riunioni, i tubi di trasporto, le casse delle consegne e l'astronave parcheggiata nell'atrio (D-242).

## [0.134.0] - 2026-10-16

### Aggiunto

- Tema «Prison Break» (il penitenziario di Fox River, fan art per uso personale): cemento grigio, blu delle divise e arancio; Sara è Arianna, Michael il Coder, Mahone GOD, Lincoln il revisore, Abruzzi le finanze, Westmoreland il designer e Sucre il modello locale, T-Bag libero nella galleria; con personalità, battute, pagina di Wikiquote e l'ufficio pixel, in 2D e in 3D, con cemento, blocchi, sbarre alle finestre, armadietti, brande e telefono a gettoni (D-240).

## [0.133.0] - 2026-10-16

### Aggiunto

- Tema «American Dad» in Impostazioni → Aspetto: blu notte, bianco e rosso sobrio, con Francine (Arianna), Stan (Coder), Roger (GOD), Hayley (revisore), Bullock (Finanze), Steve (Designer) e Klaus (Modello locale) in pixel art con la loro personalità, e l'ufficio pixel che diventa la casa degli Smith, in 2D e in 3D (D-239, fan art per uso personale).

### Cambiato

- Il pacchetto di personaggi può averne fino a 64 (prima 32), per i temi delle serie da sette personaggi ciascuno; anche «Miei» (D-239, D-240).

## [0.132.0] - 2026-10-16

### Aggiunto

- Tema «I Griffin»: Lois è Arianna, Peter il Coder, Stewie GOD, Brian il revisore, Meg le finanze, Chris il designer e Cleveland il modello locale, in pixel art con personalità, battute e nomi di Wikiquote, e l'ufficio pixel diventa casa Griffin col bancone del Drunken Clam, in 2D e in 3D (fan art per uso personale, D-238).

## [0.131.0] - 2026-10-16

### Aggiunto

- Tema «I Simpson» in Impostazioni → Aspetto: giallo Simpson e cielo con le nuvole; Marge è Arianna, Homer il Coder, il signor Burns GOD, Lisa la revisora, Smithers le finanze, Bart il designer e Boe il modello locale, con la loro personalità e i nomi del doppiaggio italiano, e l'ufficio pixel (in 2D e 3D) diventa la centrale nucleare di Springfield; fan art per uso personale (D-237).

## [0.130.2] - 2026-10-16

### Corretto

- In una conversazione di lavoro, quando il modello locale rifà la stessa ricerca e le pagine private erano escluse, Arianna risponde che i documenti privati (fatture, spese, note personali) si leggono in una conversazione privata, invece di fermarsi con «il modello locale ripete la stessa chiamata» (D-241).
- «Chiedi a lato» non perde più la risposta e il contesto quando gli id dei messaggi passano a una cifra in più (per esempio da 9999 a 10000) (D-241, D-232).

## [0.130.1] - 2026-10-16

### Corretto

- Il secondo controllo dei dati personali non scambia più per una persona «hero», «skeleton», «Vite», «Tailwind», «Figma» e «Redis» da soli: «/progetta una landing page con hero» arriva a Claude; «Hero Rossi» resta bloccato (D-236).

## [0.130.0] - 2026-10-16

### Aggiunto

- «/progetta <descrizione>» nella chat con Arianna: risponde subito e mette sul cardwall la card «Piano: …», che pianifica a parte e si vede In corso; il piano arriva nella conversazione, nel dettaglio della card e con la notifica del Mac (D-235).
- Chiave `planner = "opus" | "sonnet" | "local"` nel `[[project]]` di `arianna.toml` e in Impostazioni → Progetti: chi scrive le card dei piani del progetto; in una conversazione privata pianifica sempre il modello locale (D-235).
- Il piano si modifica nella sua scheda prima di decidere: titolo, obiettivo, chi la fa, «bloccata da», criterio di completamento e complessità; righe aggiunte ed eliminate, ricontrollate dal core (D-235).
- «Avvia subito» per ogni card di un agente nella scheda del piano, selezionata sulle righe che non aspettano altre card (D-235).
- Decisa la scheda del piano, Arianna lo dice anche nella conversazione: quali card ha creato in Inbox, o che non ne ha creata nessuna (D-235).
- Nel menu «/» il comando «/progetta» resta visibile anche dove non vale, grigio e con il motivo (per esempio una conversazione di lavoro senza progetto), invece di sparire (D-235).
- Trascinare una card di un agente in «In corso» la fa partire, come «Avvia», «Riprendi» o «Riprova»; trascinarla di nuovo lì non fa partire niente di più (D-235).
- «Ferma» nel dettaglio di una card al lavoro o in coda (anche prima che il worker la prenda), e lo stesso trascinandola fuori da «In corso»: il lavoro si interrompe, la card va fra le fallite con «Fermata da te» e riparte con «Riprova» (D-235).
- «Passi» nel dettaglio della card di un agente: cosa cerca, legge, scrive o delega mentre lavora, aggiornati ogni pochi secondi finché la card è in corso, con la privacy della card (D-235).
- «Rimanda» nel dettaglio di una card in «Da verificare»: una nota obbligatoria, con la sua privacy (Privato di base: la card resta sul modello locale; Interno: può tornare a Claude o ChatGPT); l'agente riparte dal suo rapporto, dai file che ha toccato e dalla nota, e le note restano nella card (D-235).

### Cambiato

- Un piano ha fino a 12 card (prima 8), ognuna con criterio di completamento e complessità S, M o L (D-235).
- Approvato un piano, tutte le card nascono in Inbox; partono solo quelle con «Avvia subito» (prima partivano tutte quelle degli agenti) (D-235).
- Approvato o rifiutato il piano di «/progetta», la card «Piano» va in Fatto con l'esito (D-235).
- Una card rimandata ha di nuovo i suoi limiti di passi e minuti interi a ogni giro (D-235).
- Le card lavorano su due worker loro, separati da quello della chat: una card lunga del Coder non fa più aspettare le risposte. Una sola card al lavoro per progetto, perché lavorano nella stessa cartella, e nessuna mentre una delega della chat lavora in quella cartella: le altre aspettano con «In coda, 1ª» sulla card (D-235).

### Corretto

- Un testo scritto a mano su una card Interna nata da un piano la rende Privata e ora le lascia anche leggere ciò che è Privato: prima il motore la fermava appena partiva sul modello locale (D-152, trovato con D-235).

### Sicurezza

- Le modifiche al piano restano all'etichetta della conversazione; in una conversazione di lavoro un testo con dati personali è rifiutato come un messaggio (D-235).
- «Elimina» ed «Elimina per sempre» di una conversazione portano via anche la card «Piano» di un suo «/progetta», con la richiesta e il piano (D-235).
- «Crea le card» su una scheda rimasta a una versione vecchia del piano è rifiutato: non parte nulla che non hai visto (D-235).

## [0.129.1] - 2026-10-16

### Cambiato

- I temi si chiamano col loro nome anche in «Cosa è cambiato» e nei costumi della galleria: «Scrubs» e «The Office», non più «corsia» e «ufficio» (richiesta dell'utente del 2026-10-16, D-233).
- Il progetto «arianna» (Arianna stessa, dove lavora GOD) è il primo e in evidenza nella pagina Progetti e in Impostazioni → Progetti, in un riquadro suo con logo, versione e copie di lavoro, senza IM né incassi perché è un progetto interno (richiesta dell'utente del 2026-10-16, D-127).

## [0.129.0] - 2026-10-16

### Aggiunto

- «Affianca» nel menu di una conversazione della barra sinistra (l'icona a due colonne, accanto a Fissa): la apre accanto a quella aperta, ognuna col suo campo, la sua bozza, la sua coda, la sua etichetta e chi risponde; «Chiudi» sulla seconda la toglie. L'indirizzo le porta tutte e due (`/c/<id>?affianca=<id>`), così ricaricando o con «indietro» tornano (D-234, idea 7 di OpenWork).
- Sotto i 1280 px di larghezza della finestra le due conversazioni affiancate si vedono una alla volta, con due schede in alto per passare dall'una all'altra (D-234).

### Corretto

- All'apertura di una conversazione la chat ricorda di nuovo se l'intera conversazione era già stata salvata in inbox: un errore la faceva leggere solo cambiando conversazione (D-131, trovato con D-234).

## [0.128.0] - 2026-10-16

### Aggiunto

- Pagina «Cosa è cambiato» nelle Impostazioni, gruppo Informazioni dopo Novità (`/impostazioni/cosa-e-cambiato`): i cambiamenti di questa installazione dal più recente, per giorno, con un'icona e un filtro per tipo (modelli, Claude e Codex, skill e stili, agenti, progetti, aspetto, versione di Arianna) e il collegamento alla sezione dove si cambia quella cosa. Il core fotografa solo nomi, versioni e stati all'avvio, a ogni cambio di `arianna.toml`, ogni 10 minuti e quando apri la pagina, e scrive la differenza nel registro degli eventi; mai il contenuto di chat o note (D-233, idea 11 delle idee di OpenWork).
- La versione di Claude Code detta dal binario all'inizio di ogni lavoro entra nell'evento del modello usato, così «Cosa è cambiato» vede quando si aggiorna; Codex non la dice e resta fuori (D-233).

## [0.127.0] - 2026-10-16

### Aggiunto

- L'ufficio si può attraversare a piedi in 3D: l'interruttore «2D / 3D» sotto la mappa (spento di default, ricordato dal browser) apre una vista in prima persona costruita dalla pianta del tema, con muri, porte, arredi e i personaggi pixel come sagome piatte; ci si muove con le frecce o W A S D, ci si gira trascinando o con ← →, E per parlare come in 2D (D-230, domanda 3 di D-106).

### Cambiato

- Nuova dipendenza della chat: three.js 0.186.1 (MIT), scaricata solo quando si accende la vista 3D dell'ufficio (D-230).

## [0.126.0] - 2026-10-16

### Aggiunto

- «Chiedi a lato» fra le azioni di una risposta (accanto a Copia e Salva in inbox): apre a destra un pannello dove fai domande a parte su quella risposta, a cui risponde chi risponde nella conversazione (Arianna, il modello locale, Claude o ChatGPT) con le stesse regole di privacy; domande e risposte restano nel pannello e la conversazione non le rilegge. Esc chiude il pannello, la stessa risposta lo riapre sullo stesso filo («Riprendi a lato»); sullo schermo stretto il pannello prende tutta la pagina; il filo si cancella con la conversazione (D-232).

## [0.125.0] - 2026-10-16

### Aggiunto

- Nel campo di scrittura della chat un pulsante «+» con un menu solo per comandi «/», «@» a un agente, «Allega nota privata», «Nuova sessione» del Designer, «Salva in inbox» e il modello della conversazione; si usa anche da tastiera (frecce, Invio, Esc) (D-231).
- Tasti per il modello della conversazione: sul Mac ⌃1…⌃9 scelgono i modelli del selettore nel suo ordine e ⌃0 la scelta automatica (altrove Alt+Maiusc con la cifra), solo fra quelli che quella conversazione ammette; li mostra il menu «+» (D-231).
- Il testo scritto e non ancora inviato resta legato alla sua conversazione quando ne apri un'altra o ricarichi la pagina; resta solo in questo browser, mai nel core, e va via quando invii, quando la conversazione è cancellata o dopo 7 giorni; solo nelle conversazioni di lavoro, mai nelle Private né nelle incognite (D-231).

### Cambiato

- Cambiando conversazione il testo non inviato non passa più alla conversazione aperta dopo (D-231).

## [0.124.0] - 2026-10-16

### Aggiunto

- In «Nuova conversazione» → Agente una sezione «Personaggi» con i personaggi delle serie divisi per serie (avatar e nome): scelto uno, si apre una chat di lavoro in cui lo gioca Claude (Sonnet, oppure Opus dal selettore della chat) con un prompt corto da gioco di ruolo, in italiano e in stile chat; nella chat nome e avatar del personaggio in alto e nei messaggi. Con Claude spento i personaggi si vedono spenti col motivo (D-225, tappa B).
- A ogni messaggio della chat con un personaggio il core pesca le sue battute vere (D-224) e le mette dopo il messaggio, anche quando la sessione di Claude riprende (D-225, tappa B).

### Sicurezza

- La chat con un personaggio è di livello Interno: passa dal gateway come la chat semplice con Claude e un dato personale la ferma lì; le chat private restano sul Mac. Nei soli messaggi di quella chat i nomi della sua serie («Turk», «Dr. Cox») non contano come persone per il secondo controllo, interi e mai quelli di un'altra serie. Il personaggio si sceglie alla creazione e il database non lo fa cambiare né lo ammette fuori dalla chat semplice con Claude (migrazione `0070`, D-225 tappa B).

## [0.123.0] - 2026-10-16

### Aggiunto

- L'ufficio pixel ha le stanze: Privata e sei stanze di progetto chiuse da muri, ognuna con la sua porta sul corridoio e un arredo diverso, la Pausa, l'atrio con la scrivania Decisioni all'ingresso e l'Archivio; vale per Base, Scrubs (il Sacro Cuore) e The Office (la Dunder Mifflin) (D-229).
- Hanno una stanza prima i progetti con una conversazione fissata, poi quelli attivi negli ultimi 7 giorni; gli altri stanno nell'Archivio (D-229, domanda 8 di D-106).
- Gli agenti senza lavoro passeggiano per il corridoio e la Pausa, a turni di 30 secondi; fermi con «riduci movimento» (D-229, domanda 6 di D-106).
- La pianta dell'ufficio segue il tuo personaggio: più grande, si sposta mentre cammini e si ferma ai bordi (D-229).

### Cambiato

- Mappe dell'ufficio nel formato 2 (porte e punti di passeggio), con le regole nuove del validatore; il formato 1 resta valido (D-229).

## [0.122.0] - 2026-10-16

### Aggiunto

- Nove personaggi nuovi delle serie, con foglio pixel, pose, scheda (chi è, come parla, mondo, battute di riserva) e nomi per Wikiquote: di Scrubs il Dr. Kelso, l'Inserviente, Ted e Laverne; di The Office Oscar, Andy, Kevin, Angela e Creed (D-227).

### Cambiato

- Col tema Scrubs il Designer è l'Inserviente e il Modello locale è il Dr. Kelso; col tema The Office Finanze è Oscar, il Designer Andy e il Modello locale Kevin. Ted, Laverne, Angela e Creed sono liberi: si scelgono per qualsiasi agente in Impostazioni → Agenti → Aspetto (D-227).

### Sicurezza

- Il secondo controllo dei dati personali non scambia più per una persona un pezzo del nome di un personaggio che vale già come non persona in quel testo («verne» dentro «Laverne»); un nome più lungo, come «Laverne Bianchi», resta una persona (D-227).

## [0.121.1] - 2026-10-16

### Corretto

- Aggiungendo un progetto in Impostazioni → Progetti o con `pnpm arianna:init` si può incollare il percorso completo della cartella: se sta nella tua cartella utente Arianna lo salva da sola come `~/…` (D-228).
- I rifiuti della lista dei progetti (cartella fuori dalla tua cartella utente, cartella nascosta, Library, nome non valido, doppioni) sono in italiano e dicono cosa fare, nella pagina, nel wizard e nei comandi dell'installer (`pnpm arianna:*`), al posto del messaggio tecnico in inglese «write ~/<folder>…» (D-228).

## [0.121.0] - 2026-10-16

### Aggiunto

- In alto in ogni chat, accanto al nome, l'interruttore «Personaggio acceso / spento», salvato per conversazione e acceso per default: spento, Arianna e gli agenti di quella chat (locali, Claude, Codex e le chiamate) rispondono senza personaggio né battute; nome e aspetto restano. Compare quando almeno un agente indossa un personaggio delle serie (D-225).

### Cambiato

- Un personaggio delle serie si presenta come tale e mai come «Arianna» (che è solo il nome del sistema); nelle chat private, se gli chiedi chi è, da dove viene o della sua vita, risponde con quello che racconta la serie (D-225, richiesta dell'utente del 2026-10-16).
- Le risposte di sola chiacchiera di un personaggio sul modello locale sono più vive: quando Arianna risponde subito, senza strumenti, la stessa richiesta viene riscritta una seconda volta a temperatura 0,7 e si tiene quella, se è ancora una risposta; gli strumenti restano decisi a temperatura 0 (D-225).

## [0.120.0] - 2026-10-16

### Aggiunto

- Voce nuova «Personaggi» nelle Impostazioni, dopo Agenti (indirizzo `/impostazioni/personaggi-delle-serie`): tutti i personaggi delle serie divisi per serie (Scrubs, The Office), ognuno con il suo aspetto (pose, animazioni, PNG, chi lo indossa) e la sua scheda (chi è e come parla, scena, battute). In Agenti → Aspetto resta solo chi indossa chi, con un collegamento alla scheda (D-224, richiesta dell'utente del 2026-10-16).
- Nella scheda di un personaggio la sezione «Battute»: un elenco numerato con «togli», fino a 1000, doppioni tolti, con le battute che scrivi tu («Aggiungi») e quelle raccolte da Claude («Genera altre 100»); finché è vuoto valgono le 4 fisse del repository (D-224).
- Pulsante «Prendi da Wikiquote» nella sezione Battute: il core scarica da it.wikiquote.org le pagine della serie (Scrubs, una per stagione; The Office, una sola) e prende le battute del personaggio dal doppiaggio italiano, con l'episodio e il segno «Wikiquote»; esce solo il nome della pagina, chiesto con un dialogo la prima volta. «Genera altre 100» diventa «Chiedi a Claude», secondario (D-224).

### Cambiato

- A ogni risposta di un agente che indossa un personaggio delle serie, Arianna pesca a caso 5 battute dell'elenco non usate di recente in quella chat e le mette in fondo all'ultimo messaggio, al posto delle 4 fisse: il modello ne usa al massimo una. Quelle che nominano altri personaggi solo nelle chat private; le battute fisse riscritte da te vincono sull'elenco (D-224).
- In Agenti → Aspetto la galleria mostra fra i personaggi delle serie solo quelli della serie del tema in uso; col tema senza serie li divide per serie, «Serie (fan art) · Scrubs» e «· The Office (US)» (D-224, richiesta dell'utente del 2026-10-16).
- La pillola delle sezioni delle Impostazioni dice «Vale appena salvi» invece di «Vale subito» (richiesta dell'utente del 2026-10-16).

## [0.119.1] - 2026-10-16

### Corretto

- Quando Codex si ferma subito la chat dice cosa è successo e cosa fare, invece di «codex: execution»: «Codex non è collegato all'account ChatGPT…: lancia `codex login`», «L'abbonamento ChatGPT non permette questo modello di Codex…», oppure «Codex si è fermato subito (dopo N secondi) senza dire perché: prova `codex login status`»; il testo dell'errore di Codex non entra mai nella chat (D-064).

## [0.119.0] - 2026-10-16

### Cambiato

- La casella «Su di te, per Claude Code» della pagina «Sviluppo di Arianna» si chiama «Su di te, per chi sviluppa Arianna»: il testo lo legge anche Codex lanciato con `pnpm dev:codex` (D-226).

### Sicurezza

- Il profilo di permessi di `pnpm dev:codex` apre in sola lettura il solo file `data/dev/UTENTE.md`; il resto di `data/dev/` e di `data/` resta negato (D-226).

## [0.118.1] - 2026-10-15

### Corretto

- Una conversazione nuova con un agente (per esempio GOD) parte dal modello scelto per quell'agente in Impostazioni → Agenti → Modello; prima prendeva quello del Coder, e senza quello decideva il router, che per un messaggio corto poteva scegliere Codex Sol (D-116).

## [0.118.0] - 2026-10-15

### Aggiunto

- In Impostazioni → Agenti → Aspetto, per un agente che indossa un personaggio delle serie, la scheda «Personalità di …»: chi è e come parla, la scena, le battute e «Cosa riceve il modello» nella chat privata e in quella di lavoro; i testi si possono riscrivere (diventano tuoi, Interno) e «Ripristina il testo originale» torna a quelli del repository (D-223).

### Cambiato

- I personaggi delle serie recitano davvero nelle chat private: didascalie fra parentesi quadre, la voce narrante di J.D., gli altri personaggi della serie che intervengono, i luoghi; nelle chat di lavoro solo la voce, senza altri personaggi in scena. Le battute diventano esempi, non più una per ogni risposta; niente parolacce (D-223).

## [0.117.0] - 2026-10-15

### Cambiato

- Nella tab «Domande» il riepilogo ha quattro riquadri cliccabili (Fatto, In corso, Da fare, Superato): un clic porta a «Tutte le voci» già filtrata per quello stato, un secondo clic toglie il filtro; sopra la lista lo stato si sceglie con bottoni invece che con una select (D-102, richiesta dell'utente del 2026-10-15).
- Le decisioni superate ora sono anche nella lista, barrate, fuori dalla barra e dalla percentuale (D-102).
- Titoli dei gruppi di domande senza nomi di file («Decisioni aperte», «Da confermare», «Cose che aspettano te»); la nota sulle righe dei documenti non lette è chiusa in un «dettagli».

## [0.116.1] - 2026-10-15

### Cambiato

- Nella pagina «Sviluppo di Arianna» la casella «Su di te, per Claude Code» ha una tab sua, «Su di te», accanto a «Domande» e «Progetti seguiti»; l'indirizzo la ricorda con `?scheda=su-di-te` (D-114, richiesta dell'utente del 2026-10-15).

## [0.116.0] - 2026-10-15

### Sicurezza

- Il server dei modelli (oMLX) risponde solo ad Arianna (D-221): il core gli dà una chiave sua a ogni avvio (in `data/omlx.key`) e la manda in ogni richiesta; prima un sito aperto nel browser o un altro programma del Mac poteva usarlo, impostarne la password del pannello e da lì leggere i testi delle chat.
- Un oMLX già acceso che risponde a chiunque non viene più usato: il core lo segnala e aspetta che tu lo spenga (D-221).
- Le impostazioni e i registri di oMLX stanno in `data/omlx` (`--base-path`), non più nella cartella di oMLX della home (D-221).

### Aggiunto

- Nella pagina «Pronta per i dati veri» il controllo «Il server dei modelli risponde solo ad Arianna», anche in `pnpm arianna:doctor` (D-221).

## [0.115.0] - 2026-10-15

### Aggiunto

- Gli agenti che rispondono sul Mac (per esempio il Traduttore) leggono anche la chat fino alla tua richiesta, quando la loro scheda arriva al livello della conversazione: «@traduttore traduci la risposta qui sopra» ora sa cosa tradurre; sotto il rapporto la nota dice «Ha visto la chat e il brief» (D-220).

## [0.114.0] - 2026-10-15

### Aggiunto

- «@nome» nella chat con Arianna (D-219): «@designer fammi tre colori» va dritto a quell'agente, che risponde col suo rapporto senza passare dal ragionamento di Arianna; un menu propone gli agenti mentre scrivi «@».
- «/giro» (D-219): ogni agente già presente nella chat risponde una volta, uno alla volta, e una riga sotto il messaggio dice chi c'è nel giro; «/basta» o «Ferma» fermano il giro.
- «Ha visto solo il brief» sotto il rapporto di un agente (D-219): un clic mostra il testo esatto che gli è arrivato.

### Cambiato

- Per ogni tuo messaggio al massimo 6 interventi di agenti e 2 dello stesso agente, anche quando li chiama Arianna (D-219).

### Corretto

- Un messaggio che Arianna rifiuta (per esempio «/giro» senza agenti nella chat) torna nel campo di scrittura invece di sparire (D-219).

## [0.113.2] - 2026-10-15

### Corretto

- Test col database del prompt con la persona: non leggono più tema, personaggi e personas dell'`arianna.toml` dell'utente, che con un tema di serie aggiungevano il blocco del personaggio e lo facevano fallire (test rossi, D-107, D-214, D-217).
- Test col database di «sposta la banca a venerdì»: l'impegno parte da sabato e non da domani, che di giovedì era già venerdì e faceva fallire il test (test rossi, D-148).

## [0.113.1] - 2026-10-15

### Cambiato

- Nei messaggi della chat il personaggio si chiama solo col suo nome («Carla», non «Carla (Arianna)»): firma delle risposte, «Carla al lavoro», rapporti degli agenti; in alto restano tutti e due i nomi (D-214, richiesta dell'utente).

## [0.113.0] - 2026-10-15

### Aggiunto

- «Ferma» nella chat (D-218): un pulsante accanto all'invio interrompe la risposta in corso; sotto il messaggio compare «fermato» con «Riprova».
- Coda dei messaggi (D-218): ciò che scrivi mentre Arianna o un agente risponde aspetta sopra il campo, si può modificare o togliere e parte da solo quando la risposta finisce; dopo «Ferma» la coda resta in pausa finché non scegli «Invia ora» o «Riprendi la coda».

### Cambiato

- Nella chat con Arianna due messaggi della stessa conversazione non lavorano più insieme, e nella chat diretta il secondo messaggio non viene più rifiutato: aspetta in coda (D-218).

## [0.112.0] - 2026-10-14

### Aggiunto

- Con un tema delle serie gli agenti chiamano gli altri con i nomi dei personaggi (D-217): con Scrubs GOD parla di Carla, non di Arianna; il nome che hai scritto in Personalità per un agente vince.

### Sicurezza

- Il secondo controllo dei dati personali non ferma un brief che cita un agente col nome del suo personaggio, solo per i personaggi indossati in quel momento e solo col nome intero: «Carla Bianchi» o «Pam» con Scrubs restano persone (D-217).

## [0.111.0] - 2026-10-14

### Aggiunto

- L'ufficio pixel segue il tema (D-216): con Scrubs diventa il Sacro Cuore (piastrelle, corrimano, croce verde, banco delle infermiere, letti, carrelli, distributore), con The Office la Dunder Mifflin (moquette, ufficio vetrato di Michael, reception di Pam, fotocopiatrice, sala riunioni, cartello); con Base resta com'è. Isole, scrivanie, cardwall, Decisioni e archivio restano al loro posto.

## [0.110.0] - 2026-10-14

### Aggiunto

- I personaggi delle serie hanno la personalità del personaggio vero (D-214): un agente che indossa il Dr. Cox risponde burbero e sarcastico, Pam gentile, Dwight serissimo, dal tema o scelto a mano; il nome e la personalità che hai scritto per l'agente vincono, e regole, strumenti e approvazioni non cambiano.
- Ogni personaggio delle serie apre o chiude ogni risposta con una sua battuta tipica, a rotazione («Che vuoi, pivello?» del Dr. Cox, «Frick!» di Elliot, «È quello che ha detto lei!» di Michael…), senza che cambi il contenuto della risposta (D-214).
- `pnpm test:guard` passa anche il testo di ogni personaggio delle serie dal secondo controllo vero, quando il modello c'è (D-214).
- Nella chat un agente con un personaggio delle serie mostra prima il nome del personaggio e sotto, più piccolo, quello dell'agente («Dr. Cox» / «GOD»): intestazione, partecipanti, pannello degli agenti, rapporti, Agenti, ufficio; il nome che hai scritto per l'agente in Personalità vince anche qui (D-214).

### Cambiato

- I temi Corsia e Ufficio si chiamano «Scrubs» e «The Office»; le scelte salvate restano valide (D-214).
- Il tema Scrubs non ha più il corrimano sullo sfondo della chat: la riga a metà finestra sembrava un errore (D-214).

### Sicurezza

- Il nome di un personaggio delle serie non conta come persona per il secondo controllo dei dati personali solo nel pezzo del prompt del personaggio; in un brief «Carla» o «Carla Bianchi» si trovano anche mentre Arianna indossa Carla (D-214).

## [0.109.0] - 2026-10-14

### Corretto

- La chat con GOD verso il cloud non si ferma più a ogni messaggio: date, versioni, righe, `sha256` e numeri del fascicolo non sono più presi per codice fiscale, targa o indirizzo dal secondo controllo dei dati personali (D-215).
- Le note del diario dei lavori del progetto tornano a uscire verso il Coder: «Claude Sonnet», «Codex Sol», `claude-sonnet-5-5`, «riga 78» e l'indirizzo `127.0.0.1` del core non sono dati personali (D-215).

### Sicurezza

- Codice fiscale, targa, CAP con numero civico e dati catastali contano solo con la loro forma intorno al riscontro (cercata nel testo come lo vede un lettore, come il primo scanner: codice fiscale anche spaziato, con barre, a capo, a larghezza piena o scritto a metà, targa italiana anche coi punti, CAP di 5 cifre entro 100 caratteri dal civico, parole del catasto); nessuna esclusione generica, e i dati veri delle prove restano bloccati (D-215).

## [0.108.0] - 2026-10-14

### Aggiunto

- Un dato di «Su di te» alla volta verso Claude e Codex (D-213, D-114 tappa C): quando a un lavoro serve un dato «Solo in casa», Arianna chiede con `profile.share` e nella chat compare la scheda «Coder chiede: città», con il motivo e il testo esatto che esce; «Dagli solo questo» lo aggiunge una volta al prossimo lavoro di quell'agente, «No» e Arianna va avanti senza. Il dato in Impostazioni resta com'è.
- Chi lavora per Arianna nel cloud chiede un dato su di te con una riga «Mi serve: <argomento>» nel rapporto, e Arianna lo legge come richiesta da girarti (D-213).
- Quando può chiederlo con `profile.share`, Arianna vede scritto accanto al dato privato come averlo, e non ti chiede più che cosa contiene; una proposta di dato riusa l'argomento che c'è già (D-213).
- Arianna propone di ricordare un dato stabile che le dici («mi sono trasferito a…») con `profile.propose`: la scheda «Vuoi che ricordi: città?» e, con «Sì, ricorda», il dato entra in «Su di te» come «Solo in casa» (D-213, D-114 tappa D).

### Sicurezza

- Migrazione `0065`: l'approvazione di un dato da dare a un agente (`share_fact`) e quella di un dato proposto (`fact`) si decidono solo dalla chat web; tabella `delegation_facts` (quale approvazione va con quale lavoro, mai il testo) che il database accetta solo con il declassamento scritto nella stessa transazione, una volta; un dato dato a un agente non diventa mai «Condivisibile» (D-213).
- Un dato esce solo come l'hai visto: se lo cambi o lo cancelli dopo il sì, non esce; mai da una conversazione che ha letto le finanze, mai nelle incognite; eventi con l'argomento, mai il testo (D-213).

## [0.107.0] - 2026-10-14

### Aggiunto

- **ChatGPT** senza progetto in «+ Nuovo», scheda Agente: chat semplice con i modelli di Codex (Sol predefinito, Luna o Astra dal selettore), solo di lavoro, nella CLI `codex` con il suo profilo di confinamento, attraverso il gateway; riprende la sessione dell'ultima risposta come Claude (D-111 tappa B, D-212).
- Indicatore del contesto (barra CONTESTO) anche nelle chat semplici con Claude e con ChatGPT, dal run che ha scritto l'ultima risposta (D-212).
- «Parla con…» dall'ufficio: per un agente con cui si può parlare direttamente apre la sua chat diretta più recente, sul progetto dell'isola, oppure «+ Nuovo» già su quell'agente e quel progetto (D-212).

### Corretto

- I crediti sotto una risposta della chat semplice dicono chi l'ha scritta davvero (Codex), non Claude d'ufficio (D-212).

### Sicurezza

- Migrazione `0064`: la chat semplice con ChatGPT accetta solo i modelli di Codex, anche nel database; `runs.context_tokens` tiene solo un numero (D-212).
- ChatGPT senza progetto lavora in una cartella vuota della conversazione aperta in sola lettura, senza rete, e si ferma dopo 2 comandi; con Codex spento non risponde nessuno al suo posto (D-212).

## [0.106.0] - 2026-10-14

### Aggiunto

- Personaggi veri delle serie nei temi (D-211, tappa di D-103): J.D., Turk, Elliot, Carla e Dr. Cox di Scrubs nel tema Corsia, Michael, Dwight, Jim e Pam di The Office nel tema Ufficio, disegnati in pixel art con tutte le pose come fan art per uso personale, nel pacchetto `serie` da togliere prima di condividere il repository.
- Gruppo «Serie (fan art)» nella galleria dei personaggi di Impostazioni → Agenti (D-211).

### Cambiato

- I temi Corsia e Ufficio vestono Arianna, il Coder, GOD e il revisore (in Corsia anche finanze) con i personaggi delle serie invece dei costumi; designer (e in Ufficio finanze) restano col costume del Coder, e i costumi restano sceglibili a mano (D-211).

## [0.105.0] - 2026-10-14

### Aggiunto

- Pagina «Consumi» in Impostazioni → Informazioni (D-210, idea 10 di D-093): lavori, passi, esiti, tempi e token per modello, per agente e per tipo di compito, deleghe, scelte del router per difficoltà, decisioni del gateway per destinazione, fallimenti per causa e pareri di Claude, per oggi, 7 o 30 giorni; solo conteggi letti dal database, mai il testo dei lavori.

## [0.104.0] - 2026-10-14

### Aggiunto

- I fatti di «Su di te» nel prompt dei passi locali (D-114b, tappa B): in una conversazione privata Arianna legge argomenti e testi di tutti i fatti, in una di lavoro i testi dei soli «Condivisibile» e gli argomenti dei «Solo in casa»; oltre 1500 caratteri solo gli argomenti, con lo strumento locale `profile.read` per leggerne uno. Anche gli agenti che rispondono soltanto li leggono, entro il loro limite.

### Sicurezza

- Il pezzo del profilo conta nell'etichetta del passo (D-114b): una risposta o un brief scritto dopo aver letto un fatto «Solo in casa» è L2, e verso il cloud passa solo col declassamento; il core non aggiunge fatti ai brief per Claude e Codex né alle chiamate (un fatto «Condivisibile» letto da Arianna in una conversazione di lavoro può finire in un suo brief L1, come ogni dato L1).

## [0.103.0] - 2026-10-14

### Aggiunto

- «Con chi parli» in «+ Nuovo», scheda Agente: oltre agli agenti, il **Modello locale** (conversazione privata, solo `kb.search` e `kb.read`, niente esce dal Mac) e **Claude** senza progetto (chat semplice, solo lavoro, Sonnet o Opus, senza strumenti); ChatGPT compare spento con il motivo finché Codex non risponde senza progetto (D-111 tappa B, D-209).
- La chat semplice con Claude riprende la sessione dell'ultima risposta da una cartella vuota stabile della conversazione, tolta quando la conversazione si elimina; senza sessione riparte una volta con gli scambi a cui Claude ha risposto (al più 10 e 12 000 caratteri, i più recenti), mai un messaggio bloccato dal gateway o senza risposta, come il ripiego del Coder (D-111b) (D-209).

### Sicurezza

- Migrazione `0063`: il modello locale solo in una conversazione privata, Claude e ChatGPT solo in una di lavoro e senza progetto, il Coder solo di lavoro su un progetto; una conversazione privata non ha mai un interlocutore cloud, anche nel database (D-209).
- Arianna non delega mai al modello locale di «Con chi parli», e i nomi `claude` e `codex` non si possono dare a un agente dell'utente (D-209).

## [0.102.0] - 2026-10-14

### Aggiunto

- Temi della chat (D-103, prima tappa, D-208): in Impostazioni → Aspetto la scheda «Tema» sceglie fra Base, Corsia (ispirato a Scrubs) e Ufficio (ispirato a The Office), con anteprima dal vivo; la scelta va in `[appearance]` di `arianna.toml` e vale subito su tutti i dispositivi.
- I temi sono file `apps/hud/themes/<id>/theme.json` a schema chiuso, letti dal core in sola lettura e serviti già controllati da `GET /api/themes`; un test verifica il contrasto WCAG AA di ogni tema, in scuro e in chiaro (D-103).
- Costumi di Arianna e del Coder per Corsia (casacca, cuffia, stetoscopio; camice con la croce verde) e Ufficio (camicia e cravatta, badge; giacca e cravatta), disegnati da `build.ts` su tutte le 28 pose come fogli del pacchetto `originali` e coperti dal test dei PNG (D-103).
- Sfondi dei temi dalle liste chiuse (corrimano, moquette, griglia, puntini, righe), angoli e raggio delle schede HUD scelti dal tema (D-103).

### Cambiato

- La scelta chiaro/scuro/automatico si chiama «Modalità», anche nel pulsante in alto; «Tema» è ora il tema della chat (D-103).
- Un personaggio scelto in Agenti vince sempre sul costume del tema; `/api/characters` dice da dove viene ciascun personaggio (D-103).

## [0.101.0] - 2026-10-14

### Sicurezza

- Secondo controllo dei dati personali nel gateway (D-113, tappa 2): prima di ogni uscita verso Claude, Codex, Telegram o il web, Rizzo-PII cerca nomi, indirizzi, telefoni, email e documenti e ferma l'uscita se ne trova; se non risponde l'uscita si ferma, tranne sull'installazione di sviluppo.

## [0.100.1] - 2026-10-14

### Corretto

- La descrizione di Arianna nella pagina Agenti è in italiano, come quelle degli altri agenti ufficiali; «Originale» mostra quella della scheda, che i modelli leggono in inglese.

## [0.100.0] - 2026-10-14

### Aggiunto

- Parere di Claude sulla difficoltà (D-207): quando le regole del router sono incerte, Claude Sonnet dice in una parola quanto è difficile un lavoro Pubblico o Interno e la scelta fra Sonnet e Opus si sposta di un gradino al più; al più 50 pareri al giorno, nessuno con la settimana di Claude oltre il 90%, letta dal file della barra dei consumi indicato in Impostazioni → Modelli.

## [0.99.0] - 2026-10-14

### Aggiunto

- Galleria dei personaggi nella scheda Aspetto della pagina Agenti: miniature animate divise in Originali, Tuoi e pixel-agents, un clic assegna il personaggio all'agente e Salva lo tiene (D-206).
- Pulsante «Scarica da GitHub» nella galleria e comando `pnpm characters:pixel-agents`: scaricano solo i PNG dei personaggi di pixel-agents e la licenza in `data/characters/pixel-agents`, mai in git, solo per uso personale (D-206).

## [0.98.0] - 2026-10-14

### Cambiato

- Claude e Codex scrivono in italiano il rapporto delle deleghe e le risposte all'utente; codice, nomi di file, percorsi, comandi e messaggi di errore restano come sono, così si possono copiare (D-205).

## [0.97.0] - 2026-10-14

### Cambiato

- Pagina «Sviluppo di Arianna» divisa in due schede in alto, «Domande» (barra, domande aperte, elenco delle voci, «Su di te») e «Progetti seguiti»; l'indirizzo ricorda quella aperta (`?scheda=progetti`), anche ricaricando la pagina, e il numero delle domande in attesa si vede anche dall'altra scheda (D-202).

## [0.96.0] - 2026-10-14

### Aggiunto

- Prova di Rizzo-PII, il secondo controllo dei dati personali italiani, in un ambiente Python suo (`apps/guard`), separato dalla voce: modello `rizzo-pii-0.3b` nel catalogo col ruolo nuovo «Dati personali» (`pii`), scaricabile con `pnpm arianna:models pull` (D-113, D-203).
- `pnpm guard:trial` misura il modello su 58 frasi inventate (dati personali, brief di codice, frasi comuni): richiamo e falsi allarmi per tipo, tempo per frase su GPU e CPU, rapporto in `data/evals/report-guard.json` senza il testo delle frasi; per ora non è collegato al gateway né al core (D-113, D-203).
- Comandi `guard:sync`, `guard:lock` e `test:guard` per l'ambiente di `apps/guard`, come quelli della voce (D-203).
- Campo `dir` nel catalogo dei modelli: con `dir: guard` un modello si scarica in `data/guard/models` invece di `data/models`; `pnpm arianna:models`, doctor, pagina Modelli (presenza, spazio, download, verifica, cestino) e `apps/guard` prendono la cartella dal catalogo (D-203).
- Il doctor segnala una copia di un modello di `apps/guard` rimasta in `data/models`, dove oMLX la vedrebbe (D-203).

### Corretto

- Rizzo-PII non compare più fra i modelli di oMLX: sta in `data/guard/models`, il suo download non fa ripartire oMLX, tolto dal disco va nel cestino `data/guard/models/eliminati`, e un server locale il cui comando nomina `data/guard/models` è rifiutato (D-203).

## [0.95.2] - 2026-10-14

### Rimosso

- Prezzi a consumo delle API tolti dalle schede dei modelli cloud della pagina Modelli e dal catalogo: con l'abbonamento non servono (D-137, scelta dell'utente del 2026-10-14).

## [0.95.1] - 2026-10-14

### Corretto

- Una personalità (o una regola dei progetti) con un dato personale o un valore del vault ora si rifiuta con un messaggio in italiano che dice il campo e il tipo di dato, senza ripetere il valore, al posto del messaggio tecnico inglese (D-107g).
- Il pulsante «Computer» non si sposta più sotto il cursore mentre il Coder lavora: sta nell'intestazione della card (anche nel rapporto) e la card al lavoro ha un'altezza fissa, con passi e modifiche che scorrono dentro (D-095).
- Nel rapporto del Coder l'intestazione non si taglia più: «Computer» sta in fondo e «Copia» e «Salva in inbox» compaiono al passaggio del mouse sul bordo in basso, senza lasciare un buco (D-095).
- «Controlla novità» dei progetti seguiti e le novità di Open Design si raggruppano di nuovo col modello locale: il modello riceve i commit numerati al posto degli sha, un numero che non esiste si scarta invece di far ripiegare tutto sull'elenco per tipo (D-202, D-186).

## [0.95.0] - 2026-10-14

### Aggiunto

- Progetti seguiti: nella pagina «Sviluppo di Arianna» l'elenco dei progetti GitHub da cui Arianna prende idee (Open Design col suo catalogo, OpenWork e quelli che aggiungi, al più 20), con «Controlla novità» che legge le release dall'API pubblica di GitHub (esce solo il nome del progetto) e le raggruppa col modello locale (D-202).
- Ogni novità di un progetto seguito ha «Implementiamo» e «Non interessa», che la scrivono in `data/dev/RISPOSTE.md` con la chiave `gh-<owner>__<repo>-<sha>` per Claude Code (D-202).
- Comando `pnpm projects:followed [list|add|remove|check]` con gli stessi passi dal terminale (D-202).

## [0.94.0] - 2026-10-14

### Aggiunto

- La personalità scritta in Impostazioni → Agenti entra davvero nelle risposte: in coda al prompt di Arianna e degli agenti che lavorano sul modello locale, dopo il prefisso che oMLX tiene in cache, come pezzo etichettato che passa dal gateway (D-107, tappa A3, D-107g).
- La personalità di un agente va anche nelle sue deleghe a Claude e Codex, come pezzo del brief che il gateway giudica, e nelle chiamate: quella di Arianna o dell'agente della chat diretta che parla (D-107g).
- Sei casi con personalità negli eval del modello (`pnpm eval:models`): serio, scherzoso, caloroso e una personalità ostile su rifiuti, segreti e iniezione (D-107g).

### Sicurezza

- Il testo della personalità entra solo dove la clearance dell'agente e del compito ammette L1: mai per un agente o un compito Pubblico, mai sopra il tetto cloud di un agente; altrimenti restano solo le frasi fisse di tono e forma. Nelle chiamate, senza la scheda di Arianna a disposizione, solo le frasi fisse (D-107g).
- Un testo della personalità scritto a mano in `arianna.toml` con dati personali (un IBAN, un codice fiscale) o un valore del vault non entra nel prompt, nemmeno del modello locale: restano tono e forma. Il controllo, anche al salvataggio dalla pagina, legge pure il testo appiattito su una riga, così un IBAN spezzato da un a-capo non passa (la pagina Impostazioni lo rifiutava già al salvataggio; scelta dell'utente del 2026-10-14) (D-107g).

## [0.93.0] - 2026-10-14

### Aggiunto

- Computer del Coder: pulsante «Computer» nel blocco del Coder (nella card «al lavoro», col pallino che pulsa, e in fondo al suo rapporto) che apre un pannello in sola lettura con le schede Terminale, File e Attività del lavoro; sugli schermi larghi il pannello sta accanto alla chat (D-095, tappa 1).
- Riga «Isolato» nel pannello, con la spiegazione della gabbia del Coder (solo la cartella del progetto, rete spenta, ambiente pulito, sola lettura), e l'etichetta «Bloccato dall'isolamento» sulle uscite che la sandbox ha rifiutato (D-095).
- Terminale del lavoro in diretta: comandi e uscite del Coder su Claude, tagliati a 200 righe o 16 KiB, con le righe che contengono un valore del vault nascoste; salvati con la delega (migrazione `0062_task_terminal.sql`, mai in incognito, cancellati con la conversazione), così il Terminale si rivede a lavoro finito e dopo una ricarica (D-095, scelta dell'utente durante la prova).
- Scheda File: durante il lavoro i percorsi dei file che il Coder cambia, a lavoro finito i file della delega da aprire e leggere (D-095).

### Sicurezza

- Il terminale arriva solo alla chat web, per progetti fino a L1 e solo se la clearance del lavoro (che sta dentro quella della conversazione) raggiunge l'etichetta del progetto; i valori del vault si nascondono prima del taglio; mai a Telegram. Le password scritte nei file del progetto (un `.env`) non sono note al vault e restano visibili e salvate (D-095).

## [0.92.0] - 2026-10-14

### Aggiunto

- Impostazioni → «Su di te»: cose stabili su di te, una alla volta, ognuna con argomento, testo e livello «Solo in casa» (predefinito) o «Condivisibile»; aggiungi, modifica, elimina, con l'avviso che l'argomento può uscire e che i dati veri vanno solo con l'installazione pronta (D-114, tappa A).
- Rendere «Condivisibile» un fatto «Solo in casa» mostra prima il testo esatto e chiede conferma; resta registrato come declassamento approvato da te. Tornare a «Solo in casa» è immediato (D-114).
- Tabella `user_facts` con la migrazione `0061_user_facts.sql`: argomento unico senza badare alle maiuscole, testo fino a 300 caratteri, L3 rifiutato, passaggio da «Solo in casa» a «Condivisibile» rifiutato dal database senza la sua approvazione decisa dalla chat web (D-114).
- `profileFits` e `factFieldsToScan` in `packages/policy`: cosa del profilo entra in un passo secondo la sua clearance e cosa controllare al salvataggio, con test (D-114).
- Pagina «Sviluppo di Arianna»: casella «Su di te, per Claude Code», passata dal gateway come L1 e salvata in `data/dev/UTENTE.md`, sostituita a ogni salvataggio (D-114).

### Sicurezza

- Argomento di ogni fatto e testo dei fatti condivisibili controllati da scanner e valori del vault al salvataggio; eventi dei fatti senza il testo (D-114).

## [0.91.1] - 2026-10-14

### Corretto

- Un modello scaricato dalla pagina Impostazioni → Modelli si vede in oMLX senza riavviarlo a mano: a download riuscito (file verificati) il core fa ripartire l'oMLX che ha avviato lui, aspettando che nessuna risposta, chiamata, passo di un task o prova stia usando i modelli locali; la pagina dice «oMLX si sta ricaricando…» e, per un oMLX avviato fuori da Arianna o un riavvio fallito, di riavviarlo a mano, con «Fatto» per chiudere l'avviso (D-201).

## [0.91.0] - 2026-10-13

### Aggiunto

- Rapporto di sicurezza di Opus legato al catalogo: un ruolo del Catalogo agenti o una skill si legge una volta sola per versione, la prima volta che lo apri (pagina Catalogo agenti, «Nuovo agente → Dal catalogo» al passo 1, Skill e stili); più agenti nati dallo stesso ruolo condividono lo stesso rapporto (D-196).
- Il rapporto di un agente è la composizione dei rapporti del suo ruolo e delle sue skill, senza letture nuove: vince lo stato peggiore e ogni segnalazione dice se viene dal ruolo o da quale skill; assegnare una skill già controllata non costa letture (D-196).
- Il rapporto si vede accanto al ruolo nel Catalogo agenti, sotto il ruolo scelto in «Nuovo agente», accanto ad «Accendi ora» alla fine della creazione e sopra «Accendi» nella pagina dell'agente, con pillola nella testata e pallino nell'elenco (D-196).
- Quattro stati: nessun problema con i controlli superati; da guardare con riga, pezzo di testo evidenziato, gravità «Sospetto» o «Da capire» e spiegazione; in corso; non disponibile senza Claude o senza quota, con «Rifai il rapporto». Accendere con segnalazioni, a rapporto in corso o senza rapporto chiede una conferma in più, mai un blocco (D-196).
- Dopo «Usa questa versione» di una raccolta, i ruoli cambiati da cui è nato un agente si rileggono da soli, solo nelle righe cambiate con il contesto intorno; le segnalazioni su righe rimaste uguali restano (D-196).

- Descrizioni dei ruoli del Catalogo agenti in italiano, tradotte da Sonnet una volta per descrizione come quelle delle skill: nel Catalogo agenti, in «Nuovo agente → Dal catalogo» e nella testata dell'agente nato dal ruolo, con «Originale» per leggere il testo degli autori; il nome del ruolo resta in inglese, la ricerca trova anche le parole italiane (D-185).

### Sicurezza

- La risposta di Opus si controlla sul testo: segnalazioni su righe inesistenti scartate, pezzo citato che non sta alla riga declassato a «Da capire», segnalazioni tutte scartate danno «da guardare», lunghezze limitate, risposta illeggibile = rapporto non disponibile (D-196).
- Opus legge il ruolo di una scheda fra i marcatori con lo sha256 esatto del file: un marcatore di chiusura finto dentro il ruolo non nasconde le righe dopo; mai il nome dell'agente nel testo inviato (D-196).

## [0.90.0] - 2026-10-13

### Aggiunto

- Impostazioni → Modelli: scheda «Confronto» accanto a «Elenco», con tutte le prove dell'orchestratore anche dei modelli tolti dal catalogo o cancellati dal disco: risposte giuste, le cinque misure con la soglia, velocità, attesa della prima parola, tempo per domanda, memoria e data, il migliore di ogni colonna in grassetto e le prove precedenti di un modello in una riga che si apre (D-199).
- «Prova di riferimento» prova il modello in uso per l'orchestratore sulle stesse domande degli altri, con il percorso delle prove di D-081 (D-199).
- Con 2-3 righe spuntate: frase di verdetto calcolata dal codice (rapporto di velocità, domande sbagliate in più o in meno e in quali capacità, capacità sotto soglia), barre affiancate con la soglia e le domande finte con esiti diversi, solo fra prove sulle stesse domande (D-199).
- Ogni prova salva la velocità (token al secondo e attesa della prima parola, dallo streaming e dal conteggio dei token del server locale, mai stimate), una copia di nome, fornitore, dimensione, quantizzazione e memoria della voce del catalogo e, per ogni domanda, l'azione scelta in valori chiusi; migrazione `0060_model_evals_compare.sql` (D-199).

## [0.89.4] - 2026-10-13

### Cambiato

- La consegna fra conversazioni (`docs/HANDOFF.md`) tiene solo lo stato attuale; la storia passa in `docs/HANDOFF-STORIA.md`, esclusa come `HANDOFF.md` dai documenti che Arianna legge come conoscenza (D-200).
- Un commit che tocca solo file `.md` e `.html` di `docs/` e `CHANGELOG.md` salta `pnpm check` nel pre-commit; il controllo dei marcatori di conflitto resta, e ogni commit con codice fa il controllo completo (D-200).

## [0.89.3] - 2026-10-13

### Sicurezza

- Le note approvate dall'Archivista vanno in `kb/archivio/<cartella>`, esclusa da git, e non più fra i documenti di sviluppo tracciati di `kb/`: un pensiero dell'utente non diventa mai un file pronto per un commit (D-198).
- Nell'archivio una nota ha almeno l'etichetta della stessa cartella fuori dall'archivio e mai meno di L2; una cartella la cui posizione nell'archivio supera L2 non viene proposta (D-198).
- All'avvio il core sposta in `kb/archivio/` le note già approvate finite in una cartella tracciata, senza sovrascrivere né abbassare l'etichetta, con un evento L0 di soli conteggi; anche Codex in sviluppo non vede `kb/archivio/` (D-198).
- Il grafo di Conoscenza e la ricerca della kb leggono `kb/archivio/` per ultimo: oltre il tetto di pagine si taglia l'archivio, mai gli altri documenti di `kb/` (D-198).

## [0.89.2] - 2026-10-13

### Cambiato

- Descrizioni delle skill in italiano anche nella scheda «Skill» degli agenti e in Impostazioni → Skill e stili, con la stessa traduzione dello Studio e ricerca anche sulle parole italiane; la scheda «Skill» mostra la descrizione anche delle skill già assegnate (D-185).

### Corretto

- Una risposta illeggibile di Claude alla traduzione delle descrizioni delle skill ferma la traduzione invece di farla ripartire a ogni apertura: le traduzioni valide restano, le stesse mancanti si riprovano solo dopo un riavvio o quando cambiano le skill (D-185).

## [0.89.1] - 2026-10-13

### Corretto

- Impostazioni → Agenti: la scheda «Skill» di un agente spento permette di assegnare le skill prima di accenderlo (stessa regola: mai Arianna, mai una scheda con `untrusted_content` chiuso), i motivi di rifiuto sono tutti in italiano e la descrizione del Catalogo agenti non dice più «presto» per «+ Nuovo agente» (D-161).
- Eliminare un agente toglie da `arianna.toml` anche il suo modello e le sue skill (`[agents.<id>]`): un agente nuovo con lo stesso nome parte senza modello né skill; se il file non si può aggiornare l'eliminazione è rifiutata e non sposta nulla (D-161).

## [0.89.0] - 2026-10-13

### Aggiunto

- Catalogo agenti da GitHub: `pnpm agents:catalog` segue fino a 100 raccolte di ruoli, scarica solo i `.md` dei ruoli e la licenza, un download alla volta, con confronto e «Usa»/«Scarta» come per le skill; prima del primo download la licenza «si saprà» (D-079).
- «+ Nuovo agente» → «Dal catalogo»: si sceglie un ruolo (ricerca, raccolta, divisione), si scelgono nome e permessi dentro quelli ammessi, e l'agente nasce spento con provenienza e licenza nella scheda; una raccolta senza licenza chiede conferma (D-079).
- Agenti nati dal catalogo: pallino e badge «Aggiornamento disponibile», filtro «Da aggiornare», confronto delle righe del ruolo e «Riadotta…», che riscrive solo il testo del ruolo, tiene quello vecchio fra gli eliminati e spegne l'agente; «Tieni la versione di adesso» per lasciarlo com'è (D-079).
- Impostazioni → «Catalogo agenti», subito dopo «Skill e stili»: raccolte di ruoli da GitHub con coda dei download, spazio usato, licenza di ogni raccolta e ruoli da sfogliare per divisione (D-079).

### Cambiato

- Il catalogo delle skill e quello degli agenti usano lo stesso motore delle sorgenti GitHub (D-079, D-161).
- Una scheda nata da un ruolo di terzi riporta sorgente, commit, sha256 e la licenza della sua raccolta; senza licenza lo dice con un avviso (D-079).

### Rimosso

- `pnpm agency:import`, il clone a mano e `config/agency.lock`: le schede già proposte restano riconosciute come schede di terzi (D-079).

## [0.88.0] - 2026-10-13

### Aggiunto

- Pensieri, «Da archiviare»: dopo il riordino l'Archivista (il modello locale, mai il cloud) propone per ogni pensiero una cartella di `kb/` fra quelle che esistono, un titolo e qualche collegamento a note già archiviate; li approvi uno a uno o in blocco, correggi cartella, titolo e collegamenti, o scarti; una proposta di un pensiero cambiato dopo scade e si chiede di nuovo (D-195).
- Lo spostamento approvato tiene il testo, scrive l'etichetta che il pensiero aveva (mai più bassa, anche in una cartella L0 o L1), non sovrascrive mai un file, non passa da link simbolici né esce da `kb/`, e riscrive i collegamenti delle altre note al percorso nuovo; nel registro eventi `note.archived` senza percorsi né titoli (D-195).

## [0.87.0] - 2026-10-13

### Aggiunto

- Impostazioni, Aspetto e installazione: «Pronta per i dati veri» con «Controlla di nuovo», l'elenco di cosa manca in parole semplici e l'esito dell'ultimo `pnpm arianna:doctor` per i controlli del database che fa solo il terminale (D-192).
- Impostazioni, Voce e chiamate: «Ascolta» accanto alla voce scelta dice una frase di prova con il modello di «Parla con la sua voce», anche prima di salvare, con «Ferma»; disattivato con la spiegazione quando il servizio della voce non è acceso o c'è una chiamata in corso (D-192).
- `pnpm arianna:doctor` scrive id ed esito dei controlli, senza dettagli, in `data/doctor/last.json` (D-192).

### Cambiato

- I controlli dell'installazione senza database passano dall'installer al core, una sola copia per il doctor e per la pagina (D-192).
- Chat: i messaggi d'errore e gli avvisi dicono «Arianna» invece di «nucleo» («Arianna non risponde: controlla che sia avviata.», «Errore di Arianna: riprova fra poco.»), anche nel titolo della chat di sistema dei task falliti («Perché è fallito: Arianna»); due test controllano che la parola non torni nella chat né nel core (D-192).

## [0.86.0] - 2026-10-13

### Aggiunto

- `pnpm dev:codex` lancia Codex CLI interattivo sullo sviluppo di Arianna da `packages/executors`, con un profilo di permessi che chiude ciò che git esclude (`data/`, `config/arianna.toml`, `kb/inbox/`, `kb/progetti/`, `repos/`…) e le cartelle di lavoro di Claude Code, e nessun comando fuori dal sandbox; le regole per Codex sono in `AGENTS.md` (D-143).

### Cambiato

- ESLint ignora anche `kb/inbox/` e `kb/progetti/`: nel sandbox di `pnpm dev:codex` sono negate e la scansione di `pnpm lint` fallirebbe su di esse (D-143).

### Sicurezza

- `pnpm dev:codex` tiene in sola lettura le regole che confinano gli agenti, i `.gitignore` e la configurazione degli strumenti (`.git`, `.githooks/`, `.claude/`, `.codex/`, `CLAUDE.md`, `AGENTS.md`, `AGENTS.override.md`, `.mcp.json`, `package.json`, `eslint.config.js`…); rifiuta una `HOME` mancante, una versione di `codex` non verificata, le istruzioni globali e le regole di esecuzione dell'utente, una configurazione gestita di Codex, chiavi del suo `config.toml` di Codex che uscirebbero dal profilo e server MCP accesi, file di istruzioni in più, un `.gitignore` cambiato e argomenti che allenterebbero il profilo; parte con l'ambiente pulito dell'adattatore, senza rete né cronologia. L'utente legge il diff di Codex prima di `pnpm check` e del commit (D-143).
- `docs/PRIVACY-POLICY-SPEC.md` scrive l'eccezione di `pnpm dev:codex` ai punti 2, 5, 7 e 8 del confinamento e cosa la compensa (D-143).

## [0.85.4] - 2026-10-13

### Cambiato

- Conoscenza: chi non aveva mai scelto una vista ora apre il grafo in 3D; chi aveva premuto «2D» lo ritrova in 2D (D-104).
- Conoscenza in 3D: la rotazione lenta a riposo ridisegna al massimo 30 volte al secondo, anche sugli schermi a 120 Hz; il layout 2D si prepara solo quando si passa al 2D (D-104).

## [0.85.3] - 2026-10-13

### Cambiato

- Progetti, Conoscenza: tre colonne come una mail (cartelle, note in righe con data, prima riga e stato, nota aperta a destra); la nota si legge impaginata, con l'intestazione come riga di dati e le caselle dei lavori (D-193).
- Chat e Novità: le caselle dei lavori `[x]`, `[ ]`, `[/]`, `[>]`, `[-]` si vedono come caselle (D-193).

## [0.85.2] - 2026-10-13

### Cambiato

- GOD e Pensieri: testata comune come Novità e Sviluppo (titolo normale, frase sotto, azioni a destra) e larghezza 1120 px (D-194).
- Studio: senza un progetto scelto, una card per progetto con le miniature dei mockup più recenti (D-194).
- Conoscenza, Segretaria, Cardwall e Ufficio: titoli e testi nel carattere normale invece del maiuscolo HUD, filtri del Cardwall che vanno a capo, istruzioni del grafo e comandi dell'ufficio dietro un «?» (D-194).

## [0.85.1] - 2026-10-13

### Cambiato

- Progetti, Regole: la scheda prende la larghezza della pagina, con l'elenco delle regole a sinistra e a destra una colonna ferma con «Quali regole», «Bozza» ed «Esporta» (D-193).

## [0.85.0] - 2026-10-12

### Cambiato

- Progetti, testata: nome del progetto nel carattere normale, cliente con il logo sotto, quattro numeri cliccabili (Branch, Modifiche, Servizi, Prossimo IM con l'avviso delle fatture scadute) e larghezza come Finanze e Clienti (D-191).
- Progetti: elenco dei progetti a card come i Clienti, con cliente, parti, calendario e prossimo IM, «Da fatturare», «In attesa» con le scadute e «Incassato» dell'anno; clic apre il progetto, «‹ Progetti» torna alla griglia, l'ultima card aggiunge un progetto (D-191).
- Progetti: schede in una sola fila (File, Git, Servizi, Conoscenza, IM, Regole); il selettore delle parti compare solo in File, Git e Servizi (D-191).
- Progetti, testata: «Apri in VS Code» e «Apri nello Studio» restano sulla riga del nome, il percorso lungo si accorcia con «…» (D-191).
- Progetti, IM: quattro numeri in alto; calendario e prezzo in un solo modulo con un solo «Salva» che compare solo con modifiche e dice cosa cambia (D-191).
- Progetti, IM: il prezzo di un IM si cambia nella sua cella, le righe cambiate si colorano e un solo «Salva» li scrive tutti; «Non si fattura» nel menu ⋯ della riga; fatture come tabella con le azioni nel menu ⋯ e l'avviso della scaduta in cima (D-191).
- Progetti, Regole: un solo elenco nel carattere normale con il selettore a pillola Entrambi / Solo Claude Code / Solo Codex, «Modifica come testo», interruttore Modello comune / Regole proprie, esportazione in alto con l'anteprima in una finestra e barra di salvataggio solo con modifiche (D-191).
- Progetti, Conoscenza: cartelle con il numero di note, note come card per cartella, ricerca fra le note e «+ Nota» al posto di «+ Conoscenza» (D-191).
- Progetti, File: albero nel carattere normale, quadratino colorato al posto della targhetta del tipo, avviso verde dopo uno spostamento (D-191).
- Progetti: errori e stati vuoti che dicono cosa fare, con «Riprova», «Aggiungi un progetto», «Correggi qui», «Server locali», «Apri il cardwall» dove servono (D-191).

### Corretto

- Progetti: la parte scelta non resta più evidenziata nelle schede IM e Regole (D-191).
- Progetti: le parti di un contenitore (per esempio progetto-test-admin) aprono di nuovo file, Git e Servizi: il core non riconosceva il loro nome scritto nell'indirizzo con «%3A» al posto di «:» (D-145).

## [0.84.0] - 2026-10-12

### Cambiato

- Impostazioni: ogni sezione larga uguale, con titolo normale, una pillola («Vale subito», «Con conferma»), una frase con un esempio e i campi su sei colonne (D-192).
- Impostazioni: indice in sei gruppi (Intelligenza, Comunicazione, Lavoro, Privacy e uscite, Sistema, Informazioni) con i nomi nuovi «Claude e Codex», «Link da riassumere», «Server dei modelli», «Aspetto e installazione»; i vecchi indirizzi portano alla sezione nuova (D-192).
- Impostazioni: Novità e Sviluppo di Arianna sono sezioni con l'indice a sinistra; `/novita` e `/sviluppo` portano lì (D-192).
- Impostazioni: una sola barra di salvataggio per sezione, che compare solo con modifiche; ambra con «Rivedi cosa esce…» dove i dati possono uscire dal Mac (D-192).
- Impostazioni, Modelli: «Chi fa cosa» in alto con i ruoli detti per compito, un solo interruttore per i modelli cloud, scheda in parole semplici, Hugging Face chiuso in fondo (D-192).
- Impostazioni, Agenti: schede in carattere normale, permessi detti a parole, campi su sei colonne; i cataloghi passano in «Skill e stili» (D-192).
- Impostazioni: la chiave delle notifiche a chat chiusa passa da Voce a Notifiche, in Avanzate; anche porta della voce e indirizzo e comando dei server stanno in Avanzate chiuse (D-192).
- Impostazioni: la conferma delle uscite dice anche cosa non esce mai e si applica con «Conferma e salva» (D-192).

### Aggiunto

- Impostazioni: voce «Skill e stili» con gli stili per il Designer, le Novità di Open Design e le skill da GitHub (D-192).
- Impostazioni, Claude e Codex: cosa riceve ciascuno e la tabella «Cosa resta sempre sul Mac» al posto della voce Etichette (D-192).
- Impostazioni: errori con «Riprova» e il collegamento alla sezione che risolve, stati vuoti che dicono cosa fare (D-192).

## [0.83.0] - 2026-10-12

### Cambiato

- Clienti: ogni cliente è una card con logo, contatto principale, progetti e tre numeri dell'anno (guadagno, da fatturare, in attesa con le scadute in rosso); nuovo menu «Ordina» e card «+ Nuovo cliente» (D-190).
- Clienti: la scheda del cliente si apre sulla Dashboard e mostra il contatto principale sotto il nome (D-190).
- Clienti, Anagrafica più stretta e a sezioni: campi corti per i valori corti e bordo ambra sui campi che la fattura elettronica chiede (D-190).

### Aggiunto

- Clienti: «Completa» sull'avviso della fattura elettronica porta all'Anagrafica sul primo campo da riempire (D-190).
- Clienti, Dashboard: l'avviso di una fattura senza totale con IVA dice quale fattura e quanto conta adesso, con «Scrivi il totale» che apre la scheda IM del progetto su quella fattura (D-190).

### Corretto

- Clienti, Dashboard: l'asse dei valori del grafico non è più tagliato a sinistra (D-190).

## [0.82.0] - 2026-10-12

### Cambiato

- Finanze, Riepilogo come cruscotto: in alto saldo dei conti, uscite ed entrate dell'ultimo mese contro il mese prima e budget superati; grafico largo accanto alle spese per categoria con il budget, poi ultimi movimenti, confronto con l'anno prima e avvisi del mese (D-189).
- Finanze, Movimenti a righe basse: nome dell'esercente leggibile con tipo di pagamento, carta e conto sotto; la categoria è un pulsante a pillola con un menu che contiene anche «crea una regola» (D-189).
- Finanze, Categorie e budget su due colonne: un solo «Salva» per tutti i budget, con quanto speso nel mese accanto a ciascuno; categorie a pillola (D-189).
- Finanze: tutte le schede hanno la stessa larghezza (D-189).

### Corretto

- Pannello Agenti: l'intestazione «Deleghe recenti» non si accavalla più alla scritta accanto (D-188).

## [0.81.0] - 2026-10-12

### Cambiato

- Chat più leggibile: testi di base a 15 px e mai sotto 12 px salvo le miniature, grigio secondario più scuro, niente griglia di fondo (D-188).
- Barra sinistra: pulsante «Nuova conversazione» in evidenza e le aree in tre gruppi richiudibili (Lavoro, Personale, Sistema); il gruppo della pagina aperta resta aperto e la scelta si ricorda nel browser (D-188).
- Pannello Agenti: solo gli agenti al lavoro o in attesa restano schede grandi; gli altri sono righe basse con la testa e «libero», così Instradamento e Deleghe salgono (D-188).
- Barre laterali un po' più larghe (288 e 320 px) per i testi più grandi (D-188).

## [0.80.0] - 2026-10-12

### Aggiunto

- «Allega nota privata» nelle chat di lavoro su un progetto: il pulsante accanto al campo di scrittura elenca le note Private del progetto e apre lo stesso pannello di «Fai uscire una volta», con il testo che arriva nella chat in cui sei (D-187).

## [0.79.0] - 2026-10-12

### Aggiunto

- «Fai uscire una volta» su una nota Privata della scheda Conoscenza: il modello locale propone una versione anonima accanto all'originale, la correggi e la approvi con la master password, ed esce solo quel testo, una volta, come messaggio Interno di una conversazione di lavoro dello stesso progetto; la nota resta Privata, le Riservate e le finanze non escono mai (I-11 P5, D-187).
- `pnpm vault:master`: chiede la master password senza mostrarla e stampa la sua impronta scrypt da incollare nel vault con `pnpm vault:edit` (D-187).
- Gruppo di eval `anonymize` in `pnpm eval:models`, 8 casi con dati finti (D-187).

## [0.78.0] - 2026-10-12

### Aggiunto

- Novità di Open Design: a ogni «Aggiorna catalogo» il core legge dall'API pubblica di GitHub release e commit fra la versione in uso e quella nuova, il modello locale li raggruppa in poche voci in italiano (senza modello, l'elenco dei commit per tipo), e la pagina «Sviluppo di Arianna» le mostra con «Da rifare nello Studio», che le scrive in `data/dev/RISPOSTE.md` per Claude Code; un riepilogo compare anche accanto al confronto di stili e skill (I-21, D-186).

### Corretto

- Studio: un esempio di stile resta valido quando cambia solo la versione del catalogo e non il suo `DESIGN.md` (l'impronta contava anche l'avviso di licenza con il numero di versione) (I-20, D-185).

## [0.77.0] - 2026-10-12

### Aggiunto

- Studio: «Elimina» chiede in una finestra che spiega lo spostamento in `eliminati/`, con la spunta «Elimina definitivamente» spenta di base (I-20, D-185).
- Studio: stile e skill si scelgono in una finestra: ogni stile è la stessa pagina di prova disegnata con i suoi colori, caratteri e angoli presi dal `DESIGN.md`, con categoria, descrizione e «Leggi tutto»; le skill con la loro descrizione (I-20, D-185).
- Studio: sotto la barra, con che stile e skill è stata fatta la variante mostrata (e quella a confronto), dal registro `varianti.json` che il core scrive accanto ai mockup alla fine di ogni lavoro del Designer (I-20, D-185).
- Studio: «Apri in Progetti» apre il progetto con la cartella dei mockup aperta nella scheda File; in Progetti «Apri nello Studio»; nella chat col Designer su un progetto il pulsante «Apri nello Studio» (I-20, D-185).
- Chat col Designer: pulsante «Nuova sessione» e, quando la sessione supera metà del contesto, la proposta dopo una risposta: la conversazione resta intera con la riga «Nuova sessione · il Designer ricorda solo da qui», e il Designer smette di rileggere la sessione di prima e riparte da un breve riassunto scritto dal codice (ultime richieste, ultima risposta, variante aperta nello Studio); «No» ripropone più avanti (I-20, D-185).
- Studio: nella finestra di stile e skill «Genera esempio» (o «Genera i mancanti») fa scrivere a Claude Opus una landing e una presentazione in quello stile, salvate e mai rifatte finché lo stile non cambia, con «Vedi esempio» in una cornice isolata e il costo scritto (circa l'1% della sessione di 5 ore per esempio, misurato); le descrizioni delle skill in italiano, tradotte una volta da Sonnet (I-20, D-185).
- Studio: stile e skill sotto la barra sono collegamenti: lo stile mostra prima i suoi esempi (landing e presentazione), poi la descrizione; nella finestra di scelta un secondo clic sullo stile scelto lo toglie (I-20, D-185).
- Progetti → File: «Sposta o rinomina», «Elimina» (per sempre) e, nei file di `eliminati/`, «Ripristina», ognuno con una finestra di conferma; niente su collegamenti, file nascosti, `node_modules` né mentre un agente lavora sul progetto (I-20, D-185).

## [0.76.0] - 2026-10-12

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
