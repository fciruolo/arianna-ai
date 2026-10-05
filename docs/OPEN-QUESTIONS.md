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
| Conferma delle decisioni della notte del 2026-10-05 (D-077, D-079 prima parte, D-080 prima parte, D-081…D-087) | Rileggerle in `DECISIONS.md`: sono applicate ma da confermare | Prossima sessione con l'utente |

### Domande delle proposte della notte del 2026-10-05

Testo, alternative e raccomandazioni in `docs/PROPOSTE.md`; qui solo l'elenco.

| Proposta | Domanda | Stato |
| --- | --- | --- |
| D-078 Sviluppo da dentro Arianna | 1. Clone separato del repository sotto la home come progetto L1, con le modifiche portate solo con `git pull`? | Aperta |
| D-078 | 2. Una sola memoria di sviluppo (tutto nel clone) o un file distinto per la scheda? | Aperta |
| D-078 | 3. Scheda nuova `developer` o il `coder` con una regola in più? | Aperta |
| D-078 | 4. Chi fa il commit nel clone? | Aperta |
| D-078 | 5. Una sola delega attiva sul progetto di sviluppo? | Aperta |
| D-078 | 6. Quando cominciare? | Aperta |
| D-078 | 7. Chi lancia `pnpm check` completo dopo un run? | Aperta |
| D-079 Catalogo "Agenzia" | 1. Catalogo come proposto (clone fissato, importatore, schede attive solo con approvazione)? | Prima parte applicata, da confermare |
| D-079 | 2. Chi fa il clone e quando? | Aperta |
| D-079 | 3. Tetto delle schede adottate: L1 o L0? | Aperta |
| D-079 | 4. Autonomia delle schede adottate: A0 o A1? | Aperta |
| D-079 | 5. Schede approvate in `agents/` o fuori da git? | Aperta |
| D-079 | 6. Quali divisioni servono? | Aperta |
| D-079 | 7. Pagina "Agenzia" nelle Impostazioni o in chat? | Aperta |
| D-080 Second brain | 1. Tutto nasce L2 in `kb/inbox/` e si abbassa solo con approvazione? | Applicata così, da confermare |
| D-080 | 2. L'Archivista propone e l'utente approva, o sposta da solo? | Aperta |
| D-080 | 3. Primo ingresso da costruire? | Scelto "/nota" da Claude, da confermare; l'utente vuole come ingresso principale la pagina "Pensieri" |
| D-080 | 4. Declassificazione a L0 per singolo URL prima di scaricare un link? | Aperta |
| D-080 | 5. `pdfjs-dist` in un processo figlio per i PDF? | Aperta |
| D-080 | 6. Vocali e video: entrypoint in `apps/voice` o app Python a sé? | Aperta |
| D-080 | 7. Video di piattaforme solo come link, titolo e riassunto? | Aperta |
| D-088 Pulsante "Aggiorna" | Come si porta il codice nuovo dallo sviluppo all'installazione? | Proposta, da discutere |

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
