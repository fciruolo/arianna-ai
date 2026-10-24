# Consegna fra conversazioni

Questo file dice a una nuova sessione di Claude Code da dove riprendere: **solo lo stato attuale**, corto. Si aggiorna a fine task e ogni volta che si propone di aprire una conversazione nuova (regola in `CLAUDE.md`). Contiene solo ciò che non si ricava da git e dagli altri documenti. La storia delle consegne precedenti (fino al 2026-10-13 sera) sta in `docs/HANDOFF-STORIA.md`: non si legge a inizio sessione, ci si cerca con `grep` quando serve un dettaglio passato. Quando un paragrafo di stato diventa storia, si sposta in fondo a `HANDOFF-STORIA.md` invece di accumularsi qui; la riga «Aggiornato» tiene solo l'ultima data.

Aggiornato: 2026-10-24, pomeriggio.

**Stato (2026-10-24, pomeriggio).** `main` alla **0.180.0**, pushato coi tag; cartella principale su `main`. **Core fermo** e Docker spento alla fine della sessione (l'utente stava abbassando la memoria di Docker): a inizio sessione, se Docker è su, `pnpm db:up` e `pnpm start`; se è spento, chiedere all'utente. La chat (`pnpm hud:dev`) era accesa. Il database di sviluppo è sull'immagine con pgvector (D-308), copia di prima in `data/backups/arianna-prima-di-pgvector.dump`.
- **Fase 1A chiusa** (D-309): P7 è il primo passo di «Prima dei dati veri». Fase 2 in corso.
- **Unite il 2026-10-24:** 0.174.1 D-306 Registro del gateway; 0.175.0 D-307 casi della prova delle memorie (`pnpm eval:memory`); 0.176.0 D-308 pgvector; 0.176.1 D-312 Impostazioni divise in Aspetto e Installazione; 0.176.2 D-311 data e ora al secondo per il modello locale; 0.177.0 D-315 finestra quando una festa cambia il tema (Halloween dal 2026-10-25, risposta di prova azzerata); 0.178.0 D-313 milestone per progetto nel cardwall; 0.179.0 D-316 modello caldo all'avvio e scaricato dopo 30 minuti; 0.180.0 D-314 strumenti del Mac in sola lettura (I-22 M1, permesso a tre scelte, «Sempre» solo dal Mac) e riscaldamento anche del Lavoro.
- **Primo lavoro piccolo da fare:** in D-314 la risposta di sola lettura del modello nomina gli strumenti («ho solo mac.read, mac.info e mac.list»): la descrizione degli strumenti `mac.*` deve dire di non nominarli e rispondere con parole semplici (scelta dell'utente: «Unisci, ritocco nella sessione nuova»). Va anche lanciato `pnpm eval:models` per il caso nuovo `orch-mac-change-is-read-only` (consuma tempo del modello locale, non quota).
- **Prima risposta lenta del modello locale (indagine fatta):** macOS comprime e manda in swap i buffer della GPU dove stanno i pesi del 35B (vmmap: 12,2 GB swappati 3 minuti dopo l'ultima domanda) perché il Mac è oltre i 32 GB (oMLX 19 GB, VM di Docker 8 GB con anche i container di invirtuolabs, Chrome, agenti). Il tempo perso è fra «Prefix cache restore» e «Reserved prefill capacity» nel log di oMLX (27-137 s). oMLX bloccherebbe i pesi solo con `sudo sysctl iogpu.wired_limit_mb=…`: l'utente **non vuole** bloccare la RAM. Sua scelta: spegnere i container che non usa e abbassare la memoria di Docker a 4 GB, poi rimisurare la prima risposta. Se non basta: orchestratore più piccolo con `pnpm eval:models --model`.
- **Core caduto su un riavvio del database:** al riavvio di Docker il core è morto con `TypeError: Cannot read properties of null (reading 'write')` in `postgres@3.4.9` `connection.js:255` dopo `CONNECTION_CLOSED`: da guardare (il core dovrebbe resistere a un riavvio di PostgreSQL o almeno chiudersi in modo pulito).
- **Decise e non partite:** fatture FatturaPA (D-310, `fast-xml-parser`); seguiti di D-313 (strumento della chat per creare milestone con approvazione, `/progetta` diviso in milestone, nome accessibile della casella «Bloccata da» che oggi è l'id); I-22 M2 (azioni con scheda «frase più comando», Cestino mai cancellazione definitiva), M3 (Annulla e registro), M4 (Comandi Rapidi scelti dall'utente); terminale da decidere dopo M1-M3. Passi (c) e (d) del confronto delle memorie (giudice Claude via gateway solo sui casi L0).
- **Lavoro in parallelo:** l'utente ha scelto «massimo parallelo» anche durante le prove, sapendo che il modello locale sarà più lento. Prove «Testalo tu» in Chrome: mai approvare schede su cartelle fuori dal repository (le prove di D-314 le fa l'utente su una cartella con file inventati, oggi `Documenti/Test/progetto-arianna`).
- **Pulizia:** dopo `/exit` togliere i worktree dei subagenti di oggi (`git worktree list`, `.claude/worktrees/agent-*`, tutti già in main) con `git worktree remove` e i rami `task/d306…`/`task/d316…`, `task/i22-strumenti-mac` con `git branch -d` (i rami `worktree-agent-*` creati dallo strumento si tolgono con loro). Resta `task/d261-codex-mcp` (Codex fermo). Nei worktree restano solo file fuori da git (database di prova già spenti).
- **Il Mac va in stop di notte:** per comandi lunghi senza l'utente usare `caffeinate -i`.

## Dove siamo

- **Fase 0 chiusa** (2026-10-02). **Fase 1A chiusa** (2026-10-24, D-309; P7 aspetta i dati veri). **Fase 2 in corso**, con i task di 1B in parallelo; molti task di 1B sono già su `main`. Stato dei task in `docs/PHASE-0-1-TASKS.md`, scelte in `docs/DECISIONS.md`, versioni in `CHANGELOG.md`, storia in `docs/HANDOFF-STORIA.md`.
- Macchina di lavoro: Mac Studio con 32 GB; oMLX lo avvia il core (D-071), orchestratore `qwen3.8-35b-a3b-distill-mlx-4bit` (D-201). Col 35B caricato lo swap arriva a 6-9 GB (sul Mac girano anche una ventina di container Docker di altri progetti; il doctor segnala `models.ram`): se la pressione della memoria resta alta, valutare con l'utente il 9B per la voce o meno servizi accesi.
- **Note per dopo:** il clone di GOD `repos/arianna/main` è fermo a una versione vecchia (`pnpm god:clone` lo aggiorna). Prima di condividere il repository vanno tolti personaggi e luoghi delle serie anche dalla storia di git (elenco in `apps/hud/characters/serie/LEGGIMI.md`).

## Prossimi passi, in ordine

1. Avvio dei servizi (Docker deve essere acceso dall'utente), pulizia dei worktree, poi il ritocco di D-314 (nomi degli strumenti) con `pnpm eval:models` del caso nuovo.
2. Rimisurare la prima risposta del modello locale dopo aver abbassato Docker; se resta lenta, domanda all'utente sul modello più piccolo. Guardare il crollo del core al riavvio del database.
3. Fase 2: passi (c) e (d) di `MEMORIA-CONFRONTO.md`, fatture FatturaPA (D-310), seguiti di D-313, I-22 M2-M4; D-096 backup cifrato per ultimo, prima dei dati veri.
4. Il resto in sospeso sta in `docs/OPEN-QUESTIONS.md` e in `docs/PROPOSTE.md`.

Come si porta un lavoro di un subagente fino a `main`: `reviewer` sul suo ramo, correzioni, `pnpm check` (e `pnpm test:db` se tocca il database), un ramo `prova/…` con `main` dentro su cui spostare la cartella principale, riavvio di core e chat, una domanda a opzioni per lavoro; con «Funziona» unione su `main` con versione, CHANGELOG, tag e push, ritorno su `main`. Le migrazioni di un ramo vanno finite prima di avviare il core su quel ramo (una migrazione applicata non si cambia più).

## In attesa dell'utente

Niente oltre alle domande dei «Prossimi passi». Le domande aperte stanno in `docs/OPEN-QUESTIONS.md` e `docs/PROPOSTE.md`.

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

Leggi CLAUDE.md, docs/HANDOFF.md e data/dev/RISPOSTE.md se esiste. Leggi la quota e controlla db, core e chat (guarda la porta 7420 prima di avviare il core; se Docker è spento chiedimi di aprirlo). Riprendi da «Stato (2026-10-24, pomeriggio)» in HANDOFF: main è alla 0.180.0 (D-306…D-316), pushata coi tag. Togli i worktree dei subagenti di ieri e i loro rami (già in main, elenco in HANDOFF). Poi fai il ritocco di D-314 (la risposta di sola lettura non deve nominare gli strumenti) con l'eval del modello, rimisura la prima risposta del modello locale (ho abbassato la memoria di Docker) e guarda perché il core è caduto al riavvio del database; poi chiedimi con le domande a opzioni come proseguire la Fase 2. Scrivi sempre e solo in italiano, anche le righe brevi mentre lavori, con esempi pratici e parole semplici; quando fai qualcosa dimmi in una riga cosa stai facendo e perché. I comandi git nella cartella principale lanciali da soli, senza «cd … &&» davanti; il push di main coi tag lo fai tu. Lavori indipendenti in parallelo con subagenti, un solo agente per ramo; quando ti chiedo «Testalo tu» prova tu con la chat in Chrome; non approvare mai lavori sopra cartelle fuori dal repository e non toccare mai il vault né le mie chiavi.
