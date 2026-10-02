# Consegna fra conversazioni

Questo file dice a una nuova sessione di Claude Code da dove riprendere. Si aggiorna a fine task e ogni volta che si propone di aprire una conversazione nuova (regola in `CLAUDE.md`). Contiene solo ciò che non si ricava da git e dagli altri documenti.

Aggiornato: 2026-10-02, durante la Fase 0.

## Dove siamo

- **Fase 0 in corso.** Su `main` (commit `b28ac88`): task 0.1, 0.2, 0.7, 0.4. Su `origin`, `main` è fermo al task 0.2: i commit di 0.7 e 0.4 ci sono comunque, dentro il branch `task/0.3-postgres`, e il merge finale resta un fast-forward.
- **Cambio di macchina:** dal 2026-10-02 il lavoro passa dal portatile al Mac Studio, con un clone nuovo. Vedi "Su una macchina nuova" più sotto.
- **Branch `task/0.3-postgres`: un commit di lavoro in corso, non ancora su `main`.** Contiene i task 0.3 (PostgreSQL, migrazioni), 0.5 (verifica hook) e 0.6 (registro eventi con catena di hash), le correzioni della revisione a `packages/policy`, `packages/config` e `packages/evals`, e questo file. Il branch ha un corrispondente su `origin`; il push lo fa l'utente.
- `pnpm check` passa (53 test). **`pnpm test:db` non è mai stato eseguito**: Docker Desktop non era avviato. L'SQL di `apps/core/migrations/0001_init.sql` è stato solo letto, anche dal revisore, mai eseguito.

## Su una macchina nuova

Passa da git solo ciò che è nel repository. Non passano: `node_modules`, `data/`, la cronologia delle conversazioni, i permessi approvati a mano in Claude Code. Prima di riprendere:

1. Controllare di essere sul branch giusto: `git branch --show-current` deve dare `task/0.3-postgres` finché la Fase 0 non è chiusa.
2. Controllare i prerequisiti: `node -v` (22.18 o più), `pnpm -v`, `docker info`, `git config user.name`. Ciò che manca lo installa l'utente.
3. `pnpm install`: scarica le dipendenze e attiva l'hook git pre-commit. Verificare con `git config core.hooksPath`, che deve dare `.githooks`.
4. `pnpm check`: deve passare (53 test) prima di toccare qualsiasi cosa. Se fallisce su una macchina nuova è un problema di portabilità: va capito e corretto, non aggirato.
5. Si lavora su una macchina alla volta: push prima di lasciarla, pull appena arrivati sull'altra. La cartella non va sincronizzata anche con Synology Drive o simili mentre si usa git.

## Prossimi passi, in ordine

1. Controllare Docker con `docker info`. Se non è avviato, chiedere all'utente di avviare Docker Desktop: non avviarlo da soli, è fuori dalla cartella.
2. `pnpm test:db` e correzione di ciò che non passa. Punti più incerti alla prima esecuzione:
   - permessi di inizializzazione sul volume `data/postgres` con Docker Desktop;
   - `event_hash(v_prev, NEW)` nel trigger `events_chain` (riga `NEW` passata a un parametro di tipo `events`);
   - il test "a writer on a stale snapshot cannot fork the chain": il messaggio d'errore atteso potrebbe essere diverso;
   - la migrazione non è mai stata applicata a un database, quindi `0001_init.sql` si può ancora modificare finché resta su questo branch. Dopo il merge su `main` no: si aggiunge una migrazione nuova.
3. Fissare l'immagine in `compose.yaml` con versione minore e digest (`postgres:17.x-alpine@sha256:…`, da `docker image inspect`) e annotarlo in D-028.
4. Scrivere le ore reali di 0.3 e 0.6 in `PHASE-0-1-TASKS.md`, fare un commit di chiusura con le correzioni emerse dai test, merge fast-forward su `main`, cancellare il branch.
5. Riassumere all'utente il criterio di uscita della Fase 0 (`ROADMAP.md`) con le prove, e **fermarsi**: la Fase 1 non parte senza il suo via libera.

## In attesa dell'utente

| Cosa | Note |
| --- | --- |
| Avviare Docker Desktop | Blocca la chiusura della Fase 0 |
| `git push` di `main` | Il push è negato a Claude per scelta |
| Permessi in `.claude/settings.json` | L'utente vuole che Claude lavori nella cartella senza conferme. Claude non può modificare quel file (negato come auto-modifica dei permessi): deve incollarlo l'utente. Proposta: `defaultMode: acceptEdits`; comandi di progetto in `allow`; `pnpm add/install <pkg>/update/dlx`, `git remote` e `git config --global` in `ask`; `|| exit 2` in coda al comando dell'hook, così blocca anche se va in errore. Dopo l'incolla, aggiornare `SECURITY.md` |
| Conferma delle decisioni | D-004 e da D-013 a D-029 sono "Proposta, applicata" in `DECISIONS.md` |
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
- In `zsh` gli script `node -e` con molte virgolette annidate falliscono: meglio modificare i file con gli strumenti di edit.

## Prompt per la nuova conversazione

> Leggi CLAUDE.md e docs/HANDOFF.md e riprendi dai "Prossimi passi".
