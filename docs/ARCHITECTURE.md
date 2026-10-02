# Architettura

Sintesi operativa della sezione "Architettura" di `SPEC.md`. In caso di conflitto fra documenti vale D-013.

```
 Interfacce    chat web (VPN) · HUD · ufficio pixel      Telegram · telefono
               canali locali, fino a L2                  canali esterni, fino a L1
                      │                                         ▲
 Nucleo        apps/core: API e WebSocket · task e run · orchestratore · coda · registro eventi
                      │                                         │
 Controllo     packages/router ──► packages/policy: etichette, clearance, taint
                      │                      │
                      │               GATEWAY: unica uscita, registra tutto
                      ▼                      ▼
 Esecutori     modello locale         claude -p · codex exec · web · canali esterni
               L0-L2                  solo L0-L1, in worktree confinato
```

## Componenti

| Componente | Ruolo | Dove |
| --- | --- | --- |
| Core | API, WebSocket eventi, task, orchestratore, coda e scheduler | `apps/core` |
| Policy / gateway | Etichette, taint, clearance, unica uscita, log di ciò che esce | `packages/policy` |
| Router | Sceglie esecutore e modello per ogni passo (funzione pura) | `packages/router` |
| Esecutori | Adattatori: modello locale, `claude -p`, `codex exec`; profilo di confinamento | `packages/executors` |
| Agenti | Loader e validazione delle schede | `packages/agents` |
| Configurazione | `ARIANNA_HOME`, `arianna.toml`, manifest dei modelli; unico punto che legge la configurazione | `packages/config` |
| Valutazione | Runner degli eval a tre livelli; i casi stanno in `evals/` | `packages/evals` |
| Schede agente | YAML + prompt | `agents/` |
| HUD / ufficio pixel / cardwall | Interfaccia Vue 3 + Tailwind | `apps/hud` |
| Voce | Servizio Python (Pipecat), VAD/STT/TTS locali | `apps/voice` |
| Memoria | Archivio originali, KB markdown, Qdrant + Mem0 | `data/`, servizi |
| Database | PostgreSQL: task, eventi, coda, audit | servizio Docker |

## Flusso di una richiesta

1. Arriva un messaggio (chat, voce, evento pianificato) in una conversazione di lavoro (clearance L1) o privata (L2) → il core crea un task con etichetta e clearance.
2. L'orchestratore locale pianifica passi con strumenti a schema vincolato, in un contesto dedicato a quel task.
3. Per ogni passo il router applica: filtro privacy → filtro budget → difficoltà a regole → scelta con scalata.
4. L'esecutore scelto lavora in un run. Se è cloud: brief controllato dal gateway, worktree confinato, strumenti MCP che conoscono la clearance.
5. Il risultato torna con l'etichetta derivata dagli input (taint) e aggiorna `effective_label` di run, task e conversazione.
6. Ogni evento va nel registro (append-only, catena di hash) e sul WebSocket verso HUD e cardwall.
7. Azioni esterne o irreversibili e declassamenti si fermano in "Attende te" finché non approvati.

## Livelli di orchestrazione

- **Livello 1** codice deterministico: coda, scadenze, limiti, approvazioni, router, gateway.
- **Livello 2** modello locale: giudizio con strumenti a schema vincolato.
- **Livello 3** lavoro di coding affidato a processi Claude Code / Codex.

## Struttura del repository

```
arianna/
  apps/core  apps/hud  apps/voice
  packages/policy  packages/router  packages/executors  packages/agents
  packages/config  packages/evals
  agents/        # schede agente (YAML + prompt)
  evals/         # casi di valutazione
  kb/            # knowledge base di esempio, solo dati finti (in git)
  config/        # arianna.toml, labels.toml, manifest e catalogo modelli
  docs/  .claude/  scripts/
  data/          # modelli, db, archivio, kb vera, vault, worktree (fuori da git)
```

`kb/` è il campione finto usato da test ed eval; la knowledge base vera vive in `data/kb/` e nasce solo dopo il criterio della Fase 1A.

## Principi di confine

- Ogni esecutore è dietro un'interfaccia: sostituibile (oMLX → altro runtime, Mac Studio → server).
- Nessun componente parla con l'esterno senza passare dal gateway: esecutori cloud, web, Telegram, telefono.
- Policy e router non fanno I/O: ricevono dati etichettati e restituiscono decisioni. Per questo si testano al 100% senza modelli.
- Il terzo lato del "lethal trifecta" è tolto per scheda agente (vedi `AGENT-CARDS.md`).
