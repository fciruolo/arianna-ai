# Task delle Fasi 0 e 1

Ore = stima mia (min-max), con colonna per le ore reali da compilare. Ogni task = un commit.

## Fase 0 — Fondamenta (14-23 h)

| Id | Task | Ore | Reali | Fatto quando |
| --- | --- | --- | --- | --- |
| 0.1 | Monorepo pnpm, TypeScript strict, lint, script in CLAUDE.md | 2-3 | | `pnpm build/test/lint` girano |
| 0.2 | CI (GitHub Actions o locale) con test ed eval | 1-2 | | CI verde su push |
| 0.3 | Docker Compose con PostgreSQL, migrazioni, tabelle `events`, `tasks` | 3-5 | | Migrazione applicata da zero |
| 0.4 | Scheletro harness eval con 4 gruppi e 1 caso ciascuno | 3-5 | | `pnpm eval` produce report |
| 0.5 | `.claude/settings.json` e hook (niente lettura fuori repo), subagent reviewer | 1-2 | | Hook blocca un percorso esterno |
| 0.6 | Primo test end-to-end: scrivi evento, leggilo, ADR iniziali | 2-3 | | Test verde; D-001..D-005 compilate |
| 0.7 | Layout portabile: `ARIANNA_HOME`, `arianna.toml`, schema del manifest modelli (vedi `INSTALLER-PORTABILITY.md`) | 2-3 | | Percorsi tutti relativi; cambio cartella senza rotture |

Criterio di uscita: vedi `ROADMAP.md`. A fine fase confronta ore previste e reali.

## Fase 1 — Nucleo e chat (74-111 h)

| Id | Task | Ore | Reali | Fatto quando |
| --- | --- | --- | --- | --- |
| 1.1 | `packages/policy`: etichette, regole, contaminazione | 7-10 | | Casi gateway unitari verdi |
| 1.2 | Gateway di uscita e `gateway_log` | 7-10 | | Eval gateway 100% |
| 1.3 | Adattatore modello locale (oMLX, interfaccia sostituibile) | 4-6 | | Test di contratto verde |
| 1.4 | Adattatore `claude -p` (stream-json, resume, permessi) | 5-8 | | Compito banale eseguito e loggato |
| 1.5 | Adattatore `codex exec --json` | 4-7 | | Idem; accesso ChatGPT verificato |
| 1.6 | Router: filtri, difficoltà, scelta, fallback, log decisioni | 7-10 | | Eval router ≥ 95%, privacy 100% |
| 1.7 | Loader e validazione schede agente (trifecta) | 3-5 | | Scheda non valida rifiutata |
| 1.8 | Orchestratore locale con strumenti a schema vincolato | 7-10 | | Task a più passi completato |
| 1.9 | Modello task, approvazioni, tetti di passi/tempo/costo | 4-6 | | Task fermato dal tetto e da approvazione |
| 1.10 | API + WebSocket eventi + chat web minima | 4-7 | | Chat funzionante dal browser |
| 1.11 | Casi eval gateway e router completi | 4-6 | | Soglie rispettate |
| 1.12 | Indurimento e verifica del criterio di uscita | 4-5 | | Criterio Fase 1 superato |
| 1.13 | Installer: prerequisiti, download modelli con sha256, `doctor`, collegamento a oMLX | 8-12 | | Installazione pulita in cartella vuota; modelli Qwen scaricati e verificati |
| 1.14 | Wizard `init`, schema `arianna.toml`, catalogo modelli curato e ruoli | 6-9 | | Wizard completo da zero; cambio modello di un ruolo senza riavvio |

Dipendenze: 1.13→1.14; 1.1→1.2→1.6; 1.3-1.5 prima di 1.6; 1.7→1.8; 1.9 prima di 1.10 e 1.12.

Prima di 1.4 e 1.5 verifica come vengono conteggiati `claude -p` e `codex exec` nei tuoi account (`OPEN-QUESTIONS.md`).
