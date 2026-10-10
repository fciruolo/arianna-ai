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

Campi facoltativi: `cloud_max_label` (etichetta massima vista da un esecutore cloud), `autonomy_decision` (la decisione che ha alzato l'agente sopra A1) e `prompt_label` (L0 o L1, mai sopra `max_label`: l'etichetta del prompt; senza il campo un prompt di `agents/` vale L0, uno di `data/agents` L1, e una scheda di `agents/` la cui prima riga è quella della pagina Agenti L1; D-119 tappa T3b) ed `executor_choice` (solo `ask`, con almeno due esecutori: prima di ogni card dell'agente l'utente sceglie dove lavora, fra Claude Code, Codex e il modello locale ammessi per quella card; D-159). `prompt` è sempre `<nome>.md`, e `name` è il nome del file.

Regole di validazione (task 1.9, D-034), ognuna con un caso positivo e uno negativo in `packages/agents/test`:

- **Trifecta:** almeno un lato è `false`. Il trifecta dichiarato descrive l'agente quando lavora in locale. Un esecutore cloud apre da sé contenuti non fidati e comunicazione esterna (i suoi strumenti di shell e web, e l'essere un servizio cloud), qualunque sia la lista `tools`: lì dev'essere tolto il lato dei dati privati, con un tetto di etichetta al massimo L1 (`max_label` o `cloud_max_label`), che router e gateway impongono. Si assume che L0 e L1 non siano dati privati: i dati privati iniziano da L2.
- **Coerenza col livello:** con `max_label: L2` l'agente legge dati privati, quindi `private_data` dev'essere `true`.
- **Coerenza con gli strumenti:** ogni strumento del registro dichiara i lati che apre da solo (`web.search` e `web.fetch` aprono contenuti non fidati e comunicazione esterna, `channel.send` la comunicazione esterna); una scheda non può dichiarare tolto un lato che uno dei suoi strumenti apre.
- **Cloud:** `max_label: L2` con un esecutore cloud in `executors` richiede `cloud_max_label` al massimo L1 (caso del Coder); `cloud_max_label` senza esecutori cloud o sopra `max_label` è un errore.
- `max_label: L3` non esiste: nessun modello legge segreti.
- **Strumenti privati per natura** (`localOnly` nel registro: gli impegni della segretaria, D-144): solo in una scheda con `max_label` L2 che gira sul modello locale soltanto; con un esecutore cloud o con `max_label` L1 o L0 la scheda è rifiutata.
- **Approvazioni:** se uno strumento richiede un'approvazione (`file.delete` → `delete`, `channel.send` → `send_external`), la scheda deve elencarla in `approvals`. Azioni ammesse: `delete`, `send_external`, `payment`, `call`.
- **Autonomia:** A2 e A3 richiedono `autonomy_decision` con l'id della decisione dell'utente.
- Delegare a un agente cloud o scrivere su un canale esterno (Telegram, spento per ora per D-110) **è** comunicazione esterna: passa dal gateway come ogni uscita. `task.delegate` non apre il lato per chi delega perché il passo delegato gira in un contesto separato per task, che ha letto solo il brief: il contesto privato di chi delega non arriva dall'altra parte. Il gateway da solo non basterebbe come motivo (anche `channel.send` passa dal gateway, e apre il lato). L'esecutore che riceve il passo si giudica con la sua scheda. Da confermare (D-034). Nella chat diretta con il Coder (D-111) la premessa vale **per conversazione** invece che per passo: il run riprende con `--resume` la sessione della conversazione, che ha letto solo i messaggi dell'utente e le risposte del Coder di quella conversazione di lavoro (L1), mai il contesto di Arianna né di altre conversazioni.
- Strumenti fuori dall'elenco chiuso del registro (`packages/agents/src/tools.ts`) → scheda rifiutata. Chiavi sconosciute → scheda rifiutata. Una scheda non valida fa fallire il caricamento di tutta la cartella, e così un file che non sia `<nome>.yaml` o `<nome>.md`, un prompt senza scheda o un collegamento simbolico. Si leggono solo le chiavi proprie degli oggetti: `__proto__`, chiavi di merge `<<` e chiavi duplicate sono rifiutate.

## Registro degli strumenti

| Strumento | Apre | Approvazione |
| --- | --- | --- |
| `kb.read`, `kb.search`, `kb.write` | (i dati privati dipendono da `max_label`) | |
| `task.create`, `task.plan`, `task.update`, `task.delegate`, `user.ask` | | `task.plan`: approvazione del piano in chat, di tipo `plan` (D-159) |
| `repo.read`, `repo.write`, `repo.test` (nella cartella del progetto approvato, D-056 e D-058, o nella copia del run) | (`repo.test` non apre nulla solo perché la sandbox del task 1.6 blocca la rete anche all'esecutore locale) | |
| `file.delete` | | `delete` |
| `web.search`, `web.fetch` | contenuti non fidati, comunicazione esterna | |
| `channel.send` | comunicazione esterna | `send_external` |
| `commitment.add`, `commitment.list`, `commitment.done` (la segretaria, D-144) | (privati per natura: solo in una scheda con `max_label` L2 che gira sul modello locale soltanto) | conferma dell'utente in chat, di tipo `commitment` |

Gli schemi degli argomenti stanno in `TOOL_ARGS` di `packages/agents/src/protocol.ts` (task 1.10, D-053), insieme allo schema di risposta e al prompt di sistema che usano sia l'orchestratore sia gli eval. Uno strumento senza schema non viene offerto al modello. L'orchestratore oggi esegue `kb.search`, `kb.read`, `kb.write` (solo `kb/inbox/`), `task.create` (carta in Inbox) e `user.ask` (domanda in chat); `task.delegate` (D-055) è offerto solo quando un esecutore cloud è abilitato e disponibile, e manda il passo al Coder su `claude -p` (gli strumenti `repo.read`, `repo.write`, `repo.test` della scheda diventano `Read`/`Glob`/`Grep`, `Edit`/`Write`, `Bash`; `Bash` solo insieme a `repo.write`, D-140: la sandbox di `claude` lascia scrivere i comandi nella cartella). `task.update` (D-101) sposta una carta della conversazione e ci scrive una nota, mai il task in corso: è offerto solo se all'inizio del task la conversazione aveva una carta aperta (scelta fissata per tutto il task), con un id sconosciuto risponde con l'elenco delle carte aperte, e segue l'autonomia (A0 non sposta carte; A1 non mette carte in Pronti, salvo riprendere un'attesa che ha aperto lui). Gli strumenti degli impegni (D-144) sono offerti solo nella conversazione della segretaria, dove `task.delegate` non è offerto: `commitment.add` riceve le parole dell'utente per il giorno, che calcola il codice, e aspetta la conferma; `commitment.list` scrive l'elenco in chat dal database e chiude il task; `commitment.done` trova l'impegno aperto e aspetta la conferma. `task.plan` (D-159, mai nella conversazione della segretaria né in incognito) propone da 2 a 8 card con chi le fa (l'utente o un agente che può lavorare ora, gli stessi di `task.delegate`) e "bloccata da" come numeri di card precedenti del piano; il codice lo ricontrolla e scrive un'approvazione di tipo `plan`: le card nascono solo con "Crea le card", nella transazione della decisione, e la risposta di Arianna la scrive il codice.

**Card degli agenti (D-159).** Una card assegnata a un agente parte con "Avvia" sul cardwall o, se viene da un piano approvato, da sola. Il primo passo sceglie la strada: per un agente con esecutori cloud la strada della delega (la card stessa come richiesta, nel suo progetto approvato, sandbox, gateway e `cloud_max_label`; sopra il tetto del cloud la richiesta esce solo come testo declassato dall'utente), altrimenti il modello locale; con `executor_choice: ask` prima un'approvazione di tipo `executor` con le sole strade ammesse (un esecutore cloud solo se la card è entro il suo `cloud_max_label`, il progetto è approvato e l'esecutore è acceso; il locale se c'è un modello e la card è entro il `max_label` dell'agente; la scelta si ricontrolla quando la card gira). In locale la card non ha strumenti di file: l'agente descrive la proposta nella risposta. Il rapporto finisce nella card, che va in Da verificare.

## Agenti iniziali

| Agente | Compito | Livello max | Esecutori | Lato rimosso |
| --- | --- | --- | --- | --- |
| Arianna (orchestratore) | Pianifica, assegna, riferisce | L2 | Locale | Comunicazione esterna (le deleghe al cloud passano dal gateway, contesto per task) |
| Coder | Scrive e modifica codice | L1 nel cloud; L2 solo con modello locale | Claude Code, Codex, locale | Dati privati nel cloud (`cloud_max_label: L1`); comunicazione esterna in locale |
| Reviewer | Rivede diff e test con un modello diverso da chi ha scritto | L1 | Codex, Claude Code, locale | Comunicazione esterna |
| Designer | Disegna pagine e schermate come mockup HTML autonomi nel progetto | L1 nel cloud; L2 solo con modello locale | Claude Code, Codex, locale (sceglie l'utente a ogni card) | Dati privati nel cloud (`cloud_max_label: L1`); comunicazione esterna in locale |
| Archivista | Classifica e estrae documenti | L2 (L3 solo come riferimenti al vault) | Locale | Comunicazione esterna |
| Segretario | Bozze, agenda, promemoria | L2 | Locale | Invio senza approvazione; lettura di posta vera solo con Dual LLM |
| Ricercatore | Cerca sul web | L0 | Claude Code, Codex, locale | Dati privati |
| Mentor | Studio e ripasso | L1 | Locale, Claude Code | Dati privati |
| Ops | Server, backup, spazio disco, consumi | L1 | Locale | Contenuti non fidati |

In Fase 1A servono solo Arianna e Coder (`agents/arianna.yaml`, `agents/coder.yaml`); il Reviewer (`agents/reviewer.yaml`) è arrivato con Codex (D-140): Codex per primo, poi Claude Code, cartella del progetto in sola lettura (`repo.read`, `repo.test`, niente `repo.write`; su Claude Code senza `Bash`, quindi senza test), passo di tipo `review` per il router; il Designer (`agents/designer.yaml`, D-159) con la tappa C3 del cardwall: `repo.read`, `repo.write`, `task.update`, niente `repo.test` (su Claude Code quindi senza `Bash`), niente `kb.*` né rete, `executor_choice: ask`; scrive solo file HTML autonomi (CSS e JS in linea, immagini `data:`, nessuna risorsa remota) in `mockups/` del progetto (`docs/mockups/` nel repository di Arianna), varianti numerate, e legge il `DESIGN.md` del progetto se c'è; gli altri arrivano con le fasi che li usano.

## Agenti creati dall'utente

Dalla pagina Agenti (D-119, tappa T2) l'utente crea un agente da un modello di scheda (`CARD_TEMPLATES` di `packages/agents`: `code`, `web`, `answer`). Dalla tappa T3b il modello è solo un punto di partenza: l'utente sceglie i permessi dentro l'elenco ammesso (`checkUserPermissions` in `packages/agents/src/user.ts`): un esecutore fra modello locale (nessuno strumento: risponde soltanto) e Claude (`repo.read`, `repo.write`, `repo.test`, spuntabili uno per uno; `repo.test` lancia comandi solo insieme a `repo.write`, D-140), autonomia A0 (solo `repo.read`) o A1, passi da 1 a 50 e minuti da 1 a 45 (limiti anche del run di Claude), costo 0, difficoltà `normal`. Etichetta L1 e `prompt_label: L1`, trifecta calcolata (dati privati no, contenuti non fidati sì, comunicazione esterna no); una scheda di agency-agents (prima riga dell'importatore) resta L0 con `prompt_label: L0`. Le schede proposte da `pnpm agency:import` (D-079) nascono già dentro questo elenco (`proposeCard` con `agencyPreset`): permessi del punto di partenza `code` di `userPresets()` per le divisioni engineering e testing (Claude con `repo.read`, `repo.write`, `repo.test`, A1), `answer` per tutte le altre (modello locale senza strumenti, A0), comprese quelle del web finché una delega non esegue gli strumenti del web; sempre `max_label: L0` e `prompt_label: L0`, trifecta calcolata, costo 0, e la proposta è controllata con `checkUserPermissions(…, 'agency')` prima di essere scritta, così si copia in `data/agents` senza ritocchi. Prima di scrivere una scheda nuova, o una che cambia permessi o etichette, il core mostra la differenza (`POST /api/agents/prepare`, `/api/agents/:id/prepare`) e scrive solo con l'id di conferma, legato a quei file e alla scheda che sostituiscono, valido 10 minuti e una volta sola. Nome, descrizione e prompt valgono L1 per dichiarazione dell'utente e passano dallo scanner e dal confronto col vault. La scheda nasce in `data/agents/disattivati` (fuori da git), "Attiva" la sposta in `data/agents/attivi` e la mette subito fra gli agenti del core, "Disattiva" la toglie (una delega già pianificata per quell'agente si chiude come fallita). Finché sta in `data/agents` vale un **tetto** (`checkUserCeiling`), qualunque cosa dica il file: `max_label` al massimo L1, autonomia A0 o A1, niente `autonomy_decision`, niente approvazioni, niente `task.delegate` né `channel.send`; la scheda deve anche restare dentro l'elenco dei permessi ammessi (`checkUserPermissions`, al posto del vecchio confronto col modello). Una scheda che non rispetta queste regole, o che ha il nome di una scheda di `agents/`, non si carica e la pagina la mostra con il motivo. Il prompt di un agente utente va al cloud come L1, non L0 come i prompt in git. **Promuovere a ufficiale** sposta i due file in `agents/`, dove il tetto non vale più: solo dal clic dell'utente nella scheda di conferma (`confirm: true`), mai da un modello; `agents/` è in git, e la conferma lo dice.

**Tappa T3 (D-119).** L'agente si crea dalla pagina "Nuovo agente" (`/impostazioni/agenti/nuovo`, tre passi, personaggio scelto o caricato lì). Una scheda utente del modello `answer` legge fino a **L1** (`userLabelOf`): il suo prompt è testo dell'utente, L1 per dichiarazione, e un agente non legge sopra la sua clearance; `web` resta L0 e una scheda di agency-agents resta L0, perché il suo prompt è di terzi. Ogni agente dice dove lavora (`works`): `claude` per una scheda con l'esecutore `claude` (il modello `code`, sulla strada del Coder), `local` per una scheda senza strumenti (il modello `answer`, una chiamata al modello locale), nessuno per `web` finché mancano gli strumenti del web. Arianna gli delega lavoro con `task.delegate` quando è attivo (elenco dinamico, Coder per primo). Descrizione e prompt si modificano anche da attivo (la scheda si riscrive dal suo modello, quindi autonomia e limiti abbassati a mano tornano a quelli del modello); un agente disattivato si elimina scrivendone il nome, e i due file vanno in `data/agents/eliminati/<data>-<nome>/`, recuperabili a mano. "Riporta fra i miei" annulla una promozione solo per una scheda di `agents/` la cui prima riga è quella scritta dalla pagina (`USER_CARD_MARK`) e che rispetta ancora tetto e modello: Arianna, il Coder e le schede scritte a mano restano ufficiali.

## Personalità

Ogni agente (Arianna compresa) può avere una personalità in `[personas.<agente>]` di `config/arianna.toml` (D-107, tappa A1 rivista, D-107a2). È **stile e ruolo, mai permessi**: strumenti, `max_label`, `cloud_max_label`, trifecta, autonomia, approvazioni e limiti si leggono soltanto dalla scheda (`agents/<nome>.yaml`), il prompt di base resta intero in `agents/<nome>.md` con le sue regole e lo schema di risposta dipende solo dagli strumenti offerti.

| Campo | Valori | Etichetta |
| --- | --- | --- |
| `tone` | `serio` · `asciutto` · `equilibrato` (predefinito, non aggiunge nulla) · `caloroso` · `scherzoso` (senza argomenti tabù: approvazioni e avvisi sono testi del codice) | Frase fissa nostra, L0 |
| `address` | `tu` (predefinito) · `lei` | Frase fissa nostra, L0 |
| `display_name` | 1-24 caratteri: lettere, spazi, apostrofo, trattino; l'id dell'agente non cambia; **non per `arianna`**, che resta "Arianna" | Testo dell'utente, L1 |
| `traits` | Testo libero, al massimo 500 caratteri (a capo → spazio) | Testo dell'utente, L1 |
| `specialization` | Ruolo e competenze ("sviluppatore senior TypeScript, attento ai test"), al massimo 500 caratteri: **affina** il ruolo del `.md`, non lo sostituisce; vuoto, vale solo il `.md` | Testo dell'utente, L1 |

I testi dell'utente sono **L1 per sua dichiarazione** (2026-10-05, `PRIVACY-POLICY-SPEC.md`): valgono nelle conversazioni private e di lavoro e nelle deleghe cloud, mai per un agente o un task L0. Non c'è un campo `label`. Tipo, validazione (`parsePersona`), scarto per clearance (`personaParts`) e blocco del prompt (`personaBlock`) stanno in `packages/agents/src/persona.ts`; l'etichetta (`PERSONA_LABEL`) e il confronto con la clearance (`personaFits`) in `packages/policy`. Il divieto di rinominare Arianna sta in `packages/config` (`FIXED_NAMES`). Un file non valido scarta i testi e tiene tono e forma.

Il blocco va in coda al prompt di sistema, fra gli esempi e la regola del `thought`, così il prefisso in cache (D-075) non cambia: prima la specializzazione, poi nome e forma, tono, testo libero. Tag `<persona>`, `<specialization>` e `<tool_result>` nei testi sono neutralizzati e il blocco resta entro 1400 caratteri. Con i valori predefiniti (o con i testi scartati, `equilibrato` e `tu`) il blocco è vuoto e il prompt è identico byte per byte a quello senza personalità. Dalla chat web si modificano in Impostazioni → Agenti (tappa A2, D-107f; la pagina riunisce personaggio, personalità e modello di ogni agente, D-116): sezione ordinaria, salvata subito, con l'avviso fisso sotto i campi, contatori, stima del costo a passo ed esempio del tono; il core rifiuta un testo in cui lo scanner trova qualcosa (IBAN, codice fiscale, carta, chiave, token) o che contiene un valore del vault, nominando il campo e mai il testo. Il passaggio del blocco all'orchestratore, alle deleghe e alla voce è la tappa A3. Nella stessa pagina `[agents.<id>] model` di `arianna.toml` dà il modello cloud con cui parte una conversazione nuova con l'agente (D-116): un'impostazione ordinaria, non un permesso; può essere solo un modello di un esecutore cloud della scheda, mai per Arianna.

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
