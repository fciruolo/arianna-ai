# Consegna fra conversazioni

Questo file dice a una nuova sessione di Claude Code da dove riprendere: **solo lo stato attuale**, corto. Si aggiorna a fine task e ogni volta che si propone di aprire una conversazione nuova (regola in `CLAUDE.md`). Contiene solo ciò che non si ricava da git e dagli altri documenti. La storia delle consegne precedenti (fino al 2026-10-13 sera) sta in `docs/HANDOFF-STORIA.md`: non si legge a inizio sessione, ci si cerca con `grep` quando serve un dettaglio passato. Quando un paragrafo di stato diventa storia, si sposta in fondo a `HANDOFF-STORIA.md` invece di accumularsi qui; la riga «Aggiornato» tiene solo l'ultima data.

Aggiornato: 2026-10-24, notte.

**Stato (2026-10-24, notte).** `main` alla **0.182.0**, pushato coi tag. **Cartella principale sul ramo `prova/mac-azioni`** (I-22 M2), core avviato da lì (al database di sviluppo sono già applicate le migrazioni fino a 0097), chat e database accesi; Docker a 5 GB.
- **Unite oggi sera:** 0.181.0 fatture FatturaPA (D-310), con la correzione di «Togli» (la chat mandava le scritture senza corpo e il core le rifiutava con 415: corretto in `call` di `apps/hud/src/lib/api.ts`, valeva anche per «Scarica» dei personaggi, le battute delle serie e «Togli» di una cartella del Mac) e i prezzi delle righe all'italiana; 0.182.0 milestone D-313 seguiti 2 e 3: `milestone.propose` dalla chat, «Progetta la milestone …» senza barra, `/progetta` e `/Progetta la milestone X che deve fare …` (nome e scadenza letti dal codice, `apps/core/src/plan-milestone.ts`), scadenze «fine/inizio/metà mese», «fine mese», «fine anno» in `parseDay`, la scadenza presa dal messaggio se il modello la dimentica, la nota «This is a work conversation of the project …» prima della chat (`projectNote`), «Cardwall» invece di «Bacheca».
- **Rami pronti, in attesa della prova dell'utente** (ognuno ha `main` 0.182.0 dentro, `pnpm check` verde, test del database dei file toccati verdi); vanno uniti **in quest'ordine**, perché il core rifiuta una migrazione più bassa dell'ultima applicata:
  1. `task/i22-m2-azioni-mac` (D-320, migrazione `0097_mac_changes.sql`): unione con D-314 fatta (descrizione di `mac.list` di M2 col divieto dei nomi; casi «sola lettura» sostituiti dai casi di M2 con `noToolNames`); ritocchi di `mac.find` (solo file del Mac, le note con `kb.search`) e `mac.trash` («definitivamente» va nel Cestino); caso nuovo `orch-mac-reply-after-mkdir`; `pnpm eval:models --tag mac` 11 su 11; `reviewer` senza problemi. Prova di Claude in Chrome (conversazione Privata, «Crea una cartella Prova-Arianna nei Documenti»): arriva la scheda «Posso guardare in questa cartella?», con «No» niente viene creato e la risposta non nomina strumenti; la frase dopo il «No» («non mi è stato ancora concesso il permesso… Non posso chiederlo di nuovo») è da limare. La prova vera, con i «Sì», la fa l'utente su `Documenti/Test/progetto-arianna`. Versione all'unione: 0.183.0.
  2. `task/proposta-ricerca-ibrida` (D-318, migrazione `0098_retrieval.sql`): nella chat non si vede niente (Cerca e `kb.search` non sono collegati); prova tecnica: migrazione, doctor senza segnalazioni su `retrieval_forget_file`, `pnpm eval` verde. Dopo l'unione del Mac va riunito `main` dentro (CHANGELOG). Versione: 0.184.0.
  3. `task/memoria-passo-c` (decisione rinumerata **D-319**): candidata `ours` di `pnpm eval:memory`; il lockfile ora dà `postgres` con la patch anche a `packages/evals`. **Prova vera fatta da Claude il 2026-10-24 alle 20:47** (dalla cartella principale spostata un momento su `prova/memoria`, poi riportata su `prova/mac-azioni`): privacy 46 su 46 (decide l'esito: OK), esattezza 16 su 21 giuste, 0 sbagliate, 5 dubbie (durata, ordine, quando-cambiato, una di relazioni, tre temporali: aspettano il giudice Claude del passo (d)); entrata di un episodio 3,6 s in media, risposta 1,6 s (p95 2,6 s); 29 chiamate al modello; un minuto e mezzo in tutto. Rapporto in `data/evals/report-memory-ours.json`. Versione all'unione: 0.185.0.
- **Base degli eval completi del modello locale** (35B, 2026-10-24 sera, `pnpm eval:models` sul ramo del Mac): orchestratore 84 su 90 (strumenti 65/70; «plan» 2/3 sotto soglia), finanze 18/18, anonimizzazione 6/8 (`anon-address`, `anon-price`), note 14/15 (`wiki-create-docker`). Falliti dell'orchestratore: `orch-plan-taxes`, `orch-profile-share-private-fact`, `orch-delegate-failing-test`, `orch-web-search`, `orch-delete-file`, `orch-plan-vague-landing`: nessuno offre gli strumenti del Mac e gli eval non passano dalla nota del progetto, quindi non vengono da questi rami. È la base da confrontare la prossima volta.
- **Prima risposta del modello locale:** 12,1 s la prima risposta dopo 10 minuti di modello fermo e nessuna richiesta in mezzo (2026-10-24, 20:45, Docker a 5 GB, `pnpm eval:models --tag mac` e `data/omlx/logs/server.log`), poi 1,6-3,7 s (circa 42 token al secondo). Prima: 36 s con Docker a 8 GB, 96 s con il Mac sotto carico. Il caricamento dallo swap non pesa più come prima: misura chiusa, da rifare solo se la memoria cambia (più container, voce accesa).
- **Cartelle vecchie in `.claude/worktrees/`:** l'utente ha detto di cancellarle (97 cartelle non registrate, circa 1,5 GB), ma il controllo dei permessi ha bloccato la cancellazione: lo script `data/test-tmp/pulizia_worktree.py` toglie solo quelle non registrate in git, da lanciare con `! python3 data/test-tmp/pulizia_worktree.py`. C'è anche `.claude/worktrees/handoff-main`, la copia di `main` usata per questa consegna: si toglie con `git worktree remove`.
- **Una riga doppia comparsa da sola** in `apps/hud/test/projects-page.test.ts` alle 18:50 (`PROJECT_TABS` importato due volte, forse un import automatico di un editor) bloccava `vue-tsc`: tolta con `git restore`.
- **Test instabili sotto carico:** `packages/evals/test/memory.test.ts` («passes every privacy check…»), `canary.test.ts`, `apps/core/test-db/pgvector.test.ts` (timeout del doctor), `roles`, un deadlock in `message-queue`, `apps/core/test/characters.test.ts` (`EPIPE` sul caricamento), `apps/core/test-db/mcp.test.ts` («an L1 page…»). Da soli passano.
- **Catalogo dei modelli:** l'orchestratore della cartella principale (`qwen3.8-35b-a3b-distill-mlx-4bit`) non è nel `config/models.catalog.yaml` di `main`: nei worktree si usa `qwen3.8-27b-4bit`. Da capire (catalogo locale dell'utente?) e, se serve, aggiungerlo.
- **I-23 ricerca ibrida, scelte dell'utente (D-318):** provino EmbeddingGemma 2 contro BGE-M3, indice di KB, note e conversazioni, un elenco per pertinenza con «per significato», riordinatore solo se migliora, Claude e Codex sul solo indice condivisibile.
- **Passo (d) delle memorie (scelta dell'utente):** un giro solo del giudice Claude con tetto di circa 60 chiamate, fermo sopra il 90% della quota settimanale (in `MEMORIA-CONFRONTO.md` sul ramo `task/memoria-passo-c`).
- **Decise e non partite:** I-22 M3 (Annulla e registro), M4; terminale dopo M1-M3; D-096 backup cifrato per ultimo.
- **Prove «Testalo tu» in Chrome:** mai approvare schede su cartelle fuori dal repository; su una scheda di permesso del Mac si sceglie «No». Il modello locale ci mette 30-40 secondi a rispondere: aspettare leggendo il database (approvazioni e messaggi della conversazione), non con le schermate ogni 10 secondi.
- **Il Mac va in stop di notte:** per comandi lunghi senza l'utente usare `caffeinate -i`.

## Dove siamo

- **Fase 0 chiusa** (2026-10-02). **Fase 1A chiusa** (2026-10-24, D-309; P7 aspetta i dati veri). **Fase 2 in corso**, con i task di 1B in parallelo; molti task di 1B sono già su `main`. Stato dei task in `docs/PHASE-0-1-TASKS.md`, scelte in `docs/DECISIONS.md`, versioni in `CHANGELOG.md`, storia in `docs/HANDOFF-STORIA.md`.
- Macchina di lavoro: Mac Studio con 32 GB; oMLX lo avvia il core (D-071), orchestratore `qwen3.8-35b-a3b-distill-mlx-4bit` (D-201). Col 35B caricato lo swap arriva a 6-9 GB (sul Mac girano anche una ventina di container Docker di altri progetti; il doctor segnala `models.ram`): se la pressione della memoria resta alta, valutare con l'utente il 9B per la voce o meno servizi accesi.
- **Note per dopo:** il clone di GOD `repos/arianna/main` è fermo a una versione vecchia (`pnpm god:clone` lo aggiorna). Prima di condividere il repository vanno tolti personaggi e luoghi delle serie anche dalla storia di git (elenco in `apps/hud/characters/serie/LEGGIMI.md`).

## Prossimi passi, in ordine

1. Domande di prova all'utente, una per ramo e nell'ordine: azioni sul Mac (cartella principale già su `prova/mac-azioni`), ricerca ibrida, memoria passo c. Con «Funziona»: unione su `main` con versione, CHANGELOG, tag e push; prima di ogni ramo successivo, `main` dentro di nuovo e `pnpm check`.
2. Passo (d) delle memorie: il giudice Claude sulle 5 risposte dubbie (tetto di circa 60 chiamate).
3. I-23: voci del catalogo con la rete, provino dei due modelli, collegamenti nel core e in Cerca. Poi passo (d) delle memorie, I-22 M3; D-096 per ultimo.

Come si porta un lavoro di un subagente fino a `main`: `reviewer` sul suo ramo, correzioni, `pnpm check` (e `pnpm test:db` se tocca il database), un ramo `prova/…` con `main` dentro su cui spostare la cartella principale, riavvio di core e chat, una domanda a opzioni per lavoro; con «Funziona» unione su `main` con versione, CHANGELOG, tag e push, ritorno su `main`. Le migrazioni di un ramo vanno finite prima di avviare il core su quel ramo (una migrazione applicata non si cambia più).

## In attesa dell'utente

- Le tre prove dei rami pronti (sopra), da chiedere con una domanda a opzioni per ramo.
- La cancellazione delle cartelle vecchie in `.claude/worktrees/` (bloccata dal controllo dei permessi): lo script è pronto.
- Le domande aperte stanno in `docs/OPEN-QUESTIONS.md` e `docs/PROPOSTE.md`.

## Prima dei dati veri

Promemoria per la fine della Fase 1A, non domande aperte (scelta dell'utente del 2026-10-15): non compaiono nella pagina "Sviluppo di Arianna".

- **Password vere del database:** passi in `SECURITY.md`, sezione Servizi locali e database (`\password` di psql, poi `pnpm db:migrate` e `pnpm arianna:doctor`).
- **Chiave age vera:** la genera l'utente con i passi di `SECURITY.md`, sezione Vault, e la conserva anche fuori dal Mac (D-042). Il vault esiste già dal 2026-10-23 (chiave VAPID delle notifiche push).
- **Backup cifrato** (D-096), ultimo lavoro prima dei dati veri.
- **Verifica del profilo di Claude Code nelle incognite di lavoro** (D-136 tappa 3): si fa insieme in una sessione apposta, con l'utente che autorizza la lettura del solo elenco dei file del profilo di `claude` prima e dopo un'incognita di lavoro; il risultato va nella scheda di chiusura dell'incognita.

## Su una macchina nuova

Passa da git solo ciò che è nel repository: non passano `node_modules`, `data/`, `config/arianna.toml`, la cronologia delle conversazioni e i permessi approvati a mano in Claude Code.

1. Branch giusto (`main` o quello del task in corso); prerequisiti `node -v` (22.18 o più), `pnpm -v`, `docker info`, `git config user.name`: ciò che manca lo installa l'utente.
2. `pnpm install` (attiva l'hook: `git config core.hooksPath` deve dare `.githooks`), poi `pnpm arianna:init --defaults` se manca `config/arianna.toml`.
3. `pnpm check` deve passare prima di toccare qualsiasi cosa; se fallisce su una macchina nuova è un problema di portabilità da capire, non da aggirare.
4. Una macchina alla volta: push prima di lasciarla, pull appena arrivati; la cartella non va sincronizzata anche con Synology Drive o simili.
5. `claude --version` e login dell'abbonamento li fa l'utente; con una versione diversa da quella verificata, prima `pnpm eval:live` (consuma quota: chiedere). `[cloud] executors` è vuoto dopo `--defaults`: abilitare `claude` è un'impostazione di privacy, solo con la conferma esplicita dell'utente.
6. La sandbox legge `bin` e `lib` dell'installazione di Node che esegue il core: Node sotto una radice utente intera fa rifiutare `createClaudeExecutor`; va bene un prefisso dedicato (Homebrew, nvm, `~/.local/...`).

## Modo di lavorare concordato

Le regole stanno in `CLAUDE.md`; qui solo ciò che non c'è.

- **Parlare chiaro all'utente** (richiesta del 2026-10-11): niente gergo interno; i termini inglesi dell'interfaccia quando aiutano (select, label, badge, pulsante) e cosa cambia in pratica, per esempio «label di privacy: Pubblico, Interno, Privato, Segreto; abbassarla vuol dire meno protezione».
- **Push:** Claude fa `git push origin main --follow-tags` dopo ogni unione su `main` (richiesta del 2026-10-14), mai rami in prova; `.claude/settings.json` permette ogni `git push` e nega i forzati (`--force`, `-f`, refspec con `+`, scelta dell'utente del 2026-10-22). L'utente fa le azioni fuori dalla cartella.
- **Conferme:** domande singole con le opzioni, ognuna con cosa fa oggi il sistema, cosa cambierebbe, dove lo si vede e perché Claude consiglia così; niente sigle senza spiegazione.
- Ore «reali» nei task: tempo della sessione di Claude, non ore di lavoro dell'utente.
- **Comandi lunghi senza l'utente:** il Mac va in stop di notte; si lanciano con `caffeinate -i` (il 2026-10-24 un `pnpm check` fermo 16 minuti è fallito per tempo scaduto).

## Cose non ovvie imparate finora

Solo quelle che servono a ogni sessione; le note su un pezzo di codice preciso (postgres.js, SQL, TypeScript, voce, test) sono in `docs/NOTE-TECNICHE.md`.

- **Nuova conversazione: `/exit` e di nuovo `claude`, non `/clear`** (scelta dell'utente del 2026-10-23): Claude Code blocca i worktree dei subagenti finché resta aperto il processo che li ha creati; con `/clear` il processo resta lo stesso e i worktree non si possono togliere.
- **Il telefono usa la chat compilata** (`apps/hud/dist`, servita dal core sulla porta remota), non quella di `pnpm hud:dev`: dopo ogni modifica alla chat da provare sull'iPhone va lanciato `pnpm hud:build` (il 2026-10-23 il telefono aveva ancora il service worker di prima di D-295). L'utente poi apre l'app una volta perché il service worker nuovo prenda il posto.
- **Vault:** Claude non lancia `sops` né altri comandi che aprono il vault, nemmeno per diagnosi con l'uscita buttata via (l'utente se n'è giustamente lamentato il 2026-10-23). Per sapere se il core lo apre basta il log (`VaultError (decrypt-failed)`, «Web Push on/off»); i passi del vault li fa l'utente.
- **Notifiche push:** «nessun errore» nel log vuol dire anche che Apple ha accettato (2xx), dalla 0.173.0; la prova di notifica dall'app sul telefono la crea il telefono stesso e non dice nulla del percorso Mac → Apple → telefono. Il core spedisce solo quando nessuna pagina della chat è in vista, Mac compreso.
- **`pnpm test:db` in un worktree:** serve `config/arianna.toml` (`pnpm arianna:init --defaults`), ma i default lasciano `[roles]` vuoto e diversi test di `test-db` leggono la configurazione vera: senza un modello locale nei ruoli le deleghe locali finiscono in `wait-user` e i test falliscono. Mettere almeno `orchestrator` ed `extractor` nel `[roles]` del worktree. Con più `test:db` in parallelo il cluster finisce le connessioni («remaining connection slots…»): lanciarli uno alla volta.
- **L'hook che blocca i percorsi fuori dal repository legge anche il testo dei comandi:** un `../` (import relativi nei sorgenti) o un `~` seguito da altro testo dentro un comando Bash o in un file scritto fuori dal repository viene bloccato. Per modifiche via script: scrivere lo script con Write in `data/test-tmp/` (fuori da git) ed eseguirlo con `python3 data/test-tmp/<file>.py`; per gli import usare Edit.
- **Test instabili sotto carico:** il test di tempi del Markdown (soglia portata a 1500 ms, parser lineare) e una volta un test del `Watchdog` ("ends in failed when an adopted server hangs", rimasto appeso nel pre-commit, poi passato 3 volte su 3 da solo): se il pre-commit si blocca, fermare i processi `node --test` e riprovare.
- **L'hook blocca ogni lettura e scrittura fuori dal repository**, compresa la cartella di memoria di Claude Code e la cartella temporanea della sessione. Per questo la memoria del progetto sta in `CLAUDE.md` e in questo file, e i file temporanei vanno in `data/` (ignorata da git).
- L'hook controlla anche il testo dei comandi Bash: un comando che contiene un percorso della home come stringa di prova viene bloccato.
- Con D-059 l'hook lascia nominare le cartelle di `read-allow.local` in Bash solo in comandi di lettura; il controllo divide il comando anche sui `|` dentro le virgolette, quindi `grep -E 'a|b'` viene bloccato: usare `grep -e a -e b` o lo strumento Read.
- L'hook risolve i percorsi relativi che compaiono nel testo di un comando Bash a partire dalla home, non dalla cartella corrente: uno script o un heredoc che li contiene (anche solo una stringa `..` in un test) viene bloccato. Meglio scrivere il file con lo strumento di scrittura o di modifica.
- L'hook legge come home anche una tilde nel testo di un comando Bash: l'operatore regex di SQL dentro uno script viene bloccato, e così una nota che lo cita. SQL e documenti che lo contengono si modificano con lo strumento di edit.
- Un processo lanciato da Claude con Bash (per esempio `pnpm start`) gira nella sandbox: dal terminale risponde, ma il Chrome dell'utente non lo raggiunge. `curl` è negato: per provare l'API si usa `node:http`. Lanciato fuori dalla sandbox (con il permesso dell'utente) il Chrome dell'utente lo raggiunge: provato il 2026-10-02, la chat si apre.
- Una migrazione applicata al database di sviluppo da `pnpm start` non si può più modificare (sha256 in `schema_migrations`): le migrazioni non committate vanno finite prima di avviare il core.

## Prompt per la nuova conversazione

Leggi CLAUDE.md, docs/HANDOFF.md e data/dev/RISPOSTE.md se esiste. Leggi la quota e controlla db, core e chat (guarda la porta 7420 prima di avviare il core; se Docker è spento chiedimi di aprirlo). Riprendi da «Stato (2026-10-24, notte)» in HANDOFF: main è alla 0.182.0, pushata coi tag, e la cartella principale è sul ramo prova/mac-azioni. Fammi le domande di prova dei tre rami pronti, una per ramo e nell'ordine (azioni sul Mac, ricerca ibrida, memoria passo c); con «Funziona» uniscili a main uno alla volta con versione, tag e push, rimettendo main dentro il ramo successivo prima di unirlo. Scrivi sempre e solo in italiano, anche le righe brevi mentre lavori e il testo delle domande, con esempi pratici e parole semplici; quando fai qualcosa dimmi in una riga cosa stai facendo e perché. I comandi git nella cartella principale lanciali da soli, senza «cd … &&» davanti; il push di main coi tag lo fai tu. Lavori indipendenti in parallelo con subagenti, un solo agente per ramo; quando ti chiedo «Testalo tu» prova tu con la chat in Chrome; non approvare mai lavori sopra cartelle fuori dal repository e non toccare mai il vault né le mie chiavi.
