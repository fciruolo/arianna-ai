# Formato degli IM (definitivo, D-167)

Dati inventati. Un IM è un file Markdown nella cartella `IM/` delle cartelle di gestione del progetto (nel contenitore, o in `kb/progetti/<progetto>/IM` per un progetto di un git solo). Si legge e si modifica anche a mano in Obsidian o in un editor: Arianna non usa un formato suo nascosto.

## Regole

- **Nome del file:** `IM-<numero>.md`, senza zeri davanti (`IM-32.md`, `IM-33.md`, `IM-100.md`); Arianna li ordina per numero.
- **Intestazione:** `im` (numero), `data` (giorno e ora della riunione), `stato` (`previsto`, `in corso`, `chiuso`). Facoltativo `chiamata` (giorno e ora della call quando si sposta con il cliente: sposta solo promemoria e chiusura, non la data dell'IM né l'IM successivo). Facoltativa `label: L2` per una riunione privata: alza l'etichetta, non l'abbassa (la cartella IM è Interna, L1).
- **Sezione `## Lavori`:** una voce per riga, con la casella che dice lo stato:
  - `- [ ]` da fare
  - `- [/]` in corso
  - `- [x]` fatto
  - `- [>]` rimandato all'IM successivo (Arianna lo ricopia là come `- [ ]`)
  - `- [-]` annullato (tolto dal cliente)
  
  Sono le caselle del plugin Tasks di Obsidian, quindi si vedono bene anche lì.
- **Lavori a parti:** `— Parte N` alla fine del titolo. Se a fine IM una voce è fatta solo in parte, nell'IM successivo nasce `— Parte N+1`, e quella vecchia si chiude come fatta.
- **Collegamento a una card del cardwall:** facoltativo, `#card-<sigla>` alla fine della voce, con le prime 8 cifre dell'id della card (per esempio `#card-3f9a1c2e`). Quando la card arriva in "Fatto", Arianna spunta la voce.
- **Sezione `## Report`:** il resoconto per il cliente. Arianna ne scrive una bozza dalle voci fatte e dal diario dei lavori della settimana; tu la correggi.
- **Sezione `## Note`:** appunti liberi della riunione.
- Le sezioni che Arianna non conosce restano come sono.

## Esempio: IM-32 (chiuso)

```markdown
---
im: 32
data: 2026-10-08 10:00
stato: chiuso
---

# IM-32 · giovedì 8 ottobre 2026, 10:00

## Lavori

- [x] Pagamento con carta — Parte 1 #card-3f9a1c2e
- [x] Pagina dei contratti: filtro per anno
- [>] Esportazione degli ordini in CSV
- [-] Tema scuro dell'area riservata

## Report

Questa settimana abbiamo collegato il pagamento con carta (prima parte: carrello e
conferma) e aggiunto il filtro per anno nella pagina dei contratti. L'esportazione
in CSV passa al prossimo incontro.

## Note

- Il cliente rinuncia al tema scuro per ora.
- Per il prossimo IM chiede le fatture.
```

## Esempio: IM-33 (previsto)

```markdown
---
im: 33
data: 2026-10-15 10:00
stato: previsto
---

# IM-33 · giovedì 15 ottobre 2026, 10:00

## Lavori

- [ ] Pagamento con carta — Parte 2
- [ ] Esportazione degli ordini in CSV
- [ ] Fatture

## Report

## Note
```

## Cosa farebbe Arianna

1. **Calendario degli IM:** ogni IM nuovo cade sette giorni dopo la `data` dell'ultimo, alla stessa ora; una call spostata si scrive in `chiamata` e non cambia niente del calendario.
2. **"Per il prossimo IM: le fatture"** in chat: Arianna aggiunge `- [ ] Fatture` all'IM successivo (e lo crea se non c'è ancora).
3. **Chiusura dell'IM:** il giorno della riunione, per ogni voce non spuntata Arianna ti chiede "È finita?" con tre risposte: fatta, in parte (nasce la Parte N+1), non fatta (passa all'IM successivo). Poi crea l'IM successivo con le voci rimaste.
4. **Promemoria** dalla segretaria: il giorno prima dell'IM, le voci ancora aperte.
5. **Bozza del report** dalle voci fatte e dal diario dei lavori.
6. **Vista IM nel cardwall:** per un IM scelto, le colonne Da fare, In corso, Fatto, Rimandato, Annullato, con le voci e le card collegate.
7. **Il Coder legge gli IM** come le altre note interne (D-166): sa cosa è previsto per questa settimana.
