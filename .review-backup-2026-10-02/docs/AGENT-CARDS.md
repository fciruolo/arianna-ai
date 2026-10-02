# Schede agente

Ogni agente è una scheda YAML in `agents/<nome>.yaml` più un prompt in `agents/<nome>.md`. Il loader valida la scheda: se non rimuove almeno uno dei tre lati del "lethal trifecta" (dati privati, contenuti non fidati, comunicazione esterna) viene rifiutata.

## Formato

```yaml
name: archivista
description: Classifica, estrae e archivia documenti
max_label: L2            # livello massimo che può leggere
executors: [local]       # esecutori ammessi
tools: [kb.read, kb.write, db.query]
trifecta:
  private_data: true
  untrusted_content: false
  external_comms: false  # lato rimosso
autonomy: A1             # A0 suggerisce, A1 agisce con approvazione, A2 agisce e riferisce, A3 pieno
limits: { max_steps: 30, max_minutes: 20, max_cost: 0 }
approvals: [delete, send_external]
prompt: archivista.md
```

## Agenti iniziali

| Agente | Compito | Livello max | Esecutori | Lato rimosso |
| --- | --- | --- | --- | --- |
| Arianna (orchestratore) | Pianifica, assegna, riferisce | L2 | Locale | Comunicazione esterna |
| Coder | Scrive e modifica codice | L1 (L2 solo locale/Codex locale) | Claude Code, Codex, locale | Dati privati (nel caso cloud) |
| Reviewer | Rivede diff e test | L1 | Claude Code, locale | Comunicazione esterna |
| Archivista | Classifica e estrae documenti | L2 | Locale | Comunicazione esterna |
| Segretario | Bozze, agenda, promemoria | L2 | Locale | Invio senza approvazione |
| Ricercatore | Cerca sul web | L0 | Claude Code, locale | Dati privati |
| Mentor | Studio e ripasso | L1 | Locale, Claude Code | Dati privati |
| Ops | Server, deploy, backup | L1 | Locale, Claude Code | Contenuti non fidati |

## Autonomia

Livelli A0-A3; si parte da **A1** per tutti. Salita di livello solo per decisione dell'utente, per agente, registrata in `DECISIONS.md`.

## Pattern

Per agenti che devono leggere contenuti non fidati e dati privati insieme: Dual LLM (un modello isolato legge il contenuto non fidato e restituisce solo dati strutturati). Studio di CaMeL previsto fra le idee da scegliere.
