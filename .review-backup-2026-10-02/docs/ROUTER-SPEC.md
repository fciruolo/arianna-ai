# Specifica del router

## Pipeline di scelta

1. **Filtro privacy:** se l'etichetta effettiva (incluse contaminazioni) è L2/L3 → solo esecutori locali.
2. **Filtro budget:** esclude esecutori il cui tetto (passi, tempo, costo/quota) è esaurito.
3. **Stima difficoltà:** un modello locale classifica il passo (`trivial | normal | hard | critical`) con schema vincolato.
4. **Scelta:** tabella di mappatura sotto; se l'esito è insufficiente (test falliti, revisione negativa) si **scala**: Sonnet → Opus → Fable.
5. Ogni decisione è registrata con motivo (spiegabile in HUD).

## Mappatura iniziale (da calibrare con gli eval)

| Tipo di passo | Difficoltà | Esecutore |
| --- | --- | --- |
| Estrazione, classificazione, riassunto di L2 | qualsiasi | Locale (modello piccolo) |
| Pianificazione, giudizio su L2 | qualsiasi | Locale (modello grande) |
| Coding L0/L1 | trivial/normal | Claude Code, Sonnet |
| Coding L0/L1 | hard | Claude Code, Opus (o Codex) |
| Revisione/architettura critica | critical | Fable, dietro approvazione di budget |
| Coding su codice L2 | qualsiasi | Codex con provider locale, oppure modello locale |

## Adattatori degli esecutori

| Esecutore | Invocazione | Note |
| --- | --- | --- |
| Locale | API compatibile OpenAI verso oMLX | Interfaccia sostituibile |
| Claude Code | `claude -p` con `--output-format stream-json`, `--resume`, `--allowedTools` / `--permission-mode`, `--model` | Non usare `--bare`; solo binario ufficiale; nessun token estratto |
| Codex | `codex exec --json` con accesso ChatGPT | Su server headless: device-code, credenziali nel keyring |

## Vincoli sugli abbonamenti

Solo binari ufficiali non modificati, uso personale, mai estrarre o salvare token OAuth. La documentazione Anthropic raccomanda API key per l'Agent SDK; un credito separato per `claude -p` dal 15 giugno 2026 è riportato solo da fonti secondarie: **da verificare nel tuo account prima della Fase 1** (vedi `OPEN-QUESTIONS.md`).

## Test di contratto

Ogni adattatore ha un test che invia un compito banale e verifica: formato dell'output, codice d'uscita, gestione dell'errore di quota, timeout. Si eseguono periodicamente per accorgersi di cambi nei binari.

## Tetti per task

Massimo di passi, tempo e costo/quota per task; oltre il tetto il task passa a "Attende te".
