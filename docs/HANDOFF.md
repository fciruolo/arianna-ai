# Consegna fra conversazioni

Questo file dice a una nuova sessione di Claude Code da dove riprendere. Si aggiorna a fine task e ogni volta che si propone di aprire una conversazione nuova (regola in `CLAUDE.md`). Contiene solo ciò che non si ricava da git e dagli altri documenti.

Aggiornato: 2026-10-02, dopo la prima parte del task 1.6 (confinamento: allowlist, copia di lavoro, scansione preventiva).

## Dove siamo

- **Fase 0 chiusa** (via libera dell'utente il 2026-10-02). **Fase 1A in corso:** task 1.1 (policy), 1.2 (gateway, D-032) 1.3 (modello locale: `@arianna/executors` con `createLocalModel`, `Watchdog`, sezione `[[local.endpoints]]` di `arianna.toml`; D-033) 1.9 (schede agente: `@arianna/agents`, `agents/arianna.yaml` e `agents/coder.yaml`; D-034) 1.8 (motore dei task in `apps/core/src/engine.ts`, coda in `jobs.ts`, migrazione `0003_runs.sql`; D-035) su `main`. Del 1.4 sono su `main` harness e 32 casi (`evals/orchestrator/`, D-036): manca solo la corsa con il modello vero. **1.11 fatto** (D-037 `ws`, D-038 `apps/hud` in Vue/Vite/Tailwind, D-039 chat e API): `conversations`/`messages` (`0004_chat.sql`), ogni messaggio crea un task di Arianna, risposta con `openReply` (frammenti via `pg_notify`, messaggio finale dal gateway verso `channel:web`), feed in tempo reale con `LISTEN`, API `node:http` solo loopback con controlli su Host/Origin, esito di passo `declassify` approvabile dalla chat. `pnpm start` avvia il core; finché non c'è il 1.10 un messaggio porta il task in "Attende te" con il motivo. **1.7 fatto** (D-040), anticipato su scelta dell'utente perché 1.4 e 1.5 sono bloccati: `@arianna/router` con `route(step, context, budget, config)` puro, migrazione `0005_router_decisions.sql`, `recordRouteDecision` in `apps/core/src/router-log.ts`, gruppo eval `router` attivo (52 casi). **1.6, prima parte** (D-041): `[cloud] allowlist` in `arianna.toml` (vuota), `checkWorkspace` in `@arianna/policy`, `prepareWorkspace` in `@arianna/executors` (repository nuovo di un solo commit in `data/worktrees/<run>`, non un `git worktree`), casi eval `evals/gateway/workspace.jsonl`; il `workspace` di una conversazione di lavoro dev'essere in allowlist. Mancano MCP, sandbox, ambiente pulito, permessi e canarino, che richiedono `claude -p`. 1.9 e 1.8 sono stati anticipati perché 1.4 aspetta oMLX e 1.5 la verifica di `claude -p`; l'utente ha chiesto di procedere da solo mentre era lontano. Il push su `origin` lo fa l'utente.
- Dal 2026-10-02 si lavora sul Mac Studio.
- `pnpm check` passa (364 test, eval gateway 66/66 e router 52/52, `vue-tsc` compreso); `pnpm test:db` passa (106 test) con l'immagine `postgres:17.11-alpine` fissata per digest.
- Regole di etichetta in `config/labels.toml`, lette da `@arianna/config` e validate da `@arianna/policy` (D-031). `policy` resta senza dipendenze e senza I/O.
- `0001_init.sql` è su `main`: d'ora in poi ogni modifica allo schema va in una migrazione nuova.

## Su una macchina nuova

Passa da git solo ciò che è nel repository. Non passano: `node_modules`, `data/`, la cronologia delle conversazioni, i permessi approvati a mano in Claude Code. Prima di riprendere:

1. Controllare di essere sul branch giusto: `main`, oppure il branch del task in corso se ce n'è uno.
2. Controllare i prerequisiti: `node -v` (22.18 o più), `pnpm -v`, `docker info`, `git config user.name`. Ciò che manca lo installa l'utente.
3. `pnpm install`: scarica le dipendenze e attiva l'hook git pre-commit. Verificare con `git config core.hooksPath`, che deve dare `.githooks`.
4. `pnpm check`: deve passare (364 test) prima di toccare qualsiasi cosa. Se fallisce su una macchina nuova è un problema di portabilità: va capito e corretto, non aggirato.
5. Si lavora su una macchina alla volta: push prima di lasciarla, pull appena arrivati sull'altra. La cartella non va sincronizzata anche con Synology Drive o simili mentre si usa git.

## Prossimi passi, in ordine

1. **Chiudere il task 1.4** appena oMLX è installato (scelto dall'utente; il comando dal README è nell'esempio di `arianna.toml`): scrivere in `[[local.endpoints]]` i nomi dei modelli che dà `GET /v1/models`, lanciare `pnpm eval:models`, verificare che oMLX applichi davvero lo schema di risposta (D-036), annotare l'esito e, se le soglie non passano, il piano B in `DECISIONS.md`. Insieme si prova il contratto dell'adattatore sul server vero (`createLocalModel` e `Watchdog`). Con 1.4 il contratto dell'adattatore va provato anche sul server vero: finora è verificato solo sul server finto. Poi 1.5, che serve a 1.6 (confinamento) e alla convergenza di 1.7. Prima del task 1.5 bisogna sapere come viene conteggiato `claude -p` nell'abbonamento.
2. Lasciati da 1.2 e 1.3 ai task successivi: gli adattatori inviano `decision.texts`, mai una nuova serializzazione (oggi `LocalModel.chat` accetta qualsiasi stringa: valutare con 1.10 un tipo che arrivi solo da una decisione `allow`, così nessuna chiamata locale salta la riga in `gateway_log`); il core deve collegare `Watchdog.isAvailable`/`reportFailure` a `createLocalModel` e mandare gli eventi del watchdog in `events`, con il log del server in `data/` (1.8/1.10); un server adottato che si blocca senza morire porta il watchdog in `failed` (file del pid in `data/` da valutare con 1.8, D-033); il riavvio preventivo dopo molte richieste (crolli di oMLX per la cache) non c'è ancora; il registro chiuso degli strumenti (`packages/agents/src/tools.ts`) è la lista che useranno il server MCP (1.6) e l'orchestratore (1.10), che aggiungerà gli schemi degli argomenti; `repo.test` non apre lati del trifecta solo se la sandbox di 1.6 blocca la rete anche all'esecutore locale; chi crea il worker del 1.8 (1.10) passa `allowedActions` e `agentLimits` dalla scheda dell'agente del task; i costi di un run che va in errore o viene interrotto oggi non si registrano (l'esecutore non li restituisce): l'adattatore `claude -p` (1.5) dovrebbe salvarli man mano; il canale Telegram (1.15) deve controllare `approvals.label` prima di mostrare `detail`; il testo della notifica con riferimento (`next: notify-reference`) lo scrive il canale (1.15); portare il task in "Attende te" (`next: wait-user`) spetta al task 1.8; i casi eval su worktree e MCP arrivano con 1.6.
3. Lasciati dal 1.11: l'orchestratore (1.10) sostituisce `orchestratorPending` in `apps/core/src/main.ts` e risponde con `openReply` (gestire `stored: false`); decide quali agenti possono chiedere `declassify` (oggi chiunque, testo ≤ 20 000 caratteri); il trigger dei messaggi potrebbe pretendere che un messaggio `assistant` non stia sotto l'`effective_label` del suo task; il `workspace` delle conversazioni di lavoro va confrontato con l'allowlist del 1.6; accesso dal telefono via VPN con proxy e autenticazione nel 1.13; Telegram (1.15) riceve solo messaggi finali, mai frammenti. Non c'è ancora un endpoint per riprendere un task da "Attende te" (`resumeTask`) né un limite alla crescita di `pending` nel feed durante un recupero lungo.
4. Lasciati dal 1.7 al 1.10 (e al 1.5): costruire `RouterConfig` con `createRouterConfig` da `arianna.toml` (alias locali presenti in `[[local.endpoints]]`) e dai binari installati; servirà una sezione con gli alias cloud (`sonnet`, `opus`, `fable` → nome per `--model`) quando arriva l'adattatore `claude -p`; costruire `Budget` dalla contabilità dei run e dagli errori di quota (1.5 deve restituire l'ora di ritorno se il binario la dice); scrivere la decisione con `recordRouteDecision` prima di agire e trasformare `wait`/`approval: budget` in stato del task (approvazione `kind = 'budget'`, già ammessa in `approvals`); passare `attempts` con l'esito dei passi precedenti. Il router non ha ancora tipi di passo per ricerca web e voce.
5. Docker serve per `pnpm test:db`: se è spento, chiedere all'utente di avviarlo, mai farlo da soli.

## In attesa dell'utente

| Cosa | Note |
| --- | --- |
| `git push` di `main` a ogni task chiuso; cancellare il branch remoto `task/0.3-postgres` se ancora presente | Il push è negato a Claude per scelta |
| Permessi in `.claude/settings.json` | L'utente vuole che Claude lavori nella cartella senza conferme. Claude non può modificare quel file (negato come auto-modifica dei permessi): deve incollarlo l'utente. Proposta: `defaultMode: acceptEdits`; comandi di progetto in `allow`; `pnpm add/install <pkg>/update/dlx`, `git remote` e `git config --global` in `ask`; `|| exit 2` in coda al comando dell'hook, così blocca anche se va in errore. Dopo l'incolla, aggiornare `SECURITY.md` |
| Conferma delle decisioni | D-004 e da D-013 a D-029 sono "Proposta, applicata" in `DECISIONS.md`; D-030 (cartella di sviluppo separata da quella di installazione, Synology solo sui dati veri) è una proposta nata dalla domanda dell'utente sul Mac Studio |
| Server locale e modelli per il task 1.4 | Installare oMLX su questo Mac (scelto dall'utente il 2026-10-02, niente LM Studio), poi nomi esatti di `local-large` e `local-small` |
| Conferma di D-034 | In particolare: `task.delegate` non apre la comunicazione esterna per chi delega (contesto separato per task) |
| Conteggio di `claude -p` nell'abbonamento | Da verificare prima del task 1.5 |
| Scelta delle 18 idee | Raccomandazioni in `OPEN-QUESTIONS.md` |
| Prova della chat nel browser | `pnpm hud:build && pnpm start`, poi `http://127.0.0.1:7420`: creare una conversazione, scrivere, vedere il task in "Attende te". Claude non è riuscito a provarla: il core lanciato dalla sua sandbox non è raggiungibile dal Chrome dell'utente |
| Conferma di D-041 | Confinamento, prima parte: in particolare la copia di lavoro come repository nuovo senza storia invece di un `git worktree`, e l'elenco dei nomi di file di segreti |
| Conferma di D-039 | Chat e API; in particolare il messaggio di lavoro rifiutato se lo scanner trova qualcosa, e l'API senza autenticazione fino al 1.13 |

## Modo di lavorare concordato

- **Claude fa tutto dentro la cartella**: codice, test, commit, branch, merge fast-forward su `main`. L'utente fa solo il push e le azioni fuori dalla cartella.
- Un branch per task (`task/<id>-<nome>`), merge fast-forward su `main`, branch cancellato.
- L'utente ha chiesto di arrivare a fine Fase 0 senza fermarsi a ogni task. A fine fase ci si ferma comunque.
- Subagent `reviewer` prima dei commit sostanziosi; per diff piccoli si può saltare, dicendolo.
- Ore "reali" nei task: è il tempo della sessione di Claude, non ore di lavoro dell'utente. Le stime in ore del piano presumevano una persona davanti allo schermo, quindi il confronto di fine Fase 0 va fatto sul tempo di calendario.
- Risposte all'utente in italiano, brevi, con lo stato vero: ciò che non è stato eseguito va detto.

## Cose non ovvie imparate finora

- **L'hook blocca ogni lettura e scrittura fuori dal repository**, compresa la cartella di memoria di Claude Code e la cartella temporanea della sessione. Per questo la memoria del progetto sta in `CLAUDE.md` e in questo file, e i file temporanei vanno in `data/` (ignorata da git).
- L'hook controlla anche il testo dei comandi Bash: un comando che contiene un percorso della home come stringa di prova viene bloccato.
- Il `"type": "module"` della radice aveva rotto l'hook; `.claude/hooks/package.json` lo tiene in CommonJS. Se l'hook va in errore, oggi Claude Code prosegue senza blocco.
- `pnpm` applica un'età minima di un giorno alle release: se un pacchetto è troppo recente si sceglie la versione precedente, non si aggiunge un'eccezione.
- TypeScript resta alla 6.0.x finché `typescript-eslint` non supporta la 7.
- `pnpm install` attiva l'hook git solo su un'installazione vera, non quando è "Already up to date".
- postgres.js restituisce una sottoclasse di `Array`: nei confronti con `assert.deepEqual` va convertita in array semplice.
- In SQL, se la SELECT ha `id::text AS id`, `ORDER BY id` ordina sull'alias testuale: va scritto `ORDER BY tabella.id`.
- L'hook risolve i percorsi relativi che compaiono nel testo di un comando Bash a partire dalla home, non dalla cartella corrente: uno script o un heredoc che li contiene (anche solo una stringa `..` in un test) viene bloccato. Meglio scrivere il file con lo strumento di scrittura o di modifica.
- In `zsh` gli script `node -e` con molte virgolette annidate falliscono: meglio modificare i file con gli strumenti di edit.
- L'hook legge come home anche una tilde nel testo di un comando Bash: l'operatore regex di SQL dentro uno script viene bloccato, e così una nota che lo cita. SQL e documenti che lo contengono si modificano con lo strumento di edit.
- In un vincolo CHECK di PostgreSQL un'espressione che vale NULL (per esempio un campo JSON mancante) fa passare la riga: va avvolta in `coalesce(..., false)`.
- Con `NODE_USE_ENV_PROXY=1` (o `--use-env-proxy`) e `HTTP_PROXY`, `fetch` e gli agent globali di Node mandano al proxy anche le richieste a 127.0.0.1: verso servizi locali si usa `node:http` con un agent proprio (`packages/executors/src/local/http.ts`).
- Un processo figlio lanciato da un test eredita `NODE_TEST_CONTEXT` e si comporta come un file di test del runner: va tolto dall'ambiente. Un figlio che usa `fetch` attraverso un proxy può non terminare da solo: `process.exit`.
- Un processo lanciato da Claude con Bash (per esempio `pnpm start`) gira nella sandbox: dal terminale risponde, ma il Chrome dell'utente non lo raggiunge. `curl` è negato: per provare l'API si usa `node:http`.
- Una migrazione applicata al database di sviluppo da `pnpm start` non si può più modificare (sha256 in `schema_migrations`): le migrazioni non committate vanno finite prima di avviare il core.
- postgres.js serializza come stringa JSON una stringa passata a un parametro `::jsonb` (`'[]'` diventa `"[]"`): per i valori JSON si usa `sql.json(...)`.
- Gli strumenti di scrittura possono trasformare gli escape `\uXXXX` in caratteri veri: le espressioni regolari con caratteri invisibili vanno controllate con `od -c`.

## Prompt per la nuova conversazione

> Leggi CLAUDE.md e docs/HANDOFF.md e riprendi dai "Prossimi passi".
