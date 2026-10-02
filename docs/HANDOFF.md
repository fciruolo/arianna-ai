# Consegna fra conversazioni

Questo file dice a una nuova sessione di Claude Code da dove riprendere. Si aggiorna a fine task e ogni volta che si propone di aprire una conversazione nuova (regola in `CLAUDE.md`). Contiene solo ciò che non si ricava da git e dagli altri documenti.

Aggiornato: 2026-10-02, a fine task 1.9.

## Dove siamo

- **Fase 0 chiusa** (via libera dell'utente il 2026-10-02). **Fase 1A in corso:** task 1.1 (policy), 1.2 (gateway, D-032) 1.3 (modello locale: `@arianna/executors` con `createLocalModel`, `Watchdog`, sezione `[[local.endpoints]]` di `arianna.toml`; D-033) e 1.9 (schede agente: `@arianna/agents`, `agents/arianna.yaml` e `agents/coder.yaml`; D-034) su `main`. Il 1.9 è stato anticipato perché 1.4 aspetta oMLX e 1.5 la verifica di `claude -p`; l'utente ha chiesto di procedere da solo mentre era lontano. Il push su `origin` lo fa l'utente.
- Dal 2026-10-02 si lavora sul Mac Studio.
- `pnpm check` passa (230 test, eval gateway 48/48); `pnpm test:db` passa (33 test) con l'immagine `postgres:17.11-alpine` fissata per digest.
- Regole di etichetta in `config/labels.toml`, lette da `@arianna/config` e validate da `@arianna/policy` (D-031). `policy` resta senza dipendenze e senza I/O.
- `0001_init.sql` è su `main`: d'ora in poi ogni modifica allo schema va in una migrazione nuova.

## Su una macchina nuova

Passa da git solo ciò che è nel repository. Non passano: `node_modules`, `data/`, la cronologia delle conversazioni, i permessi approvati a mano in Claude Code. Prima di riprendere:

1. Controllare di essere sul branch giusto: `main`, oppure il branch del task in corso se ce n'è uno.
2. Controllare i prerequisiti: `node -v` (22.18 o più), `pnpm -v`, `docker info`, `git config user.name`. Ciò che manca lo installa l'utente.
3. `pnpm install`: scarica le dipendenze e attiva l'hook git pre-commit. Verificare con `git config core.hooksPath`, che deve dare `.githooks`.
4. `pnpm check`: deve passare (230 test) prima di toccare qualsiasi cosa. Se fallisce su una macchina nuova è un problema di portabilità: va capito e corretto, non aggirato.
5. Si lavora su una macchina alla volta: push prima di lasciarla, pull appena arrivati sull'altra. La cartella non va sincronizzata anche con Synology Drive o simili mentre si usa git.

## Prossimi passi, in ordine

1. **Task 1.8** (task, run, approvazioni, tetti, coda e ripresa): non dipende dai modelli, si può fare subito. Poi **1.4** appena oMLX è installato (scelto dall'utente; il comando dal README è nell'esempio di `arianna.toml`): nomi dei modelli da scrivere in `[[local.endpoints]]`, oggi solo un esempio commentato. Con 1.4 il contratto dell'adattatore va provato anche sul server vero: finora è verificato solo sul server finto. Poi 1.5, che serve a 1.6 (confinamento) e alla convergenza di 1.7. Prima del task 1.5 bisogna sapere come viene conteggiato `claude -p` nell'abbonamento.
2. Lasciati da 1.2 e 1.3 ai task successivi: gli adattatori inviano `decision.texts`, mai una nuova serializzazione (oggi `LocalModel.chat` accetta qualsiasi stringa: valutare con 1.10 un tipo che arrivi solo da una decisione `allow`, così nessuna chiamata locale salta la riga in `gateway_log`); il core deve collegare `Watchdog.isAvailable`/`reportFailure` a `createLocalModel` e mandare gli eventi del watchdog in `events`, con il log del server in `data/` (1.8/1.10); un server adottato che si blocca senza morire porta il watchdog in `failed` (file del pid in `data/` da valutare con 1.8, D-033); il riavvio preventivo dopo molte richieste (crolli di oMLX per la cache) non c'è ancora; il registro chiuso degli strumenti (`packages/agents/src/tools.ts`) è la lista che useranno il server MCP (1.6) e l'orchestratore (1.10), che aggiungerà gli schemi degli argomenti; `repo.test` non apre lati del trifecta solo se la sandbox di 1.6 blocca la rete anche all'esecutore locale; il motore del 1.8 deve rifiutare una richiesta di approvazione per un'azione fuori da `approvals` della scheda e trattare `max_cost` come euro extra oltre gli abbonamenti (0 = nessuna spesa); il testo della notifica con riferimento (`next: notify-reference`) lo scrive il canale (1.15); portare il task in "Attende te" (`next: wait-user`) spetta al task 1.8; i casi eval su worktree e MCP arrivano con 1.6.
3. Docker serve per `pnpm test:db`: se è spento, chiedere all'utente di avviarlo, mai farlo da soli.

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
- Gli strumenti di scrittura possono trasformare gli escape `\uXXXX` in caratteri veri: le espressioni regolari con caratteri invisibili vanno controllate con `od -c`.

## Prompt per la nuova conversazione

> Leggi CLAUDE.md e docs/HANDOFF.md e riprendi dai "Prossimi passi".
