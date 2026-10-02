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
- PostgreSQL per stato, eventi e coda. Schema in `docs/DATA-MODEL.md`.
- Commit piccoli, uno per task di `docs/PHASE-0-1-TASKS.md`; il messaggio cita l'id del task.
- Documentazione in italiano; codice, nomi e commenti in inglese.

## Comandi

Da definire nel task 0.1 (sostituisci questa sezione quando esistono):
`pnpm install` · `pnpm build` · `pnpm test` · `pnpm lint` · `pnpm eval` · `pnpm check` (test + lint + eval) · `pnpm eval:models` · `pnpm eval:live`

## Quando finisci un task

Esegui test e lint, aggiorna le ore reali nel task, annota decisioni nuove in `docs/DECISIONS.md`, poi fermati e riassumi in poche righe.
