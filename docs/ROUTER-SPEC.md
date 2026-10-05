# Specifica del router

## Pipeline di scelta

1. **Filtro privacy:** se `effective_label` del run (incluse contaminazioni) è L2/L3 → solo esecutori con `locality = local`. La località viene dalla configurazione dell'endpoint, non dal nome del binario.
2. **Filtro budget:** esclude esecutori il cui tetto (passi, tempo, costo/quota) è esaurito.
3. **Stima difficoltà (D-020):** in Fase 1 è deterministica: valore predefinito della scheda agente, corretto da regole semplici (numero di file coinvolti, parole chiave, tentativi falliti). Scala: `trivial | normal | hard | critical`. Un classificatore con modello locale si aggiunge solo se i dati di `router_decisions` mostrano che le regole sbagliano: ogni chiamata in più al modello grande costa secondi su questo hardware.
4. **Scelta:** tabella di mappatura sotto; se l'esito è insufficiente (test falliti, revisione negativa) si **scala**: Sonnet → Opus → Fable.
5. Ogni decisione è registrata con motivo e candidati scartati (spiegabile in HUD).

Il router è una funzione pura (`route(step, context, budget, config) → decisione`): si testa senza modelli e senza rete.

## Mappatura iniziale (da calibrare con gli eval)

| Tipo di passo | Difficoltà | Esecutore |
| --- | --- | --- |
| Estrazione, classificazione, riassunto di L2 | qualsiasi | Locale (modello piccolo) |
| Pianificazione, giudizio su L2 | qualsiasi | Locale (modello grande) |
| Coding L0/L1 | trivial/normal | Claude Code, Sonnet |
| Coding L0/L1 | hard | Claude Code, Opus (o Codex) |
| Coding, revisione o architettura L0/L1 | critical | Fable, dietro approvazione di budget |
| Coding su codice L2 | qualsiasi | Modello locale; Codex con provider locale solo dopo verifica (vedi `PRIVACY-POLICY-SPEC.md`) |

I nomi dei modelli sono alias in `arianna.toml` (`sonnet`, `opus`, `fable`, `local-large`, `local-small`), mai cablati nel codice. Codex ha l'alias `codex` (il modello predefinito del binario).

## Come è fatto (task 1.7, D-040)

`route(step, context, budget, config)` in `packages/router` (`@arianna/router`), senza I/O, modelli né orologio.

- **Ingressi.** `step`: tipo (`extract`, `classify`, `summarize`, `plan`, `judge`, `coding`, `review`), scheda dell'agente, testo per le parole chiave, numero di file, tentativi falliti (`tests-failed`, `review-negative`, `stuck`), budget di Fable già approvato. `context`: il contesto della policy del run; un oggetto non creato dalla policy vale L2. `budget.blocked`: esecutori o singoli modelli fermi per tetto proprio (`cap`) o per errore di quota del binario (`quota`), con l'ora prevista di ritorno se nota (ISO 8601 con fuso, normalizzata in UTC). `config`: i candidati installati (`esecutore`, alias, località), validati da `createRouterConfig` (`claude` e `codex` sempre cloud, alias sull'esecutore giusto); una configurazione non creata da lì viene validata a ogni chiamata, e `claude`/`codex` contano comunque come cloud. Tentativi e blocchi con esecutori o modelli sconosciuti sono rifiutati. Il passo di un agente utente che risponde soltanto (modello `answer`, D-119 tappa T3) è un `judge`: modello locale grande, con il controllo dell'etichetta del brief contro la clearance dell'agente; il passo di un agente `code` è un `coding`, come per il Coder.
- **Privacy.** Un candidato cloud passa solo se `effective_label` è al massimo L1 e al massimo `cloud_max_label` della scheda (o `max_label` se manca). Un'etichetta sopra `max_label` dell'agente porta a "Attende te".
- **Difficoltà.** Valore della scheda; una parola chiave banale (refuso, rinomina, README, commento, formattazione) abbassa `normal` a `trivial` se tocca al massimo un file; una parola chiave difficile (architettura, migrazione, sicurezza, concorrenza, crittografia) o almeno 10 file alzano ad almeno `hard`; ogni tentativo fallito alza di un livello. Il testo del passo non finisce mai nella decisione.
- **Scale di modelli.** Estrazione, classificazione e riassunto: `local-small`, poi `local-large`. Pianificazione e giudizio: `local-large`. Coding: `sonnet`, poi `opus` o `codex`, poi `fable`. Revisione: `codex` o `sonnet`, poi `opus`, poi `fable`. Coding e revisione usano la scala cloud solo se privacy e scheda permettono almeno un candidato cloud installato; altrimenti `local-large`. Il gradino di partenza dipende dalla difficoltà senza contare i tentativi falliti (`trivial`/`normal` il primo, `hard` il secondo, `critical` il terzo, nei limiti della scala); se nei gradini fino a lì la scheda o la privacy non lasciano nessun candidato installato, si parte dal primo gradino che ne ha uno (per esempio un agente con solo Codex parte da Codex).
- **Scalata.** Dopo un tentativo fallito non si torna mai su un gradino pari o inferiore a quello fallito: si va al gradino successivo, anche quando il tentativo era già sceso per budget (Sonnet fallito → Opus, non Fable). La difficoltà registrata conta i fallimenti. Finita la scala, "Attende te". Il lavoro L2 non sale mai al cloud.
- **Budget e modelli mancanti.** Un modello fermo o non installato è sostituito da un'alternativa dello stesso gradino o da un gradino più basso (mai più alto, che costa di più) e mai dal modello locale: il lavoro cloud fermo aspetta. Un candidato torna disponibile quando cadono tutti i blocchi che lo riguardano. Se a fermare tutto è il budget e c'è un'ora di ritorno, `wait` con `retry-later` alla prima ora; altrimenti `wait-user`.
- **Fable** chiede sempre l'approvazione di budget (`approval: 'budget'`), salvo che il passo l'abbia già.
- **Registro.** Ogni decisione elenca tutti i candidati configurati con l'esito: scelto, oppure escluso per `not-for-step`, `privacy`, `agent`, `escalation`, `cap`, `quota`, `not-chosen`. Quando coding o revisione ripiegano sul modello locale, i candidati cloud risultano esclusi per `privacy` o `agent` e il motivo lo dice (`cloud excluded: privacy`). Il core la scrive in `router_decisions` con `recordRouteDecision` (`apps/core/src/router-log.ts`) prima di agire.
- **Modello scelto dall'utente (1.10, D-055).** `step.preferredModel` è il modello che l'utente ha scelto per la conversazione di lavoro (selettore nella chat, `conversations.model`): viene preso quando è un candidato installato del passo che privacy, scheda, budget e scalata non escludono, anche se la scala avrebbe scelto un modello più debole; altrimenti decide la scala e il motivo lo dice (`preferred opus excluded: privacy`). Fable scelto dall'utente chiede comunque l'approvazione di budget.
- **Chat di sistema con Claude (D-064, seconda parte).** In una chat di sistema di lavoro l'utente sceglie chi risponde (`conversations.model`: `NULL` Arianna in locale, `sonnet` o `opus` Claude). Il passo non chiede la scala, perché il modello l'ha scelto l'utente, e non scrive in `router_decisions`; restano i filtri che il router applicherebbe: Claude solo se è in `[cloud] executors` e il modello non è spento in `[cloud.models]` (altrimenti risponde Arianna; D-071), etichetta del task e della conversazione al massimo L1 (vincolo `runs_cloud_at_most_l1` e gateway), blocchi di quota da `budgetOf` (il passo aspetta il ritorno con `retry`). Fable non è fra le scelte: chiede l'approvazione di budget a ogni passo.
- **Collegamento (1.10, D-055):** `routerConfigOf` (`apps/core/src/orchestrator/routing.ts`) costruisce `config` dai ruoli di `arianna.toml` (alias locali assegnati) e da `[cloud] executors` (`claude` → `sonnet`, `opus`, `fable`, senza gli alias spenti in `[cloud.models]`, D-071; Codex non è candidato finché non ha l'adattatore, 1.16); un modello scelto per la conversazione ma spento finisce nelle note come `preferred <alias> not installed` e decide la scala. Il nome esatto di `[cloud.models]` (es. `opus = "claude-opus-5-5"`, sempre della famiglia dell'alias, così `sonnet` non può far girare Fable senza l'approvazione di budget) va solo a `--model` (`modelName` di `createClaudeExecutor`, letto a ogni lancio): router, `runs` e `router_decisions` vedono sempre l'alias, e l'evento `executor.model` (L0) registra all'avvio di ogni run l'alias e il modello che il binario dice di usare; una chat di sistema nuova parte da Sonnet, o da Opus se Sonnet è spento, altrimenti risponde Arianna; il modello delle conversazioni di lavoro nuove è quello del Coder in `[agents.coder] model` (D-116; il vecchio `default` di `[cloud.models]` si legge come tale), finché la scheda dell'agente lo consente ed è selezionabile, e arriva al router come `preferredModel` attraverso `conversations.model`; `budgetOf` costruisce il budget dagli eventi `executor.quota` (bloccato fino a `resetsAt`, o per un'ora senza). `wait`/`retry-later` diventa un esito `retry` del motore (stesso passo riaccodato a `retryAt`), `approval: budget` un'approvazione `budget` in chat, `wait-user` un errore dello strumento che Arianna legge.

## Adattatori degli esecutori (`packages/executors`)

| Esecutore | Invocazione | Note |
| --- | --- | --- |
| Locale | API compatibile OpenAI verso oMLX (`createLocalModel`, task 1.3) | Interfaccia sostituibile `LocalModel`; solo endpoint di loopback; endpoint in ordine di preferenza con ripiego sul successivo se il server è giù, bloccato o in errore 5xx; `Watchdog` con controllo di salute e riavvio automatico (D-033) |
| Claude Code | `claude -p` con `--output-format stream-json`, `--resume`, `--tools` / `--allowedTools` / `--permission-mode dontAsk`, `--model` (`createClaudeExecutor`, task 1.5, D-049) | Non usare `--bare`; solo binario ufficiale; nessun token estratto; sempre con il profilo di confinamento; parte solo se `claude` è in `[cloud] executors`, con un brief `allow` del gateway e una cartella di `prepareWorkspace`, `openRepository` (D-056) o `prepareEmptyWorkspace` (cartella vuota per Claude che risponde a una chat di sistema senza strumenti, D-064); prompt su stdin |
| Codex | `codex exec --json` con accesso ChatGPT | Su server headless: device-code, credenziali nel keyring; stesso profilo di confinamento |

Interfaccia comune: `start(brief, workspace, limits) → flusso di eventi`, `resume(sessionRef)`, `cancel()`. Il `sessionRef` è l'id di sessione restituito dal binario, mai una credenziale. Per `claude` (D-049): `start({ brief, workspace, model, tools, limits, onEvent, signal })` e `resume({ ..., sessionRef })` restituiscono `{ result, cancel }`; gli eventi sono `init` (sessione, modello, strumenti), `text`, `tool` (solo il nome), `usage`, `rate-limit`; un errore porta il tipo (`quota`, `timeout`, `cancelled`, `max-turns`, `profile`, `execution`, `exit`, `bad-output`…), la sessione per riprendere, l'ora di ritorno della quota e i consumi. La ripresa va fatta nella stessa cartella: il binario tiene le sessioni per cartella.

## Budget e quote

Le quote degli abbonamenti non sono interrogabili: il router le stima e reagisce.

- **Contabilità propria:** ogni run registra durata, passi e token riportati dal flusso; i tetti in `arianna.toml` valgono per task e per finestra mobile (giorno, settimana).
- **Reazione ai limiti:** l'errore di quota del binario è un esito previsto dal test di contratto; il router mette il task in attesa con ripresa pianificata o scende di modello, e avvisa.
- **Misura dal binario (D-049):** `claude -p` riporta a ogni run un `rate_limit_event` con la finestra (`five_hour`, `seven_day`), la percentuale usata e l'ora di ritorno; il core lo scrive come evento `executor.rate_limit`, e un rifiuto come `executor.quota` con `resetsAt`. Il `Budget` del router (1.10) si costruisce da questi eventi.
- Fable solo dietro approvazione di budget.

## Vincoli sugli abbonamenti

Solo binari ufficiali non modificati, uso personale, mai estrarre o salvare token OAuth. La documentazione Anthropic raccomanda API key per l'Agent SDK; un credito separato per `claude -p` dal 15 giugno 2026 è riportato solo da fonti secondarie: **da verificare nel tuo account prima del task 1.5** (vedi `OPEN-QUESTIONS.md`).

## Test di contratto

Ogni adattatore ha un test che invia un compito banale e verifica: formato dell'output, codice d'uscita, gestione dell'errore di quota, timeout, e che il profilo di confinamento sia attivo (canarino). Consumano quota, quindi girano con `pnpm eval:live`, non a ogni commit (`EVALS.md`).

## Tetti per task

Massimo di passi, tempo e costo/quota per task; oltre il tetto il task passa a "Attende te".
