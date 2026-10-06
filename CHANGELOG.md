# Registro delle versioni

Ogni lavoro finito e provato dall'utente diventa una versione, con un tag git `vX.Y.Z` sul commit di `main` che lo porta. Le versioni seguono [SemVer](https://semver.org/lang/it/) in 0.x finché Arianna non è pronta per i dati veri: **minor** (0.X.0) per una funzione nuova, cioè una decisione o un task chiuso; **patch** (0.x.Y) per correzioni e ritocchi. La 1.0.0 arriva quando `pnpm arianna:doctor` dà l'installazione pronta per i dati veri. I dettagli di ogni voce stanno in `docs/DECISIONS.md` (gli id D-NNN) e in `docs/PHASE-0-1-TASKS.md`. La chat web mostra questo file nella pagina "Novità" delle Impostazioni.

## [Non rilasciato]

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
