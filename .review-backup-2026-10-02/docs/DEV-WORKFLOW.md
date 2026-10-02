# Come si sviluppa con Claude Code

## Preparazione

1. Apri il terminale nella cartella `arianna/` e avvia `claude`.
2. Controlla che `CLAUDE.md` e `.claude/settings.json` siano stati letti (`/memory`, `/permissions`).
3. Lavora un task alla volta da `docs/PHASE-0-1-TASKS.md`; usa la modalità piano per i task da 5 ore in su.

## Primo prompt (Fase 0)

> Leggi CLAUDE.md, docs/SPEC.md, docs/ARCHITECTURE.md e docs/PHASE-0-1-TASKS.md. Esegui il task 0.1: crea il monorepo pnpm con TypeScript strict e lint, aggiorna la sezione Comandi di CLAUDE.md, fai un commit. Non iniziare il task 0.2.

## Ciclo per ogni task

1. Piano breve → approvi.
2. Implementazione con test.
3. Subagent `reviewer` sul diff.
4. `pnpm test && pnpm lint && pnpm eval`.
5. Commit; ore reali scritte nella tabella del task.

## Regole pratiche

- Contesto corto: `/clear` fra un task e l'altro; lo stato sta nei file, non nella conversazione.
- Dati finti sempre; mai il tuo disco personale nel repository.
- Modello: Sonnet per l'ordinario, Opus per policy, router e orchestratore.
- Se un task supera del 50% le ore stimate, fermati e dividilo.
