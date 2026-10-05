# Registro delle versioni

Ogni lavoro finito e provato dall'utente diventa una versione, con un tag git `vX.Y.Z` sul commit di `main` che lo porta. Le versioni seguono [SemVer](https://semver.org/lang/it/) in 0.x finché Arianna non è pronta per i dati veri: **minor** (0.X.0) per una funzione nuova, cioè una decisione o un task chiuso; **patch** (0.x.Y) per correzioni e ritocchi. La 1.0.0 arriva quando `pnpm arianna:doctor` dà l'installazione pronta per i dati veri. I dettagli di ogni voce stanno in `docs/DECISIONS.md` (gli id D-NNN) e in `docs/PHASE-0-1-TASKS.md`. La chat web mostra questo file nella pagina "Novità" delle Impostazioni.

## [Non rilasciato]

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
