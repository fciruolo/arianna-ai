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

Significato dei campi meno ovvi:

- `limits.max_cost`: spesa extra massima per task, in euro, oltre gli abbonamenti (API a consumo, servizi a pagamento). L'uso degli abbonamenti (`claude -p`, `codex exec`) e del modello locale conta zero; le quote degli abbonamenti le gestisce il router (`ROUTER-SPEC.md`). Quindi `0` vuol dire "nessuna spesa a pagamento", non "senza tetto".
- `approvals`: le azioni che l'agente **può chiedere** di fare, ognuna sempre con l'approvazione dell'utente. Una richiesta di approvazione per un'azione fuori elenco viene rifiutata (task 1.8). Ogni strumento che richiede un'approvazione la deve trovare qui.

Campi facoltativi: `cloud_max_label` (etichetta massima vista da un esecutore cloud) e `autonomy_decision` (la decisione che ha alzato l'agente sopra A1). `prompt` è sempre `<nome>.md`, e `name` è il nome del file.

Regole di validazione (task 1.9, D-034), ognuna con un caso positivo e uno negativo in `packages/agents/test`:

- **Trifecta:** almeno un lato è `false`. Il trifecta dichiarato descrive l'agente quando lavora in locale. Un esecutore cloud apre da sé contenuti non fidati e comunicazione esterna (i suoi strumenti di shell e web, e l'essere un servizio cloud), qualunque sia la lista `tools`: lì dev'essere tolto il lato dei dati privati, con un tetto di etichetta al massimo L1 (`max_label` o `cloud_max_label`), che router e gateway impongono. Si assume che L0 e L1 non siano dati privati: i dati privati iniziano da L2.
- **Coerenza col livello:** con `max_label: L2` l'agente legge dati privati, quindi `private_data` dev'essere `true`.
- **Coerenza con gli strumenti:** ogni strumento del registro dichiara i lati che apre da solo (`web.search` e `web.fetch` aprono contenuti non fidati e comunicazione esterna, `channel.send` la comunicazione esterna); una scheda non può dichiarare tolto un lato che uno dei suoi strumenti apre.
- **Cloud:** `max_label: L2` con un esecutore cloud in `executors` richiede `cloud_max_label` al massimo L1 (caso del Coder); `cloud_max_label` senza esecutori cloud o sopra `max_label` è un errore.
- `max_label: L3` non esiste: nessun modello legge segreti.
- **Approvazioni:** se uno strumento richiede un'approvazione (`file.delete` → `delete`, `channel.send` → `send_external`), la scheda deve elencarla in `approvals`. Azioni ammesse: `delete`, `send_external`, `payment`, `call`.
- **Autonomia:** A2 e A3 richiedono `autonomy_decision` con l'id della decisione dell'utente.
- Delegare a un agente cloud o scrivere su Telegram **è** comunicazione esterna: passa dal gateway come ogni uscita. `task.delegate` non apre il lato per chi delega perché il passo delegato gira in un contesto separato per task, che ha letto solo il brief: il contesto privato di chi delega non arriva dall'altra parte. Il gateway da solo non basterebbe come motivo (anche `channel.send` passa dal gateway, e apre il lato). L'esecutore che riceve il passo si giudica con la sua scheda. Da confermare (D-034).
- Strumenti fuori dall'elenco chiuso del registro (`packages/agents/src/tools.ts`) → scheda rifiutata. Chiavi sconosciute → scheda rifiutata. Una scheda non valida fa fallire il caricamento di tutta la cartella, e così un file che non sia `<nome>.yaml` o `<nome>.md`, un prompt senza scheda o un collegamento simbolico. Si leggono solo le chiavi proprie degli oggetti: `__proto__`, chiavi di merge `<<` e chiavi duplicate sono rifiutate.

## Registro degli strumenti

| Strumento | Apre | Approvazione |
| --- | --- | --- |
| `kb.read`, `kb.search`, `kb.write` | (i dati privati dipendono da `max_label`) | |
| `task.create`, `task.update`, `task.delegate`, `user.ask` | | |
| `repo.read`, `repo.write`, `repo.test` (nella cartella del progetto approvato, D-056 e D-058, o nella copia del run) | (`repo.test` non apre nulla solo perché la sandbox del task 1.6 blocca la rete anche all'esecutore locale) | |
| `file.delete` | | `delete` |
| `web.search`, `web.fetch` | contenuti non fidati, comunicazione esterna | |
| `channel.send` | comunicazione esterna | `send_external` |

Gli schemi degli argomenti stanno in `TOOL_ARGS` di `packages/agents/src/protocol.ts` (task 1.10, D-053), insieme allo schema di risposta e al prompt di sistema che usano sia l'orchestratore sia gli eval. Uno strumento senza schema non viene offerto al modello. L'orchestratore oggi esegue `kb.search`, `kb.read`, `kb.write` (solo `kb/inbox/`), `task.create` (carta in Inbox) e `user.ask` (domanda in chat); `task.delegate` (D-055) è offerto solo quando un esecutore cloud è abilitato e disponibile, e manda il passo al Coder su `claude -p` (gli strumenti `repo.read`, `repo.write`, `repo.test` della scheda diventano `Read`/`Glob`/`Grep`, `Edit`/`Write`, `Bash`). `task.update` (D-101) sposta una carta della conversazione e ci scrive una nota, mai il task in corso: è offerto solo se all'inizio del task la conversazione aveva una carta aperta (scelta fissata per tutto il task), con un id sconosciuto risponde con l'elenco delle carte aperte, e segue l'autonomia (A0 non sposta carte; A1 non mette carte in Pronti, salvo riprendere un'attesa che ha aperto lui).

## Agenti iniziali

| Agente | Compito | Livello max | Esecutori | Lato rimosso |
| --- | --- | --- | --- | --- |
| Arianna (orchestratore) | Pianifica, assegna, riferisce | L2 | Locale | Comunicazione esterna (le deleghe al cloud passano dal gateway, contesto per task) |
| Coder | Scrive e modifica codice | L1 nel cloud; L2 solo con modello locale | Claude Code, Codex, locale | Dati privati nel cloud (`cloud_max_label: L1`); comunicazione esterna in locale |
| Reviewer | Rivede diff e test con un modello diverso da chi ha scritto | L1 | Codex, Claude Code, locale | Comunicazione esterna |
| Archivista | Classifica e estrae documenti | L2 (L3 solo come riferimenti al vault) | Locale | Comunicazione esterna |
| Segretario | Bozze, agenda, promemoria | L2 | Locale | Invio senza approvazione; lettura di posta vera solo con Dual LLM |
| Ricercatore | Cerca sul web | L0 | Claude Code, Codex, locale | Dati privati |
| Mentor | Studio e ripasso | L1 | Locale, Claude Code | Dati privati |
| Ops | Server, backup, spazio disco, consumi | L1 | Locale | Contenuti non fidati |

In Fase 1A servono solo Arianna e Coder (`agents/arianna.yaml`, `agents/coder.yaml`); Reviewer arriva con Codex in 1B, gli altri con le fasi che li usano.

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
