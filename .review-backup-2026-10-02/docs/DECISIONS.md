# Registro delle decisioni

Formato: id · data · decisione · motivo · stato. Nuove dipendenze e cambi di architettura entrano qui prima del codice.

| Id | Data | Decisione | Motivo | Stato |
| --- | --- | --- | --- | --- |
| D-001 | 2026-10-02 | Livelli di privacy L0-L3, default-deny, gateway unico | Garantire che L2/L3 non escano | Accettata |
| D-002 | 2026-10-02 | Esecutori: modello locale, `claude -p`, `codex exec`; nessuna API; nessun token estratto | Vincolo di abbonamento e privacy | Accettata |
| D-003 | 2026-10-02 | Nucleo in TypeScript (pnpm monorepo); voce in Python | Uno stack con interfacce e agenti | Accettata (2026-10-02, confermata dall'utente) |
| D-004 | 2026-10-02 | Coda su PostgreSQL o DBOS | Meno componenti; durabilità | Da decidere in task 0.3 |
| D-005 | 2026-10-02 | Voce con Pipecat invece di LiveKit Agents | Licenza BSD-2, componenti locali | Proposta |
| D-006 | 2026-10-02 | pixel-agents integrato con `HookProvider` proprio (MIT) | Riuso senza dipendere da Claude Code | Proposta |
| D-007 | 2026-10-02 | Scrivere: gateway, router, orchestratore, schede agente, task/cardwall/eventi, HUD. Adottare: DBOS, Pipecat, pixel-agents, parser FatturaPA/Docling/PaddleOCR-VL, Qdrant+Mem0, libreria FSRS, sandbox, Promptfoo/Inspect/Langfuse | Il valore sta nel nucleo di privacy e orchestrazione | Accettata |
| D-008 | 2026-10-02 | Autonomia a gradini A0-A3, si parte da A1 | Fiducia progressiva | Accettata |
| D-009 | 2026-10-02 | Docker per Postgres, Qdrant, core e HUD; oMLX, modelli locali e audio restano nativi sul Mac (Docker non vede la GPU Apple) | Prestazioni e accesso all'hardware | Accettata |
| D-010 | 2026-10-02 | Tutto in una cartella (`ARIANNA_HOME`); modelli scaricati da manifest, non sincronizzati; database sincronizzati solo come dump cifrati | Esportabilità e condivisione via Synology senza corruzioni | Accettata |
| D-011 | 2026-10-02 | Ufficio pixel: pixel-agents (MIT) standalone incorporato nell'HUD Vue; HUD scritto in Vue | Riuso del codice complesso, HUD legato al nostro modello dati | Accettata |
| D-012 | 2026-10-02 | OpenJarvis (Apache-2.0) solo da studiare, non adottato come base | Framework Python concorrente, senza gateway di privacy evidente nel README | Accettata, da riverificare leggendo il codice |
