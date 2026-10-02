# Decisioni aperte e idee da scegliere

## Decisioni aperte

| Decisione | Proposta | Entro |
| --- | --- | --- |
| ~~Linguaggio del nucleo~~ | **Deciso: TypeScript** (D-003) | |
| Conferma delle decisioni "Proposta, applicata" (D-004, D-013…D-021, D-024) | Rileggerle in `DECISIONS.md` e confermarle o rifiutarle | Task 0.6 |
| Dove gira il server | Mac Studio all'inizio, dietro interfaccia sostituibile | Fase 1A |
| Conteggio di `claude -p` e `codex exec` negli abbonamenti | `claude -p` (task 1.5, D-049): con il login dell'abbonamento (`apiKeySource: none`) ogni run riporta un `rate_limit_event` con le finestre `five_hour` e `seven_day` dell'abbonamento; non è verificato se esista un credito separato. Da guardare nel tuo account dopo qualche run. `codex exec`: da verificare | Task 1.16 |
| Nomi esatti dei flag di confinamento (`--strict-mcp-config`, sorgenti delle impostazioni, sandbox) | Fissati per `claude` 2.1.288, sandbox compresa (D-049, D-050, `packages/executors/src/claude/profile.ts`) | Task 1.6 |
| ~~Sandbox: nativa di Claude Code oppure `sandbox-runtime`~~ | **Decisa la nativa** (D-050, confermata): il canarino non esce. microVM solo se un giorno esce | |
| oMLX può puntare a `data/models/`? | Sì secondo il README: `omlx serve --model-dir data/models` (da provare); altrimenti collegamenti simbolici | Task 1.17 |
| oMLX invia telemetria o contenuti fuori dalla macchina? | Il README non ne parla: verificare (codice o traffico di rete) prima di dargli dati L2 veri; non usare `--mcp-config` né `--hf-endpoint` con dati veri. Lasciare `--host 127.0.0.1` | Prima dell'uso con dati veri (fine Fase 1A) |
| Codex con provider locale invia telemetria o contenuti altrove? | Finché non è verificato non conta come locale | Task 1.16 |
| Codice clienti con NDA | Locale (L2) finché non leggi i contratti | Quando serve |
| Remote git (GitHub privato, NAS, nessuno) | NAS o nessuno all'inizio; la CI remota è facoltativa (D-018) | Quando serve |
| `pgvector` al posto di Qdrant | Un servizio in meno; Qdrant resta la scelta se Mem0 lo richiede | Inizio Fase 2 |
| Editor della knowledge base | Obsidian all'inizio | Fase 2 |
| Fonti e persone per il Mentor | Scegli 10-15 nomi e fonti primarie | Fase 5 |
| STT/TTS italiani | Provarne 2-3 locali con la tua voce | Inizio Fase 4 |
| Numero e operatore telefonico | Decidere dopo costi e qualità | Fase 4 |
| Licenza degli sprite di pixel-agents (JIK-A-4, Metro City) | Uso personale ok; sostituire con asset a licenza chiara prima di condividere la cartella | Fase 3 |
| Skill nel formato agentskills.io | Verificare compatibilità con Hermes, Claude Code e Codex (idea 7) | Task 1.9 |

## Idee dalla ricerca — da decidere

Fasi e ore come in `SPEC.md`, sezione "Idee dalla ricerca". Le ore non sono incluse nelle stime, salvo dove indicato. La colonna "Raccomandazione" è mia: la scelta resta tua.

| # | Idea | Fase | Ore | Raccomandazione |
| --- | --- | --- | --- | --- |
| 1 | Pattern Dual LLM / CaMeL | 2 | 12-20 | **Sì**, prima che il Segretario legga posta vera |
| 2 | Sandbox per gli agenti che eseguono codice | 1 | 6-10 | **Sì, già nel piano** (task 1.6, ore incluse): è parte del confinamento |
| 3 | DBOS per esecuzione durevole | 0-1 | 6-10 | **No per ora**: coda propria (D-004); si rivaluta a fine Fase 1 |
| 4 | Langfuse / Promptfoo / Inspect | 0-1 | 8-14 | **No per ora**: runner proprio e tabelle `runs` e `router_decisions` bastano; Langfuse si rivaluta con l'HUD |
| 5 | Funzioni native di Claude Code | 1 | 6-12 | **Rinviare** alla Fase 3: cambiano spesso e legano a un solo esecutore |
| 6 | Advisor tool nel router | 1 | 3-6 | **Rinviare**: è il piano B se il test 1.4 fallisce |
| 7 | Schede e procedure nel formato Skills più MCP | 1 | 4-8 | **Valutare dentro 1.9** senza ore in più; adozione piena in Fase 2 |
| 8 | Hermes Agent come harness | 1 | 10-20 | **No**: harness proprio sottile (task 1.10); la prova costerebbe più dell'harness |
| 9 | Scheduler deterministico | 1 | 4-8 | **Sì, quasi gratis**: `jobs.run_at` c'è già (D-004); le ricorrenze arrivano in Fase 2 |
| 10 | Fatture dall'XML FatturaPA | 2 | 8-14 | **Sì, per prima** (D-022): sostituisce l'OCR per le fatture |
| 11 | OCR e parsing locali | 2 | 10-18 | **Sì, dopo la 10**, solo per carta e scansioni; un solo strumento scelto con gli eval |
| 12 | Open banking PSD2 | 2+ | 15-30 | **No in v1**: i dati passano da un terzo |
| 13 | Memoria temporale con Graphiti | 5 | 20-35 | **No** finché una misura non lo chiede |
| 14 | Stack vocale locale pronto | 4 | 8-16 | Decidere all'inizio della Fase 4 (sostituisce lavoro) |
| 15 | Home Assistant via MCP | 3+ | 6-12 | Facoltativa, dopo la Fase 3 |
| 16 | Aggiornare e confrontare i modelli locali | 1 | 8-14 | **In parte già nel piano**: il test 1.4 è lo strumento; confronto completo solo se il Qwen attuale non passa |
| 17 | Ripasso FSRS con libreria | 5 | 8-15 | **Sì** (sostituisce lavoro) |
| 18 | Wiki compilato dal modello per il Mentor | 5 | 8-14 | Decidere in Fase 5 |

Scelta dell'utente: **non ancora fatta**.
