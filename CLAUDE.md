# Arianna — regole per Claude Code

Leggi `docs/SPEC.md` per il contesto e `docs/ROADMAP.md` per la fase corrente. Lavora una fase alla volta e non passare alla successiva senza che l'utente abbia superato il criterio di uscita. Se due documenti si contraddicono, fermati e correggili entrambi (D-013 in `docs/DECISIONS.md`).

## Regole non negoziabili

- **Privacy prima di tutto.** Nessun dato L2/L3 va a un esecutore cloud (Claude Code, Codex) né a un canale esterno (Telegram, telefono). L'unica uscita verso il cloud è il gateway (`packages/policy`). Dati non etichettati = L2 (default-deny). L'output di un modello eredita l'etichetta più alta dei suoi input. Gli esecutori cloud si lanciano solo da `packages/executors`, con il profilo di confinamento di `docs/PRIVACY-POLICY-SPEC.md`.
- **Solo dati finti in sviluppo.** Usa `kb/` con documenti inventati. Non leggere né scrivere fuori dal repository. Mai fatture, contratti o credenziali reali.
- **Mai token OAuth.** Non estrarre, copiare o salvare credenziali degli abbonamenti. Si usano solo i binari ufficiali `claude` e `codex`, non modificati.
- **Nessuna nuova dipendenza** senza una voce in `docs/DECISIONS.md`.
- **Test obbligatori** per `packages/policy` e `packages/router`: ogni regola ha almeno un caso positivo e uno negativo. Un cambio a queste cartelle o a `packages/executors` non si chiude se gli eval falliscono.
- **Azioni esterne o irreversibili** (email, pagamenti, cancellazioni, chiamate) passano da approvazione; non aggirarle.

## Stack e convenzioni

- **Portabilità:** nessun percorso assoluto; tutto relativo a `ARIANNA_HOME`. Pesi dei modelli, database e archivio vivono in `data/` (fuori da git). Dettagli in `docs/INSTALLER-PORTABILITY.md`.

- TypeScript strict, pnpm monorepo, Node LTS. Python solo in `apps/voice`.
- Node esegue i sorgenti TypeScript senza build (D-026): solo sintassi cancellabile (niente `enum`, `namespace`, parameter properties), `import type` per i tipi, import relativi con estensione `.ts`. Sorgenti in `src/`, test in `test/*.test.ts` con `node:test` e `node:assert/strict`. I pacchetti si importano per nome (`@arianna/policy`).
- PostgreSQL per stato, eventi e coda. Schema in `docs/DATA-MODEL.md`.
- Commit piccoli, uno per task di `docs/PHASE-0-1-TASKS.md`; il messaggio cita l'id del task.
- Documentazione in italiano; codice, nomi e commenti in inglese.

## Comandi

| Comando | Cosa fa |
| --- | --- |
| `pnpm install` | Installa le dipendenze (versioni esatte, lockfile in git) |
| `pnpm build` | Controllo dei tipi di tutto il monorepo; non produce file (D-026). È l'unico comando che vede gli errori di tipo |
| `pnpm test` | Test con `node:test`: `apps/*/test`, `packages/*/test`, `test/` e hook di `.claude/`; un file di test altrove fa fallire la suite |
| `pnpm lint` | ESLint con regole che vedono i tipi |
| `pnpm check` | `build` + `test` + `lint`; l'hook git `.githooks/pre-commit` lo esegue a ogni commit e lo rifiuta se fallisce |

In arrivo: `pnpm eval`, `pnpm eval:models`, `pnpm eval:live` (task 0.4; `pnpm eval` entrerà in `pnpm check`). Aggiungi qui ogni comando quando esiste.

Dopo un clone, `pnpm install` attiva l'hook git (`core.hooksPath`). Non aggirarlo con `--no-verify`.

Un file TypeScript si esegue direttamente: `node percorso/file.ts`.

## Quando finisci un task

Esegui build, test e lint, aggiorna le ore reali nel task, annota decisioni nuove in `docs/DECISIONS.md`, poi fermati e riassumi in poche righe.
