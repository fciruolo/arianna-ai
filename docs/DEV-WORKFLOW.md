# Come si sviluppa con Claude Code

## Preparazione

1. Una volta sola: `git init`, primo commit dei documenti, installa `pnpm`.
2. Apri il terminale nella cartella `arianna/` e avvia `claude`.
3. Controlla che `CLAUDE.md` e `.claude/settings.json` siano stati letti (`/memory`, `/permissions`, `/hooks`).
4. Lavora un task alla volta da `docs/PHASE-0-1-TASKS.md`; usa la modalità piano per i task da 5 ore in su.

## Primo prompt (Fase 0)

> Leggi CLAUDE.md, docs/ARCHITECTURE.md e docs/PHASE-0-1-TASKS.md. Esegui il task 0.1: crea il monorepo pnpm con TypeScript strict e lint, aggiorna la sezione Comandi di CLAUDE.md, fai un commit. Non iniziare il task 0.2.

Per ogni task basta far leggere i documenti che lo riguardano (per 1.1 e 1.2 `PRIVACY-POLICY-SPEC.md`, per 1.7 `ROUTER-SPEC.md`), non tutta la specifica: contesto più corto, risposte migliori.

## Ciclo per ogni task

1. Piano breve → approvi.
2. Implementazione con test (scritti prima per `packages/policy` e `packages/router`).
3. Subagent `reviewer` sul diff.
4. `pnpm check` (controllo dei tipi, test, lint, eval deterministici); `pnpm eval:models` o `pnpm eval:live` se il task tocca orchestratore o adattatori.
5. Commit; ore reali scritte nella tabella del task.

## Corsie parallele (facoltativo)

In Fase 1A le corsie privacy, esecutori e nucleo sono indipendenti fino al router (schema in `PHASE-0-1-TASKS.md`). Si possono aprire due o tre sessioni di Claude Code, ognuna in un proprio worktree git e su un task di una corsia diversa. Regole:

- un task per sessione, un commit per task, merge solo dopo `pnpm check` e revisione;
- mai due sessioni sullo stesso pacchetto;
- le migrazioni del database le tocca una sola corsia alla volta;
- il limite è la tua attenzione in revisione: se la revisione di policy e gateway diventa frettolosa, torna a una corsia sola.

## Regole pratiche

- Contesto corto: `/clear` fra un task e l'altro; lo stato sta nei file, non nella conversazione.
- Dati finti sempre; mai il tuo disco personale nel repository.
- Modello: Sonnet per l'ordinario, Opus per policy, gateway, router e orchestratore.
- Se un task supera del 50% le ore stimate, fermati e dividilo.
- Un conflitto fra documenti si corregge in entrambi nello stesso commit (D-013).
