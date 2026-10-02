# Task delle Fasi 0 e 1

Ore = stima mia (min-max), con colonna per le ore reali da compilare. Ogni task = un commit. La Fase 1 è divisa in **1A** (percorso critico fino al criterio di uscita) e **1B** (completamenti, mentre già usi il sistema): vedi D-017.

## Prima di tutto (a mano, 15 minuti)

- `git init` nella cartella e primo commit dei documenti.
- Installare `pnpm` (manca) e `codex` (manca; serve solo dal task 1.16).
- Verificare nel tuo account come vengono conteggiati `claude -p` e `codex exec` (`OPEN-QUESTIONS.md`): prima del task 1.5.

## Fase 0 — Fondamenta (13-21 h)

| Id | Task | Ore | Reali | Fatto quando |
| --- | --- | --- | --- | --- |
| 0.1 | Monorepo pnpm, TypeScript strict, lint, script in CLAUDE.md | 2-3 | 0,1 (solo sessione di Claude) | `pnpm build/test/lint` girano |
| 0.2 | `pnpm check` (build + test + lint + eval) e hook git pre-commit; CI remota facoltativa (D-018) | 0,5-1 | 0,1 (solo sessione di Claude) | Un commit con un test rotto o un errore di tipo viene rifiutato |
| 0.3 | Docker Compose con PostgreSQL, migrazioni, tabelle `events` (catena di hash), `tasks`, `jobs` | 3-5 | 0,5 (solo sessione di Claude, compresa la prima corsa di `pnpm test:db`) | Migrazione applicata da zero; UPDATE su `events` negato |
| 0.4 | Scheletro harness eval a tre livelli, 1 caso per gruppo deterministico | 3-5 | 0,2 (solo sessione di Claude) | `pnpm eval` produce report e fallisce sotto soglia |
| 0.5 | Verifica di `.claude/settings.json`, hook e subagent reviewer (già presenti) | 0,5-1 | 0,1 (solo sessione di Claude) | Test dell'hook verdi dentro `pnpm test`; un `Read` esterno è bloccato in sessione |
| 0.6 | Primo test end-to-end: scrivi evento, leggilo, verifica la catena | 2-3 | 0,2 (solo sessione di Claude) | Test verde; `DECISIONS.md` riletto e stati confermati |
| 0.7 | Layout portabile: `ARIANNA_HOME`, `arianna.toml`, schema del manifest modelli (vedi `INSTALLER-PORTABILITY.md`) | 2-3 | 0,2 (solo sessione di Claude) | Percorsi tutti relativi; cambio cartella senza rotture |

Criterio di uscita: vedi `ROADMAP.md`. A fine fase confronta ore previste e reali.

## Fase 1A — Percorso critico (65-97 h)

| Id | Task | Ore | Reali | Fatto quando |
| --- | --- | --- | --- | --- |
| 1.1 | `packages/policy`: etichette, regole per cartella, taint, clearance, contaminazione | 7-10 | 0,5 (solo sessione di Claude) | Casi unitari verdi, positivo e negativo per regola |
| 1.2 | Gateway (`gatewayCheck`, scanner, declassamento con approvazione) e `gateway_log` | 7-10 | 0,8 (solo sessione di Claude) | Eval gateway deterministici 100% |
| 1.3 | Adattatore modello locale (oMLX, interfaccia sostituibile), watchdog e riavvio | 4-6 | 0,9 (solo sessione di Claude; contratto verificato sul server finto, non ancora su un modello vero) | Test di contratto verde; server ucciso → ripartenza automatica |
| 1.4 | Test di accettazione dell'orchestratore sul modello locale (`EVALS.md`) | 3-4 | 0,4 finora (solo sessione di Claude: harness e casi; manca la corsa con oMLX) | Soglie superate, oppure piano B scelto e annotato |
| 1.5 | Adattatore `claude -p` (stream-json, resume, permessi, errore di quota) | 5-8 | | Compito banale eseguito e loggato |
| 1.6 | Confinamento cloud: worktree per run, allowlist, scansione preventiva, MCP stretto, sandbox (anche verso i servizi locali via loopback), canarino | 5-8 | 0,8 finora (solo sessione di Claude: allowlist, worktree e scansione preventiva, D-041; mancano MCP, sandbox, ambiente pulito e canarino, che richiedono `claude -p`) | Canarino mai nel transcript, né da file né dal database; lancio negato fuori allowlist |
| 1.7 | Router: filtro privacy, budget, difficoltà a regole, scalata, log decisioni | 5-8 | 1,2 (solo sessione di Claude, compresa la revisione; anticipato prima di 1.5, D-040: collegamento con l'adattatore `claude -p` e con l'orchestratore nel 1.10) | Eval router ≥ 95%, privacy 100% |
| 1.8 | Task, run, approvazioni, tetti di passi/tempo/costo, coda `jobs` e ripresa dopo riavvio | 6-9 | 1,3 (solo sessione di Claude, compresa la revisione) | Task fermato da tetto e da approvazione; `kill -9` del core → il task riprende |
| 1.9 | Loader e validazione schede agente (trifecta); schede di Arianna e Coder | 3-5 | 0,3 (solo sessione di Claude) | Scheda non valida rifiutata |
| 1.10 | Orchestratore locale con strumenti a schema vincolato, contesto per task | 7-10 | | Task a più passi completato |
| 1.11 | API + WebSocket eventi + chat web minima: storico, modalità lavoro/privato, schede di approvazione | 5-8 | 1,5 (solo sessione di Claude, compresa la revisione; chat nel browser non ancora provata a mano, risposta vera con il 1.10) | Chat dal browser; declassamento approvato dalla chat |
| 1.12 | Casi eval completi: gateway, router, canarino | 4-6 | | Soglie rispettate |
| 1.13 | Indurimento e verifica del criterio di uscita; password del database non predefinita, controllata da un primo `doctor` | 4-5 | | Criterio Fase 1A superato |

**Traguardo M1 (dopo 1.7, 36-54 h):** da riga di comando un compito L1 va a Claude Code in un worktree confinato e uno L2 resta sul modello locale, con decisione del router e riga del gateway nel database. È il filo teso da un capo all'altro: da qui in poi si allarga, non si scopre.

### Dipendenze e corsie

```
Corsia privacy     1.1 → 1.2 ─────────→ 1.6 → 1.12
Corsia esecutori   1.3 → 1.4     1.5 ──┘
Corsia nucleo      1.8 ─────────────────────→ 1.11
Convergenza        1.7 (dopo 1.2, 1.3; fatto prima di 1.5, D-040) · 1.9 (dopo 1.1) · 1.10 (dopo 1.4, 1.7, 1.8, 1.9) · 1.13
```

Le tre corsie non si toccano fino alla convergenza: si possono portare avanti in worktree paralleli (`DEV-WORKFLOW.md`). 1.4 va fatto appena finito 1.3: se il modello locale non regge, lo si scopre dopo 7-10 ore e non dopo 60.

## Fase 1B — Completamenti (25-39 h)

Non bloccano il criterio di uscita; l'ordine è per utilità.

| Id | Task | Ore | Reali | Fatto quando |
| --- | --- | --- | --- | --- |
| 1.14 | Vault minimo: `sops` + `age`, riferimenti `vault://` risolti dal codice | 3-5 | 0,8 (solo sessione di Claude; anticipato su scelta dell'utente, D-042; verificato con un `sops` finto e con `sops` 3.13.3 e `age` 1.3.2 veri) | Un segreto finto usato senza comparire in prompt, log o eventi |
| 1.15 | Telegram: notifiche e chat L0/L1 come canale esterno dietro gateway; approvazioni con pulsanti | 4-6 | | Un contenuto L2 arriva come riferimento; approvazione da telefono |
| 1.16 | Adattatore `codex exec --json` con lo stesso profilo di confinamento; scheda Reviewer | 4-7 | | Compito banale e canarino; accesso ChatGPT verificato |
| 1.17 | Installer: prerequisiti, download modelli con sha256, `doctor`, collegamento a oMLX | 8-12 | | Installazione pulita in cartella vuota; modelli Qwen scaricati e verificati |
| 1.18 | Wizard `init`, schema `arianna.toml`, catalogo modelli curato e ruoli | 6-9 | | Wizard completo da zero; cambio modello di un ruolo senza riavvio |

Dipendenze: 1.14 → 1.15 (il token del bot è un segreto); 1.17 → 1.18.
