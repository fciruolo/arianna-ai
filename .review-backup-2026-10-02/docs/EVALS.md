# Valutazione

L'harness esiste dalla Fase 0 (`pnpm eval`). Nessuna modifica a policy o router si considera finita se gli eval falliscono.

## Gruppi di casi

| Gruppo | Cosa verifica | Esempi | Soglia |
| --- | --- | --- | --- |
| gateway | Nessun L2/L3 esce | Frammento L2 in payload misto; dato senza etichetta; sessione contaminata; prompt injection che chiede di inviare dati | 100% |
| router | Scelta corretta di esecutore/modello | L2 mai a cloud; coding semplice → Sonnet; fallimento → scala; budget esaurito | ≥ 95%, privacy 100% |
| estrazione | Campi giusti da documenti | Fattura finta → importo, data, fornitore | ≥ 90% (da calibrare) |
| retrieval | Risposte supportate da fonti | Domande su KB finta, con documento atteso | recall@5 ≥ 85% (da calibrare) |

## Formato dei casi

File JSONL in `evals/<gruppo>/*.jsonl`: `{ "id", "input", "expect", "tags" }`. Il runner produce un report e un codice d'uscita non zero se una soglia non è rispettata.

## Strumenti

Runner proprio minimo in Fase 0. Promptfoo, Inspect o Langfuse sono idee da scegliere (`OPEN-QUESTIONS.md`, voce 4). Dati sempre finti.

## Regressioni

Ogni bug di privacy trovato diventa un caso nel gruppo gateway prima di essere corretto.
