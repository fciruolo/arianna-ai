# Consegna fra conversazioni

Questo file dice a una nuova sessione di Claude Code da dove riprendere: **solo lo stato attuale**, corto. Si aggiorna a fine task e ogni volta che si propone di aprire una conversazione nuova (regola in `CLAUDE.md`). Contiene solo ciò che non si ricava da git e dagli altri documenti. La storia delle consegne precedenti (fino al 2026-10-13 sera) sta in `docs/HANDOFF-STORIA.md`: non si legge a inizio sessione, ci si cerca con `grep` quando serve un dettaglio passato. Quando un paragrafo di stato diventa storia, si sposta in fondo a `HANDOFF-STORIA.md` invece di accumularsi qui; la riga «Aggiornato» tiene solo l'ultima data.

Aggiornato: 2026-10-14, 12:30 circa.

**2026-10-14, 12:30 circa — stato.** `main` è alla **0.99.0**: galleria dei personaggi nella scheda Aspetto della pagina Agenti e download dei personaggi di pixel-agents (D-206), provata da Claude su richiesta dell'utente («testa tu»): download vero riuscito (6 personaggi e licenza in `data/characters/pixel-agents`), clic che assegna e annullato senza salvare. Core su `main`. **Push da fare dall'utente** (a Claude è ancora negato): sul remoto `main` era alla 0.98.0 senza nessun tag; serve `! git push origin main --follow-tags` e `! git push origin --tags` (mancano v0.89.4…v0.99.0). Verifica di oMLX **rimandata dall'utente** (il codice installato sta in `~/.omlx`, che l'hook non lascia leggere: serve un clone di `jundot/omlx` alla v0.6.3rc2 in `Sites` aggiunto a `read-allow.local` dall'utente); resta da fare prima dei dati veri. **Advisor nel router (D-207) accettato** con le scelte dell'utente (testo solo L0/L1, 50 pareri al giorno, spento oltre il 90% della settimana), da costruire su `task/advisor-router`; la percentuale la legge dal file dell'app della barra dei consumi, percorso indicato dall'utente in Impostazioni (D-207). **Prossimo passo: costruirlo**, su un ramo, in una conversazione nuova.

**2026-10-14, 11:30 circa — stato precedente.** `main` è alla **0.98.0**; core e chat accesi, cartella principale su `main`. **Push da fare dall'utente** (a Claude il permesso è ancora negato): `! git push origin main --follow-tags`; sul remoto c'è `main` 0.95.0 e nessun tag (mancano v0.89.4…v0.98.0). Uniti stamattina, provati da Claude su richiesta dell'utente («testa tu»): **0.97.0** «Progetti seguiti» in una scheda sua nella pagina Sviluppo (schede «Domande» e «Progetti seguiti», `?scheda=progetti` resta anche ricaricando e con «indietro»: `openSettings` in `App.vue` tiene la query se la sezione non cambia); **0.98.0** rapporti di Claude e Codex in italiano (D-205: testo fisso `REPORT_LANGUAGE_TEXT` nell'apertura del brief in `delegate.ts`, «in italiano salvo che l'utente scriva in un'altra lingua»; nessun cambio a `packages/executors`, quindi niente `eval:live`; prova vera sul progetto `demo`: rapporto in italiano con `pnpm sito` e `index.html` intatti; per farla Claude ha approvato, su permesso dell'utente, la card «Cartella con modifiche» di `repos/demo`). `test:db` completo: 689/691, falliti `orchestrator.test.ts` (persona in conversazione privata) e il test «cosa ho domani?» del Segretario, che leggono la configurazione vera dell'installazione: da guardare a parte con i 18 errori delle deleghe locali notati su Rizzo. **Quota:** settimana al 54% alle 11:30, proiezione circa 99%: lavoro ridotto fino al reset di sabato 17 alle 16:00.

**Risposte dell'utente di stamattina** (già nei documenti): 18 idee decise una per una (D-204), Mentor alla Fase 5, operatore telefonico in Fase 4, permessi lasciati come sono (push all'utente), domanda di Rizzo chiusa.

**Coda dei lavori, in ordine:** 5 advisor nel router (D-207, accettato); 4 verifica di oMLX (rimandata, prima dei dati veri); 6 D-113 tappa 2, regola del gateway con Rizzo (uscite ferme se il guard non risponde, blocco solo sui tipi che identificano, nomi dell'assistente ignorati), poi via veloce B1; 7 temi D-103 (serie, poi Base e feste); 8 D-111 tappa B («+ Nuovo»); 9 D-107 parte B (chat con più agenti); 10 profilo nel prompt (D-114 B-D); 11 idee di OpenWork in coda (D-093); 12 D-096 backup per ultimo, prima dei dati veri. Il confronto delle memorie (D-204, idea 13) va prima del task memoria della Fase 2. **Ritocchi notati da Claude, da proporre:** la descrizione di Arianna nella scheda Agenti è in inglese («Plans, assigns and reports; the user's main contact»).

## Dove siamo

- **Fase 0 chiusa** (2026-10-02). **Fase 1A in corso**: il criterio di uscita di `docs/ROADMAP.md` non è ancora stato superato dall'utente. Quasi tutti i task di 1A e molti di 1B sono su `main`; per lo stato dei singoli task vale `docs/PHASE-0-1-TASKS.md`, per le scelte `docs/DECISIONS.md`, per la storia `docs/HANDOFF-STORIA.md`.
- `main` è alla 0.98.0 (rapporti in italiano, D-205). Versioni e novità in `CHANGELOG.md`.
- `pnpm check` passa. `pnpm test:db` il 13 sera: 657 test, l'unico fallito `telegram.test.ts` per timeout sotto carico (passa da solo).
- Macchina di lavoro: Mac Studio con 32 GB; oMLX lo avvia il core (D-071), orchestratore `qwen3.8-35b-a3b-distill-mlx-4bit` dal 2026-10-14 (D-201; prima il 9B). Disco: 21 GiB liberi il 14 notte (tolti dal disco l'uncensored e il 27B, che restano nel catalogo e nel Confronto; cache SSD di oMLX abbassata da 10 a 4 GB in `arianna.toml`, scelta dell'utente). **Memoria:** col 35B caricato lo swap è arrivato a 9 GB su 10 (sul Mac girano anche una ventina di container Docker di altri progetti): da guardare la pressione della memoria; se resta alta, valutare con l'utente il 9B per la voce o meno servizi accesi.

## Su una macchina nuova

Passa da git solo ciò che è nel repository. Non passano: `node_modules`, `data/`, la cronologia delle conversazioni, i permessi approvati a mano in Claude Code. Prima di riprendere:

1. Controllare di essere sul branch giusto: `main`, oppure il branch del task in corso se ce n'è uno.
2. Controllare i prerequisiti: `node -v` (22.18 o più), `pnpm -v`, `docker info`, `git config user.name`. Ciò che manca lo installa l'utente.
3. `pnpm install`: scarica le dipendenze e attiva l'hook git pre-commit. Verificare con `git config core.hooksPath`, che deve dare `.githooks`.
4. `pnpm arianna:init --defaults` se manca `config/arianna.toml` (fuori da git dal 1.18, D-048). **Attenzione al primo `git pull` dopo il 1.18 su un'altra macchina:** git cancella il vecchio `config/arianna.toml` tracciato; se era stato modificato a mano, copiarlo da parte prima del pull e rimetterlo dopo.
5. `pnpm check`: deve passare (571 test; quello del vault con i binari veri si salta se mancano `sops` e `age`: `brew install sops age`) prima di toccare qualsiasi cosa. Se fallisce su una macchina nuova è un problema di portabilità: va capito e corretto, non aggirato.
6. Si lavora su una macchina alla volta: push prima di lasciarla, pull appena arrivati sull'altra. La cartella non va sincronizzata anche con Synology Drive o simili mentre si usa git.
7. **`claude` sul Mac Studio** (dal 1.5): `claude --version` e login dell'abbonamento fatti dall'utente. Il profilo è provato con la 2.1.288: con un'altra versione, prima di usarlo, `pnpm eval:live` (contratto e canarino, circa 11 chiamate: chiedere all'utente).
8. **`[cloud] executors` non passa da git** (`config/arianna.toml` è fuori da git): dopo `pnpm arianna:init --defaults` è vuoto. Abilitare `claude` è un'impostazione di privacy: solo con la conferma esplicita dell'utente (sul MacBook l'aveva data il 2026-10-02).
9. La sandbox legge `bin` e `lib` dell'installazione di Node che esegue il core: se sul Mac Studio Node sta sotto una radice utente intera (per esempio installato direttamente in una cartella come la home), `createClaudeExecutor` rifiuta di partire; va bene un prefisso dedicato (Homebrew, nvm, `~/.local/...`). Lì vanno anche oMLX (task 1.4) e gli eval sul modello vero.

## Prossimi passi, in ordine

1. Quando un subagente finisce: `reviewer` sul suo ramo, correzioni, `pnpm check` (e `pnpm test:db` se tocca il database), poi la cartella principale va sul ramo con `git switch --detach <ramo>` (i worktree dei subagenti restano bloccati), riavvio di core e chat, prova dell'utente con una domanda a opzioni per lavoro; con «Funziona» unione fast-forward su `main`, versione minor, tag, ritorno su `main`.
2. Ordine: rapporto di sicurezza (D-196), poi confronto dei modelli (D-199). Le migrazioni di un ramo vanno finite prima di avviare il core su quel ramo (una migrazione applicata non si cambia più).
3. Le prove dei modelli veloci aspettano lo spazio su disco (vedi la coda).
4. Il resto in sospeso sta in «In attesa dell'utente» qui sotto, in `docs/OPEN-QUESTIONS.md` e in `docs/PROPOSTE.md`; i «Prossimi passi» lunghi di prima, quasi tutti storia, sono in `docs/HANDOFF-STORIA.md`.

## In attesa dell'utente

| Cosa | Note |
| --- | --- |
| Togliere a mano `data/scratch/review-d065/` | Sonde del `reviewer`, fuori da git |
| Prova dal vivo di D-058 fuori da Arianna | Comandi nei "Prossimi passi" (progetto finto creato dall'utente, wizard al passo 4, landing page chiesta al Coder in chat: consuma chiamate vere) |
| Su un'altra macchina: `pnpm arianna:init --reconfigure` | Un `config/arianna.toml` con `[cloud] allowlist` non vuota ora è rifiutato (D-058): va riscritto con i `[[project]]`. Su questa macchina l'ha convertito Claude |
| Password vere del database | Solo per l'uso vero, dopo il criterio della Fase 1A: passi in `SECURITY.md`, sezione Servizi locali e database (`\password` di psql, poi `pnpm db:migrate` e `pnpm arianna:doctor`) |
| Chiave age vera | D-042 confermata e binari provati. Per l'uso vero (solo dopo il criterio della Fase 1A) la chiave age la genera l'utente, con i passi in `SECURITY.md`, sezione Vault |

## Modo di lavorare concordato

- **Parlare chiaro all'utente** (richiesta del 2026-10-11): niente gergo interno («etichetta», «abbassare l'etichetta» non si capiscono). Usare i termini inglesi dell'interfaccia quando aiutano (select, label, badge, pulsante) e dire cosa cambia in pratica, per esempio «label di privacy: Pubblico, Interno, Privato, Segreto; abbassarla vuol dire meno protezione». Vale per le domande di prova e per i testi della chat.
- **Claude fa tutto dentro la cartella**: codice, test, commit, branch, merge fast-forward su `main`. **Push (richiesta dell'utente del 2026-10-14):** Claude fa `git push origin main --follow-tags` dopo ogni unione su `main` (mai rami in prova, mai push forzati); oggi il permesso di Claude Code lo nega: finché l'utente non lo consente, il push lo lancia l'utente con `! git push origin main --follow-tags`. L'utente fa le azioni fuori dalla cartella.
- Un branch per task (`task/<id>-<nome>`), merge fast-forward su `main`, branch cancellato.
- L'utente ha chiesto di arrivare a fine Fase 0 senza fermarsi a ogni task. A fine fase ci si ferma comunque.
- Subagent `reviewer` prima dei commit sostanziosi; per diff piccoli si può saltare, dicendolo.
- Ore "reali" nei task: è il tempo della sessione di Claude, non ore di lavoro dell'utente. Le stime in ore del piano presumevano una persona davanti allo schermo, quindi il confronto di fine Fase 0 va fatto sul tempo di calendario.
- Risposte all'utente in italiano, brevi, con lo stato vero: ciò che non è stato eseguito va detto.
- **Server sempre acceso per le prove (regola dell'utente, 2026-10-03):** a inizio sessione Claude lancia `pnpm hud:build` e `pnpm start` in background fuori dalla sandbox (così il Chrome dell'utente raggiunge `http://127.0.0.1:7420`), e lo riavvia dopo ogni modifica che l'utente deve provare. Prima di un riavvio con migrazioni nuove, le migrazioni vanno finite (vedi "Cose non ovvie").
- **Mai artefatti pubblicati (regola dell'utente, 2026-10-04):** anteprime e mockup solo come file in `docs/mockups/`, che l'utente apre in locale (`! open docs/mockups/<file>.html`). Su sua richiesta sono stati cancellati gli artefatti "Arianna HUD" e "Logo di Arianna".
- **Conferme (regola dell'utente, 2026-10-03):** quando serve una conferma, Claude fa domande singole, una alla volta, a cui l'utente risponde (strumento di domanda con opzioni), mai un elenco di cose da confermare in un riassunto. Ogni domanda dettaglia cosa l'utente sta decidendo: cosa fa oggi il sistema, cosa cambierebbe con l'altra scelta, dove lo vede (chat, file, comando), e perché Claude ha scelto così. Niente sigle senza spiegazione.

## Cose non ovvie imparate finora

- **`pnpm test:db` in un worktree:** serve `config/arianna.toml` (`pnpm arianna:init --defaults`), ma i default lasciano `[roles]` vuoto e diversi test di `test-db` leggono la configurazione vera: senza un modello locale nei ruoli le deleghe locali finiscono in `wait-user` e i test falliscono. Mettere almeno `orchestrator` ed `extractor` nel `[roles]` del worktree. Con più `test:db` in parallelo il cluster finisce le connessioni («remaining connection slots…»): lanciarli uno alla volta.

- **L'hook che blocca i percorsi fuori dal repository legge anche il testo dei comandi:** un `../` (import relativi nei sorgenti) o un `~` seguito da altro testo dentro un comando Bash o in un file scritto fuori dal repository viene bloccato. Per modifiche via script: scrivere lo script con Write in `data/test-tmp/` (fuori da git) ed eseguirlo con `python3 data/test-tmp/<file>.py`; per gli import usare Edit.
- **Voce (D-066, D-067):** Kokoro in italiano non spezza i testi lunghi: `models.py` mette una frase per riga; Qwen3-TTS CustomVoice non divide il testo: una generazione per frase (`speak_parts`). Voxtral TTS vuole `mistral-common` ≥ 1.11 (fissato 1.11.7). `pnpm voice:lock` deve passare `--exclude-newer` a mano (con `UV_NO_CONFIG=1` uv ignora `[tool.uv]`). La prova veloce dei modelli di sintesi con i pesi veri, offline: `data/scratch/tts-smoke.py` (fuori da git) con il Python di `data/voice/venv`. Pipecat logga con loguru a DEBUG (anche i testi del TTS): `__main__.py` lo porta a WARNING prima di importarlo. Un test senza browser della chiamata è in `data/test-tmp/call_smoke.py` (client aiortc).
- **Test instabili sotto carico:** il test di tempi del Markdown (soglia portata a 1500 ms, parser lineare) e una volta un test del `Watchdog` ("ends in failed when an adopted server hangs", rimasto appeso nel pre-commit, poi passato 3 volte su 3 da solo): se il pre-commit si blocca, fermare i processi `node --test` e riprovare.
- **Scheduler delle chiamate:** l'orologio iniettato (`now`) vale solo per le regole (silenzio, fine settimana, ora di una chiamata programmata); attese e conteggi usano l'ora vera come il database. La tabella `events` è solo in aggiunta: nei test non si può retrodatare un evento.
- **L'hook blocca ogni lettura e scrittura fuori dal repository**, compresa la cartella di memoria di Claude Code e la cartella temporanea della sessione. Per questo la memoria del progetto sta in `CLAUDE.md` e in questo file, e i file temporanei vanno in `data/` (ignorata da git).
- L'hook controlla anche il testo dei comandi Bash: un comando che contiene un percorso della home come stringa di prova viene bloccato.
- Con D-059 l'hook lascia nominare le cartelle di `read-allow.local` in Bash solo in comandi di lettura; il controllo divide il comando anche sui `|` dentro le virgolette, quindi `grep -E 'a|b'` viene bloccato: usare `grep -e a -e b` o lo strumento Read.
- Il `"type": "module"` della radice aveva rotto l'hook; `.claude/hooks/package.json` lo tiene in CommonJS. Se l'hook va in errore, oggi Claude Code prosegue senza blocco.
- `pnpm` applica un'età minima di un giorno alle release: se un pacchetto è troppo recente si sceglie la versione precedente, non si aggiunge un'eccezione.
- TypeScript resta alla 6.0.x finché `typescript-eslint` non supporta la 7.
- `pnpm install` attiva l'hook git solo su un'installazione vera, non quando è "Already up to date".
- postgres.js restituisce una sottoclasse di `Array`: nei confronti con `assert.deepEqual` va convertita in array semplice.
- In SQL, se la SELECT ha `id::text AS id`, `ORDER BY id` ordina sull'alias testuale: va scritto `ORDER BY tabella.id`.
- L'hook risolve i percorsi relativi che compaiono nel testo di un comando Bash a partire dalla home, non dalla cartella corrente: uno script o un heredoc che li contiene (anche solo una stringa `..` in un test) viene bloccato. Meglio scrivere il file con lo strumento di scrittura o di modifica.
- I file di `test-db` girano in parallelo sullo stesso cluster, e la migrazione `0007` cambia cose condivise da tutti gli schemi (il ruolo `arianna_app` e i permessi sull'intero database). Sul Mac Studio, più veloce, `roles.test.ts` falliva sempre: un altro file revocava il TEMP concesso dal test. Ora le migrazioni dei test e i test che toccano ruoli o permessi sull'intero database usano `withClusterLock` (`apps/core/test-db/support/database.ts`).
- In `zsh` gli script `node -e` con molte virgolette annidate falliscono: meglio modificare i file con gli strumenti di edit.
- L'hook legge come home anche una tilde nel testo di un comando Bash: l'operatore regex di SQL dentro uno script viene bloccato, e così una nota che lo cita. SQL e documenti che lo contengono si modificano con lo strumento di edit.
- In un vincolo CHECK di PostgreSQL un'espressione che vale NULL (per esempio un campo JSON mancante) fa passare la riga: va avvolta in `coalesce(..., false)`.
- Con `NODE_USE_ENV_PROXY=1` (o `--use-env-proxy`) e `HTTP_PROXY`, `fetch` e gli agent globali di Node mandano al proxy anche le richieste a 127.0.0.1: verso servizi locali si usa `node:http` con un agent proprio (`packages/executors/src/local/http.ts`).
- Un processo figlio lanciato da un test eredita `NODE_TEST_CONTEXT` e si comporta come un file di test del runner: va tolto dall'ambiente. Un figlio che usa `fetch` attraverso un proxy può non terminare da solo: `process.exit`.
- Un processo lanciato da Claude con Bash (per esempio `pnpm start`) gira nella sandbox: dal terminale risponde, ma il Chrome dell'utente non lo raggiunge. `curl` è negato: per provare l'API si usa `node:http`. Lanciato fuori dalla sandbox (con il permesso dell'utente) il Chrome dell'utente lo raggiunge: provato il 2026-10-02, la chat si apre.
- Una migrazione applicata al database di sviluppo da `pnpm start` non si può più modificare (sha256 in `schema_migrations`): le migrazioni non committate vanno finite prima di avviare il core.
- postgres.js serializza come stringa JSON una stringa passata a un parametro `::jsonb` (`'[]'` diventa `"[]"`): per i valori JSON si usa `sql.json(...)`.
- In un file di `test-db` che avvia servizi nel proprio `before` (finto Telegram, feed), il database va creato con `createTestDatabase` nello stesso hook: con `useTestDatabase` il suo `before` può non essere ancora finito.
- Il controllo dei tipi di `typescript-eslint` restringe `signal.aborted` a `false` dentro `while (!signal.aborted)`: per ricontrollarlo nel ciclo serve una funzione (`stopped()`).
- `pnpm doctor` è un comando di pnpm e ha la precedenza sugli script: per questo il nostro si chiama `arianna:doctor`.
- In una query su `pg_class` il planner può chiamare `has_sequence_privilege` prima del filtro su `relkind` (errore 42809 su una tabella TOAST): va protetto con `CASE`.
- Per provare un comando interattivo (il wizard) si usa `expect` (`/usr/bin/expect`): `script` con l'input da una pipe manda la fine dell'input prima delle risposte. Il comando con `rm -rf` può essere negato: per le prove si usa una cartella nuova sotto `data/scratch`.
- `fs.watch` su macOS può perdere le modifiche fatte subito dopo l'avvio: per la configurazione si usa `fs.watchFile`, con un confronto iniziale.
- Nella cartella del progetto (D-056) `git` lanciato dal Coder dentro la sandbox stampa errori sulla cache di `xcrun` (non può scrivere nella cartella temporanea di sistema): innocui, il comando riesce; il Coder lo ha riferito nel rapporto della prova.
- Gli strumenti di scrittura possono trasformare gli escape `\uXXXX` in caratteri veri: le espressioni regolari con caratteri invisibili vanno controllate con `od -c`.

## Prompt per la nuova conversazione

Leggi CLAUDE.md, docs/HANDOFF.md e data/dev/RISPOSTE.md se esiste. Leggi la quota e controlla db, core e chat (guarda la porta 7420 prima di avviare il core). Riprendi da «2026-10-14, 12:30» in HANDOFF: verifica se i tag sono stati spinti su GitHub (git ls-remote --tags origin), poi costruisci l'advisor nel router (D-207 in DECISIONS e in fondo a PROPOSTE) sul ramo task/advisor-router. Quota vicina al 100% in proiezione: lavoro ridotto. In italiano con esempi pratici.
