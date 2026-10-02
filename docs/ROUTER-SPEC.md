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
| Revisione/architettura critica | critical | Fable, dietro approvazione di budget |
| Coding su codice L2 | qualsiasi | Modello locale; Codex con provider locale solo dopo verifica (vedi `PRIVACY-POLICY-SPEC.md`) |

I nomi dei modelli sono alias in `arianna.toml` (`sonnet`, `opus`, `fable`, `local-large`, `local-small`), mai cablati nel codice.

## Adattatori degli esecutori (`packages/executors`)

| Esecutore | Invocazione | Note |
| --- | --- | --- |
| Locale | API compatibile OpenAI verso oMLX (`createLocalModel`, task 1.3) | Interfaccia sostituibile `LocalModel`; solo endpoint di loopback; endpoint in ordine di preferenza con ripiego sul successivo se il server è giù, bloccato o in errore 5xx; `Watchdog` con controllo di salute e riavvio automatico (D-033) |
| Claude Code | `claude -p` con `--output-format stream-json`, `--resume`, `--allowedTools` / `--permission-mode`, `--model` | Non usare `--bare`; solo binario ufficiale; nessun token estratto; sempre con il profilo di confinamento |
| Codex | `codex exec --json` con accesso ChatGPT | Su server headless: device-code, credenziali nel keyring; stesso profilo di confinamento |

Interfaccia comune: `start(brief, workspace, limits) → flusso di eventi`, `resume(sessionRef)`, `cancel()`. Il `sessionRef` è l'id di sessione restituito dal binario, mai una credenziale.

## Budget e quote

Le quote degli abbonamenti non sono interrogabili: il router le stima e reagisce.

- **Contabilità propria:** ogni run registra durata, passi e token riportati dal flusso; i tetti in `arianna.toml` valgono per task e per finestra mobile (giorno, settimana).
- **Reazione ai limiti:** l'errore di quota del binario è un esito previsto dal test di contratto; il router mette il task in attesa con ripresa pianificata o scende di modello, e avvisa.
- Fable solo dietro approvazione di budget.

## Vincoli sugli abbonamenti

Solo binari ufficiali non modificati, uso personale, mai estrarre o salvare token OAuth. La documentazione Anthropic raccomanda API key per l'Agent SDK; un credito separato per `claude -p` dal 15 giugno 2026 è riportato solo da fonti secondarie: **da verificare nel tuo account prima del task 1.5** (vedi `OPEN-QUESTIONS.md`).

## Test di contratto

Ogni adattatore ha un test che invia un compito banale e verifica: formato dell'output, codice d'uscita, gestione dell'errore di quota, timeout, e che il profilo di confinamento sia attivo (canarino). Consumano quota, quindi girano con `pnpm eval:live`, non a ogni commit (`EVALS.md`).

## Tetti per task

Massimo di passi, tempo e costo/quota per task; oltre il tetto il task passa a "Attende te".
