# Consegna fra conversazioni

Questo file dice a una nuova sessione di Claude Code da dove riprendere: **solo lo stato attuale**, corto. Si aggiorna a fine task e ogni volta che si propone di aprire una conversazione nuova (regola in `CLAUDE.md`). Contiene solo ciò che non si ricava da git e dagli altri documenti. La storia delle consegne precedenti (fino al 2026-10-13 sera) sta in `docs/HANDOFF-STORIA.md`: non si legge a inizio sessione, ci si cerca con `grep` quando serve un dettaglio passato. Quando un paragrafo di stato diventa storia, si sposta in fondo a `HANDOFF-STORIA.md` invece di accumularsi qui; la riga «Aggiornato» tiene solo l'ultima data.

Aggiornato: 2026-10-24, sera tardi.

**Stato (2026-10-24, sera tardi).** `main` alla **0.180.5**, pushato coi tag; cartella principale su `main`. Core (avviato dal ramo di prova dei testi, stesso codice di `main` salvo la versione), chat e database accesi; Docker a 5 GB.
- **Unite oggi pomeriggio e sera:** 0.180.1 D-314 la risposta di sola lettura non nomina gli strumenti (eval con `noToolNames`); 0.180.2 D-317 patch di postgres.js (`patches/postgres@3.4.9.patch`), il core regge la caduta della connessione in una transazione; 0.180.3 testi della chat, 0.180.4 testi delle Impostazioni, 0.180.5 frasi fisse del core (un solo commit di versione con tre tag). Le frasi del core e l'avviso dei messaggi lunghi li coprono i test, non una prova a schermo; resta una scritta nascosta «orchestratrice · modello locale» in Impostazioni → Modelli e qualche «orchestratore»/«core» fuori dalle Impostazioni (`lib/im.ts:419`, `lib/italian.ts`, `DraftChat.vue:132`, `models-page.ts:408`, `browser-screen.ts:183`).
- **Rami finiti dai subagenti, da portare a `main` uno alla volta** (ciascuno ha già avuto il suo `reviewer` e `pnpm check`; `test:db` completo spesso rosso solo per connessioni finite, con i file toccati verdi; serve una domanda di prova per ramo):
  - `task/d310-fatturapa` (commit 0ed00ac7): Finanze → «Fatture e scadenze», import di `.xml`/`.xml.p7m` (fast-xml-parser 5.11.2: porta 7 dipendenze MIT, D-310 corretta), scadenziario, 4 fatture finte in `kb/private/finanze/fatture/` (scadenze 31/10, 15/11, 30/11, 15/12/2026). Scelte prudenti da confermare in prova, scritte in D-310.
  - `task/d313-seguiti` (1de7af5b, bd9268a6, 94768f49): `milestone.propose` dalla chat con scheda «Crea la milestone»/«Non ora», nome accessibile di «Bloccata da». Eval da lanciare: `orch-milestone-propose-with-cards`, `orch-milestone-propose-due`, `orch-milestone-not-for-a-card`. `/progetta` diviso in milestone: va deciso con l'utente (come dividere le card).
  - `task/i22-m2-azioni-mac` (90205d80, D-320): creare cartelle e file di testo, modificare, spostare, copiare, Cestino (`/usr/bin/trash`), ogni modifica con scheda «Sì, fallo»; dal telefono solo «No». Conflitto atteso con D-314 sulla descrizione di `mac.list` in `protocol.ts` e sul caso `orch-mac-change-is-read-only` (sostituito da `orch-mac-change-reads-first`): tenere il divieto dei nomi e `noToolNames`. Eval da lanciare: i 7 casi `orch-mac-*` nuovi. Prova dell'utente su `Documenti/Test/progetto-arianna`.
  - `task/proposta-ricerca-ibrida` (6dd7af04…6c4060b9, D-318, I-23): tabelle dei pezzi condivisibile/privata, client `/v1/embeddings`, RRF, regola in `packages/policy`, eval `retrieval` (40 pagine, 30 domande). Mancano: voci del catalogo dei due modelli (sha256 veri, serve una sessione con la rete), provino, lavoratore della coda e sincronizzazione all'avvio, Cerca nella chat, `kb.search`/`kb_search` sul nuovo indice, riordinatore.
  - `task/memoria-passo-c` (9e9e4f0f): candidata `ours` di `pnpm eval:memory`, database di prova a parte (`packages/evals/memlab/compose.yaml`, porta 54340). **Ha scritto la sua decisione come D-317, che è già la patch di postgres.js: rinumerarla (D-319) all'unione**; aggiunge `postgres` 3.4.9 a `packages/evals` (stessa versione, la patch vale anche lì). Prova vera: `caffeinate -i pnpm eval:memory --candidate ours` a Mac libero.
  - **Migrazioni:** quattro rami hanno una `0095_*` (fatturapa, milestone_proposals, mac_changes, retrieval): all'unione rinumerare 0095-0098 nell'ordine in cui entrano, prima di avviare il core sul ramo.
- **Test instabili sotto carico visti oggi:** `packages/evals/test/memory.test.ts` («passes every privacy check…», una volta ha trovato «4417» nel rapporto, forse un tempo in ms), `canary.test.ts` (file `arianna-canary-*` lasciati da altri worktree nella tmp), timeout del doctor in `apps/core/test-db/pgvector.test.ts`, `roles`, un deadlock in `message-queue`. Da soli passano.
- **Catalogo dei modelli:** l'orchestratore della cartella principale (`qwen3.8-35b-a3b-distill-mlx-4bit`) non è nel `config/models.catalog.yaml` di `main`: nei worktree i subagenti hanno dovuto usare `qwen3.8-27b-4bit`. Da capire (catalogo locale dell'utente?) e, se serve, aggiungerlo.
- **I-23 ricerca ibrida, scelte dell'utente (D-318):** provino EmbeddingGemma 2 contro BGE-M3, indice di KB, note e conversazioni, un elenco per pertinenza con «per significato», riordinatore solo se migliora, Claude e Codex sul solo indice condivisibile.
- **Passo (d) delle memorie (scelta dell'utente):** un giro solo del giudice Claude con tetto di circa 60 chiamate, fermo sopra il 90% della quota settimanale (scritto in `MEMORIA-CONFRONTO.md` sul ramo `task/memoria-passo-c`).
- **Prima risposta del modello locale:** 36 s con Docker a 8 GB (33 s per riprendere i pesi dallo swap), le risposte successive 2 s; la misura con Docker a 5 GB (96 s) è sporcata dal carico: rifarla a Mac tranquillo, modello fermo 10 minuti, con `pnpm eval:models --tag mac` e il log di oMLX. I container di invirtuolabs ripartono da soli a ogni avvio di Docker: li ferma l'utente.
- **Decise e non partite:** I-22 M3 (Annulla e registro), M4; terminale dopo M1-M3; D-096 backup cifrato per ultimo.
- **Prove «Testalo tu» in Chrome:** mai approvare schede su cartelle fuori dal repository; su una scheda di permesso del Mac si sceglie «No». In una conversazione di Lavoro su «automatico (router)» un messaggio lungo parte senza conferma: per provare l'avviso scegliere Claude come destinatario.
- **Pulizia dopo `/exit`:** `git worktree list`: togliere i worktree già uniti (D-314, D-317, testi chat, Impostazioni e core, proposta di ricerca se unita) e i loro rami (`task/d317-postgres-chiusura`, `task/testi-*`, `prova/d314-d317` con `git branch -D`, `worktree-agent-*`); restano quelli dei cinque rami sopra finché non sono uniti. In `.claude/worktrees/` ci sono anche una settantina di cartelle vecchie non registrate in git: chiedere all'utente. Resta `task/d261-codex-mcp` (Codex fermo).
- **Il Mac va in stop di notte:** per comandi lunghi senza l'utente usare `caffeinate -i`.

## Dove siamo

- **Fase 0 chiusa** (2026-10-02). **Fase 1A chiusa** (2026-10-24, D-309; P7 aspetta i dati veri). **Fase 2 in corso**, con i task di 1B in parallelo; molti task di 1B sono già su `main`. Stato dei task in `docs/PHASE-0-1-TASKS.md`, scelte in `docs/DECISIONS.md`, versioni in `CHANGELOG.md`, storia in `docs/HANDOFF-STORIA.md`.
- Macchina di lavoro: Mac Studio con 32 GB; oMLX lo avvia il core (D-071), orchestratore `qwen3.8-35b-a3b-distill-mlx-4bit` (D-201). Col 35B caricato lo swap arriva a 6-9 GB (sul Mac girano anche una ventina di container Docker di altri progetti; il doctor segnala `models.ram`): se la pressione della memoria resta alta, valutare con l'utente il 9B per la voce o meno servizi accesi.
- **Note per dopo:** il clone di GOD `repos/arianna/main` è fermo a una versione vecchia (`pnpm god:clone` lo aggiorna). Prima di condividere il repository vanno tolti personaggi e luoghi delle serie anche dalla storia di git (elenco in `apps/hud/characters/serie/LEGGIMI.md`).

## Prossimi passi, in ordine

1. Avvio dei servizi, pulizia dopo `/exit`.
2. Portare a `main` i cinque rami dei subagenti, uno alla volta (ordine consigliato: fatture, milestone, I-22 M2, ricerca ibrida, memoria passo c), rinumerando migrazioni e decisioni; `pnpm eval:models` sui casi nuovi di milestone e I-22 M2; una domanda di prova per ramo.
3. Rimisurare la prima risposta del modello locale a Mac tranquillo.
4. I-23: voci del catalogo con la rete, provino dei due modelli, collegamenti nel core e in Cerca. Poi passo (d) delle memorie, I-22 M3; D-096 per ultimo.

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

Leggi CLAUDE.md, docs/HANDOFF.md e data/dev/RISPOSTE.md se esiste. Leggi la quota e controlla db, core e chat (guarda la porta 7420 prima di avviare il core; se Docker è spento chiedimi di aprirlo). Riprendi da «Stato (2026-10-24, sera tardi)» in HANDOFF: main è alla 0.180.5, pushata coi tag. Fai la pulizia dei worktree già uniti (elenco in HANDOFF; per le cartelle vecchie non registrate chiedimi). Poi porta a main i cinque rami finiti dai subagenti (fatture FatturaPA, milestone dalla chat, I-22 M2 azioni sul Mac, ricerca ibrida I-23, memoria passo c) uno alla volta, rinumerando migrazioni 0095 e decisioni come dice HANDOFF: reviewer se serve, check, eval del modello dei casi nuovi, prova, una domanda a opzioni per lavoro. Rimisura la prima risposta del modello locale a Mac tranquillo. Scrivi sempre e solo in italiano, anche le righe brevi mentre lavori, con esempi pratici e parole semplici; quando fai qualcosa dimmi in una riga cosa stai facendo e perché. I comandi git nella cartella principale lanciali da soli, senza «cd … &&» davanti; il push di main coi tag lo fai tu. Lavori indipendenti in parallelo con subagenti, un solo agente per ramo; quando ti chiedo «Testalo tu» prova tu con la chat in Chrome; non approvare mai lavori sopra cartelle fuori dal repository e non toccare mai il vault né le mie chiavi.
