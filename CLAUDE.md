# Arianna — regole per Claude Code

Leggi `docs/SPEC.md` per il contesto e `docs/ROADMAP.md` per la fase corrente. Lavora una fase alla volta e non passare alla successiva senza che l'utente abbia superato il criterio di uscita. Se due documenti si contraddicono, fermati e correggili entrambi (D-013 in `docs/DECISIONS.md`).

## Continuità fra conversazioni

- **All'inizio di ogni sessione leggi `docs/HANDOFF.md`**: dice dove siamo, cosa è in sospeso e cosa aspetta l'utente.
- **All'inizio di ogni sessione controlla che il sistema sia attivo e avvia ciò che manca** (richiesta dell'utente, 2026-10-04): database (`pnpm db:up`), core (`pnpm start`, in background, su 127.0.0.1:7420) e chat in sviluppo (`pnpm hud:dev`, in background, su 127.0.0.1:5173). Se Docker è spento non avviarlo: chiedi all'utente di aprirlo. oMLX non rientra nel controllo.
- **Tienilo aggiornato**: a fine task, prima di fermarti, e quando cambia ciò che è in attesa dell'utente.
- **Quando la conversazione diventa troppo grande, dillo e proponi di aprirne una nuova.** Segnali: il contesto è stato riassunto, sono stati chiusi più di due o tre task nella stessa conversazione, inizi a perdere dettagli già stabiliti. Prima di proporlo aggiorna `docs/HANDOFF.md` come consegna (stato, prossimi passi, attese, cose non ovvie) e dai all'utente il prompt da incollare nella nuova conversazione. Il momento migliore è fra un task e l'altro, non a metà.
- La memoria di Claude Code fuori dal repository non è utilizzabile (l'hook la blocca): ciò che va ricordato sta qui o in `docs/HANDOFF.md`.

## Regole non negoziabili

- **Privacy prima di tutto.** Nessun dato L2/L3 va a un esecutore cloud (Claude Code, Codex) né a un canale esterno (Telegram, telefono). L'unica uscita verso il cloud è il gateway (`packages/policy`). Dati non etichettati = L2 (default-deny). L'output di un modello eredita l'etichetta più alta dei suoi input. Gli esecutori cloud si lanciano solo da `packages/executors`, con il profilo di confinamento di `docs/PRIVACY-POLICY-SPEC.md`.
- **Solo dati finti in sviluppo.** Usa `kb/` con documenti inventati. Non leggere né scrivere fuori dal repository. Mai fatture, contratti o credenziali reali. Eccezione: le cartelle di codice pubblico elencate dall'utente in `.claude/read-allow.local` si possono leggere, mai scrivere (D-059).
- **Mai token OAuth.** Non estrarre, copiare o salvare credenziali degli abbonamenti. Si usano solo i binari ufficiali `claude` e `codex`, non modificati.
- **Nessuna nuova dipendenza** senza una voce in `docs/DECISIONS.md`.
- **Test obbligatori** per `packages/policy` e `packages/router`: ogni regola ha almeno un caso positivo e uno negativo. Un cambio a queste cartelle o a `packages/executors` non si chiude se gli eval falliscono.
- **Azioni esterne o irreversibili** (email, pagamenti, cancellazioni, chiamate) passano da approvazione; non aggirarle.

## Stack e convenzioni

- **Portabilità:** nessun percorso assoluto; tutto relativo a `ARIANNA_HOME`. Pesi dei modelli, database e archivio vivono in `data/` (fuori da git). Dettagli in `docs/INSTALLER-PORTABILITY.md`.

- TypeScript strict, pnpm monorepo, Node LTS. Python solo in `apps/voice`.
- Node esegue i sorgenti TypeScript senza build (D-026): solo sintassi cancellabile (niente `enum`, `namespace`, parameter properties), `import type` per i tipi, import relativi con estensione `.ts`. Sorgenti in `src/`, test in `test/*.test.ts` con `node:test` e `node:assert/strict`; i test che richiedono PostgreSQL in `apps/*/test-db/`. I pacchetti si importano per nome (`@arianna/policy`).
- PostgreSQL per stato, eventi e coda. Schema in `docs/DATA-MODEL.md`.
- Commit piccoli, uno per task di `docs/PHASE-0-1-TASKS.md`; il messaggio cita l'id del task.
- Documentazione in italiano; codice, nomi e commenti in inglese.

## Comandi

| Comando | Cosa fa |
| --- | --- |
| `pnpm install` | Installa le dipendenze (versioni esatte, lockfile in git) |
| `pnpm build` | Controllo dei tipi di tutto il monorepo, `apps/hud` compreso con `vue-tsc`; non produce file (D-026, D-038). È l'unico comando che vede gli errori di tipo |
| `pnpm test` | Test senza servizi, con `node:test`: `apps/*/test`, `packages/*/test`, `test/` e hook di `.claude/`; un file di test altrove fa fallire la suite |
| `pnpm lint` | ESLint con regole che vedono i tipi |
| `pnpm eval` | Eval deterministici (gateway, router): niente modelli né rete; fallisce sotto soglia |
| `pnpm eval:models` | Eval che richiedono il modello locale (orchestratore, estrazione, retrieval) |
| `pnpm eval:live` | Eval dal vivo con `claude` e `codex` (contratto, canarino); consumano quota |
| `pnpm check` | `build` + `test` + `lint` + `eval`; l'hook git `.githooks/pre-commit` lo esegue a ogni commit e lo rifiuta se fallisce |
| `pnpm db:up` / `pnpm db:down` | Avvia o ferma PostgreSQL in Docker con i valori di `config/arianna.toml` |
| `pnpm db:migrate` | Applica le migrazioni di `apps/core/migrations` come proprietario e dà a `arianna_app` la sua password (D-046); con le password vere va lanciato a ogni aggiornamento |
| `pnpm arianna:init [--reconfigure\|--defaults]` | Wizard in italiano (D-048) che scrive `config/arianna.toml`, fuori da git: modelli per ruolo dal catalogo, esecutori cloud, Telegram. `--reconfigure` parte dai valori attuali; `--defaults` scrive i valori di sviluppo senza domande, solo se il file manca. Dopo un clone, prima di `pnpm start`, `db:up` e `test:db`, serve `pnpm arianna:init --defaults` |
| `pnpm arianna:install` | Installer (D-047): prerequisiti, cartelle di `data/` (`data/` e `data/vault` private), wizard se manca `config/arianna.toml`, modelli mancanti fra quelli assegnati a un ruolo, database, migrazioni, doctor. Esce con 1 anche quando l'installazione è riuscita ma il doctor non la dà pronta per i dati veri (con le password di sviluppo, sempre) |
| `pnpm arianna:doctor` | Controlla che l'installazione sia pronta per i dati veri: prerequisiti, cartelle, modelli presenti, password dal vault e rifiutate quelle di sviluppo, migrazioni, limiti di `arianna_app`, catena degli eventi. Con le password di sviluppo fallisce, ed è normale |
| `pnpm arianna:models list\|verify\|pull [--verify]` | Confronta `data/models` con i modelli del catalogo `config/models.catalog.yaml` assegnati a un ruolo (`verify` calcola gli sha256); `pull` scarica i file mancanti con ripresa e verifica, con `--verify` sostituisce anche quelli con lo sha256 sbagliato |
| `pnpm vault:init <age1...>` / `pnpm vault:edit` | Li esegue l'utente: scrive `data/vault/.sops.yaml` con la chiave pubblica age; apre `data/vault/secrets.yaml` con `sops` (D-042) |
| `pnpm start` | Avvia il core come `arianna_app`: migrazioni (solo con le password di sviluppo; con quelle vere prima `pnpm db:migrate`), worker dei task, API, WebSocket e chat web su `[server]` di `arianna.toml` (loopback) |
| `pnpm hud:build` | Compila la chat web in `apps/hud/dist`, servita dal core |
| `pnpm hud:dev` | Chat web in sviluppo con Vite su `127.0.0.1:5173`, che inoltra `/api` al core avviato con `pnpm start` |
| `node apps/hud/characters/build.ts [--preview]` | Rigenera i fogli PNG dei personaggi originali (D-060) dalle mappe di pixel in `apps/hud/characters/art/`; `--preview` scrive anche gli ingrandimenti in `data/characters-preview/`. Un test fallisce se i PNG in git non corrispondono alle mappe |
| `pnpm test:db` | Test che richiedono PostgreSQL (`apps/*/test-db`); avvia il database se serve. Fuori da `pnpm check`: obbligatorio a fine task se tocchi migrazioni o codice che parla con il database (D-029) |

Aggiungi qui ogni comando quando esiste.

Dopo un clone, `pnpm install` attiva l'hook git (`core.hooksPath`). Non aggirarlo con `--no-verify`. `config/arianna.toml` non è in git (D-048): in sviluppo si crea con `pnpm arianna:init --defaults`; `pnpm check` funziona anche senza.

Un file TypeScript si esegue direttamente: `node percorso/file.ts`.

## Quando finisci un task

Esegui `pnpm check` (e `pnpm test:db` se hai toccato migrazioni o codice che parla con il database), aggiorna le ore reali nel task, annota decisioni nuove in `docs/DECISIONS.md`, poi fermati e riassumi in poche righe.
