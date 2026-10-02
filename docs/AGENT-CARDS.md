# Schede agente

Ogni agente è una scheda YAML in `agents/<nome>.yaml` più un prompt in `agents/<nome>.md`; loader e validazione stanno in `packages/agents`. Il loader valida la scheda: se non rimuove almeno uno dei tre lati del "lethal trifecta" (dati privati, contenuti non fidati, comunicazione esterna) viene rifiutata.

## Formato

```yaml
name: archivista
description: Classifica, estrae e archivia documenti
max_label: L2            # clearance massima; L3 mai: solo riferimenti vault://
executors: [local]       # esecutori ammessi
tools: [kb.read, kb.write, db.query]
trifecta:
  private_data: true
  untrusted_content: false
  external_comms: false  # lato rimosso
autonomy: A1             # A0 propone soltanto, A1 agisce in sandbox, A2 esegue azioni reversibili, A3 anche azioni esterne avvisando dopo
difficulty: normal       # valore predefinito per il router
limits: { max_steps: 30, max_minutes: 20, max_cost: 0 }
approvals: [delete, send_external]
prompt: archivista.md
```

Regole di validazione oltre al trifecta:

- `max_label: L2` con un esecutore cloud in `executors` è ammesso solo se la scheda dichiara che il cloud si usa con `effective_label ≤ L1` (caso del Coder); il router lo impone comunque.
- `max_label: L3` non esiste: nessun modello legge segreti.
- Delegare a un agente cloud o scrivere su Telegram **è** comunicazione esterna: passa dal gateway come ogni uscita.
- Strumenti fuori dall'elenco chiuso del registro → scheda rifiutata.

## Agenti iniziali

| Agente | Compito | Livello max | Esecutori | Lato rimosso |
| --- | --- | --- | --- | --- |
| Arianna (orchestratore) | Pianifica, assegna, riferisce | L2 | Locale | Comunicazione esterna (le deleghe al cloud passano dal gateway, contesto per task) |
| Coder | Scrive e modifica codice | L1 nel cloud; L2 solo con modello locale | Claude Code, Codex, locale | Dati privati (nel caso cloud) |
| Reviewer | Rivede diff e test con un modello diverso da chi ha scritto | L1 | Codex, Claude Code, locale | Comunicazione esterna |
| Archivista | Classifica e estrae documenti | L2 (L3 solo come riferimenti al vault) | Locale | Comunicazione esterna |
| Segretario | Bozze, agenda, promemoria | L2 | Locale | Invio senza approvazione; lettura di posta vera solo con Dual LLM |
| Ricercatore | Cerca sul web | L0 | Claude Code, Codex, locale | Dati privati |
| Mentor | Studio e ripasso | L1 | Locale, Claude Code | Dati privati |
| Ops | Server, backup, spazio disco, consumi | L1 | Locale | Contenuti non fidati |

In Fase 1A servono solo Arianna e Coder; Reviewer arriva con Codex in 1B, gli altri con le fasi che li usano.

## Autonomia

| Livello | Cosa può fare |
| --- | --- |
| A0 | Propone soltanto |
| A1 | Agisce in sandbox (worktree, cartella dedicata); crea carte solo in Inbox |
| A2 | Esegue azioni reversibili fuori dalla sandbox; può mettere carte in Pronti |
| A3 | Esegue anche azioni visibili all'esterno, avvisando dopo |

Si parte da **A1** per tutti. Le azioni irreversibili chiedono approvazione a ogni livello. Salita di livello solo per decisione dell'utente, per agente, registrata in `DECISIONS.md`.

## Pattern

Per agenti che devono leggere contenuti non fidati e dati privati insieme: Dual LLM (un modello isolato legge il contenuto non fidato e restituisce solo dati strutturati). È un prerequisito per il Segretario che legge posta vera (Fase 2, idea 1).
