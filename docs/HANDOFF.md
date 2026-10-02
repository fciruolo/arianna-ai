# Consegna fra conversazioni

Questo file dice a una nuova sessione di Claude Code da dove riprendere. Si aggiorna a fine task e ogni volta che si propone di aprire una conversazione nuova (regola in `CLAUDE.md`). Contiene solo ciò che non si ricava da git e dagli altri documenti.

Aggiornato: 2026-10-02, a fine task 1.2.

## Dove siamo

- **Fase 0 chiusa** (via libera dell'utente il 2026-10-02). **Fase 1A in corso:** task 1.1 (policy) e 1.2 (gateway: `gatewayCheck`, scanner, `declassify`, migrazione `0002` con `approvals`, `label_changes`, `gateway_log`; D-032) su `main`. Il push su `origin` lo fa l'utente.
- Dal 2026-10-02 si lavora sul Mac Studio.
- `pnpm check` passa (139 test, eval gateway 48/48); `pnpm test:db` passa (33 test) con l'immagine `postgres:17.11-alpine` fissata per digest.
- Regole di etichetta in `config/labels.toml`, lette da `@arianna/config` e validate da `@arianna/policy` (D-031). `policy` resta senza dipendenze e senza I/O.
- `0001_init.sql` è su `main`: d'ora in poi ogni modifica allo schema va in una migrazione nuova.

## Su una macchina nuova

Passa da git solo ciò che è nel repository. Non passano: `node_modules`, `data/`, la cronologia delle conversazioni, i permessi approvati a mano in Claude Code. Prima di riprendere:

1. Controllare di essere sul branch giusto: `main`, oppure il branch del task in corso se ce n'è uno.
2. Controllare i prerequisiti: `node -v` (22.18 o più), `pnpm -v`, `docker info`, `git config user.name`. Ciò che manca lo installa l'utente.
3. `pnpm install`: scarica le dipendenze e attiva l'hook git pre-commit. Verificare con `git config core.hooksPath`, che deve dare `.githooks`.
4. `pnpm check`: deve passare (139 test) prima di toccare qualsiasi cosa. Se fallisce su una macchina nuova è un problema di portabilità: va capito e corretto, non aggirato.
5. Si lavora su una macchina alla volta: push prima di lasciarla, pull appena arrivati sull'altra. La cartella non va sincronizzata anche con Synology Drive o simili mentre si usa git.

## Prossimi passi, in ordine

1. **Task 1.3**, adattatore del modello locale (oMLX, interfaccia sostituibile, watchdog), e subito dopo **1.4** (test di accettazione dell'orchestratore). Poi 1.5, che serve a 1.6 (confinamento) e alla convergenza di 1.7. Prima del task 1.5 bisogna sapere come viene conteggiato `claude -p` nell'abbonamento.
2. Lasciati da 1.2 ai task successivi: l'adattatore locale deve garantire che il suo endpoint sia in `local_endpoints` (il gateway si fida della `locality` dichiarata, tranne per `claude` e `codex`); gli adattatori inviano `decision.texts`, mai una nuova serializzazione; il testo della notifica con riferimento (`next: notify-reference`) lo scrive il canale (1.15); portare il task in "Attende te" (`next: wait-user`) spetta al task 1.8; i casi eval su worktree e MCP arrivano con 1.6.
3. Docker serve per `pnpm test:db`: se è spento, chiedere all'utente di avviarlo, mai farlo da soli.

## In attesa dell'utente

| Cosa | Note |
| --- | --- |
| `git push` di `main` a ogni task chiuso; cancellare il branch remoto `task/0.3-postgres` se ancora presente | Il push è negato a Claude per scelta |
| Permessi in `.claude/settings.json` | L'utente vuole che Claude lavori nella cartella senza conferme. Claude non può modificare quel file (negato come auto-modifica dei permessi): deve incollarlo l'utente. Proposta: `defaultMode: acceptEdits`; comandi di progetto in `allow`; `pnpm add/install <pkg>/update/dlx`, `git remote` e `git config --global` in `ask`; `|| exit 2` in coda al comando dell'hook, così blocca anche se va in errore. Dopo l'incolla, aggiornare `SECURITY.md` |
| Conferma delle decisioni | D-004 e da D-013 a D-029 sono "Proposta, applicata" in `DECISIONS.md`; D-030 (cartella di sviluppo separata da quella di installazione, Synology solo sui dati veri) è una proposta nata dalla domanda dell'utente sul Mac Studio |
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
- Gli strumenti di scrittura possono trasformare gli escape `\uXXXX` in caratteri veri: le espressioni regolari con caratteri invisibili vanno controllate con `od -c`.

## Prompt per la nuova conversazione

> Leggi CLAUDE.md e docs/HANDOFF.md e riprendi dai "Prossimi passi".
