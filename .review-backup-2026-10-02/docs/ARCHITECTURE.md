# Architettura

Sintesi operativa della sezione "Architettura" di `SPEC.md`.

## Componenti

| Componente | Ruolo | Dove |
| --- | --- | --- |
| Core | API, WebSocket eventi, task, orchestratore, scheduler | `apps/core` |
| Policy / gateway | Etichette di privacy, unica uscita verso il cloud, log di ciò che esce | `packages/policy` |
| Router | Sceglie esecutore e modello per ogni passo | `packages/router` |
| Agenti | Schede YAML + prompt, loader e validazione | `packages/agents` |
| Esecutori | Adattatori: modello locale, `claude -p`, `codex exec` | `packages/executors` |
| HUD / ufficio pixel / cardwall | Interfaccia Vue 3 + Tailwind | `apps/hud` |
| Voce | Servizio Python (Pipecat), VAD/STT/TTS locali | `apps/voice` |
| Memoria | Archivio originali, KB markdown in git, Qdrant + Mem0 | `kb/`, servizi |
| Database | PostgreSQL: task, eventi, coda, audit | servizio Docker |

## Flusso di una richiesta

1. Arriva un messaggio (chat, voce, evento pianificato) → il core crea un task con etichetta di privacy.
2. L'orchestratore locale pianifica passi con strumenti a schema vincolato.
3. Per ogni passo il router applica: filtro privacy → filtro budget → stima difficoltà locale → scelta con fallback.
4. L'esecutore scelto lavora; se il passo è cloud, passa dal gateway che blocca L2/L3 e registra cosa esce.
5. Ogni evento va nel registro (append-only) e sul WebSocket verso HUD e cardwall.
6. Azioni esterne o irreversibili si fermano in "Attende te" finché non approvate.

## Livelli di orchestrazione

- **Livello 1** codice deterministico: coda, scadenze, limiti, approvazioni.
- **Livello 2** modello locale: giudizio con strumenti a schema vincolato.
- **Livello 3** lavoro di coding affidato a processi Claude Code / Codex.

## Struttura del repository

```
arianna/
  apps/core  apps/hud  apps/voice
  packages/policy  packages/router  packages/agents  packages/executors
  kb/            # dati finti in sviluppo
  agents/        # schede agente (YAML + prompt)
  evals/         # casi di valutazione
  docs/  .claude/  scripts/  config/
  data/          # modelli, db, archivio, kb, vault (fuori da git)
```

## Principi di confine

- Ogni esecutore è dietro un'interfaccia: sostituibile (oMLX → altro runtime, Mac Studio → server).
- Nessun componente parla col cloud senza passare dal gateway.
- Il terzo lato del "lethal trifecta" è tolto per scheda agente (vedi `AGENT-CARDS.md`).
