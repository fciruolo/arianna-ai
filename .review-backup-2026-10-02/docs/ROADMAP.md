# Roadmap e stime

Le ore sono **mie stime, non misurate**: lavoro effettivo di uno sviluppatore esperto che fa scrivere quasi tutto il codice a Claude Code, comprese revisione, test e correzioni; escluse attese di download, modelli e hardware. Si ricalibrano a fine Fase 0: se lo scarto supera il 30%, si rifanno le stime delle fasi successive.

| Fase | Obiettivo | Ore | Criterio di uscita (manuale) |
| --- | --- | --- | --- |
| 0 Fondamenta | Repo, CI, registro eventi, primo test, harness eval, layout portabile | 14-23 | `pnpm test` e `pnpm eval` passano in CI; evento scritto e letto dal DB |
| 1 Nucleo e chat | Policy, gateway, router, orchestratore, adattatori, chat, installer, wizard | 74-111 | Con dati finti, 0 fughe L2 negli eval; un task di coding L1 completato via Claude Code, uno L2 solo in locale; log del gateway leggibile |
| 2 Memoria e cardwall | Archivio, estrazione, ricerca ibrida, Mem0, cardwall, export/import | 64-96 | Domande su documenti veri (dopo verifica) con fonti corrette; cardwall usato per una settimana; ripristino da `export` provato su cartella nuova |
| 3 HUD e ufficio pixel | HUD Arianna, ufficio pixel, approvazioni e impostazioni in UI | 43-69 | Vedi agenti al lavoro e approvi azioni dall'HUD |
| 4 Voce e chiamate | Voce locale, delega, telefonia, chiamate in uscita | 50-90 | Conversazione fluida in italiano; chiamata in uscita con approvazione; nessun L2 letto salvo abilitazione |
| 5 Studio e mentor | Fonti, curriculum, ripasso FSRS, brief giornaliero | 25-45 | Una settimana di brief e ripassi utili |
| **Totale** | | **270-434** | Con margine 25%: 338-543 |

## Calendario

| Ore a settimana | Fino alla Fase 1 (già utile) | Progetto completo |
| --- | --- | --- |
| 10 | 11-17 settimane | 34-54 settimane |
| 20 | 6-8 settimane | 17-27 settimane |
| 30 | 4-6 settimane | 11-18 settimane |

Fase 1 con margine (Fasi 0+1): 110-168 ore. Le idee scelte dalla lista (`OPEN-QUESTIONS.md`) si aggiungono. Dopo la Fase 1 usa il sistema per qualche settimana prima di proseguire.

## Epic per fase (ore)

**Fase 2 (64-96):** export/import cifrati 4-6 · archivio e ingestione 8-12 · estrazione OCR e fatture 14-20 · KB markdown con frontmatter 6-9 · ricerca ibrida Qdrant 10-15 · memoria agenti Mem0 6-9 · cardwall backend e UI 12-18 · agenti Archivista/Segretario 4-7.

**Fase 3 (43-69):** layout HUD e WebSocket 10-15 · flusso eventi → UI 5-8 · pixel-agents con `HookProvider` proprio 12-18 · approvazioni in UI 8-14 · pagina Impostazioni 8-14.

**Fase 4 (50-90):** servizio voce Pipecat 12-20 · valutazione STT/TTS italiani locali 8-15 · delega e latenza 8-14 · telefonia SIP 14-26 · policy chiamate in uscita 8-15.

**Fase 5 (25-45):** ingestione fonti 8-14 · agente Mentor e curriculum 8-14 · ripasso FSRS 5-9 · brief giornaliero 4-8.
