# API delle Finanze (I-18, D-183)

Contratto fra il core (`apps/core`) e la pagina «Finanze» della chat web (`apps/hud`). Tutte le rotte stanno sotto `/api/finance/`, solo loopback e stessa origine come le altre rotte del core. Importi sempre in **centesimi interi**, giorni `YYYY-MM-DD`, mesi `YYYY-MM`, nomi dei campi JSON in camelCase. Le risposte non portano mai testi fuori dalla macchina: la pagina li mostra in locale. Eventi e log del core portano solo id e conteggi.

Errori: `{ "error": "<codice>" }` con lo stato HTTP (400 richiesta sbagliata, 404 non trovato, 409 conflitto, 413 file troppo grande). I codici d'errore dell'importazione sono quelli di `ImportErrorCode` di `@arianna/finance`; la pagina li traduce in italiano. Un errore dell'importazione legato a una riga del file porta anche `line`: `{ "error": "<codice>", "line": 12 }`.

## Conti

- `GET /api/finance/accounts` → `{ accounts: Account[] }`
- `POST /api/finance/accounts` `{ name, currency? }` → `201 { account: Account }` (nome di una riga, 1-80 caratteri; `currency` ISO 4217, predefinita `EUR`)
- `PATCH /api/finance/accounts/:id` `{ name?, archived? }` → `{ account: Account }`

`Account = { id, name, currency, profile: BankProfile | null, archived: boolean, transactions: number, lastBooked: Day | null }`. `profile` è il profilo della banca ricordato all'ultima importazione.

## Importazione

- `POST /api/finance/imports/preview` `{ account, name, data, profile?, sheet? }` → `{ preview: Preview }`. `data` è il file in base64 (al più 10 MiB decodificati, altrimenti 413). Nulla viene salvato. Colonne non riconosciute (o nessuna riga che le nomini) senza `profile`: **non** è un errore, risposta 200 con `profile: null`, `guessed: false` e `header` (le celle della riga d'intestazione trovata, o della prima riga non vuota), così l'utente sceglie le colonne. Un `profile` (per esempio quello salvato sul conto) che non corrisponde al file: errore `profile-mismatch` (400), e la pagina rifà l'anteprima senza profilo.
- `POST /api/finance/imports` `{ account, name, data, profile, sheet? }` → `201 { import: ImportRecord }`. Rilegge il file con il profilo confermato, salva le righe nuove, salta i doppioni (stessa impronta già nel conto), salva il profilo sul conto. Il file **non** viene conservato.
- `GET /api/finance/imports?account=` → `{ imports: ImportRecord[] }`
- `DELETE /api/finance/imports/:id` → `204`: toglie le righe entrate con quell'importazione (annulla).

`Preview = { kind: 'csv' | 'xlsx', sheets: string[] | null, sheet: string | null, profile: BankProfile | null, guessed: boolean, headerLine: number | null, header: string[], newestFirst: boolean, rows: PreviewRow[], duplicates: number, rejected: { line, code }[], totals: { count, income, expenses } }`; `rows` sono al più le prime 200 righe nuove, `PreviewRow = { line, booked, value, description, amount, currency, balance }`.

`ImportRecord = { id, account, name, at, imported, duplicates, rejected }` (`name` è il nome del file scelto dall'utente, `at` ISO 8601).

## Movimenti

- `GET /api/finance/transactions?account=&from=&to=&category=&uncategorized=1&q=&fingerprints=&limit=&offset=` → `{ transactions: Tx[], total }` (dal più recente; `limit` predefinito 100, massimo 500; `q` cerca nella descrizione senza maiuscole né accenti; `category=` un id; `fingerprints=` impronte separate da virgole, al più 50, per aprire i movimenti di un avviso)
- `PATCH /api/finance/transactions/:id` `{ category: string | null, rule?: boolean }` → `{ transaction: Tx, rule: Rule | null }`. La categoria scelta dall'utente (`by: 'user'`); con `rule: true` crea anche la regola proposta da `ruleFromConfirmation` e la applica alle righe senza categoria dell'utente.

`Tx = { id, account, booked, value, description, amount, currency, balance, category: string | null, by: 'rule' | 'user' | null, importId, fingerprint }`.

## Categorie, regole, budget

- `GET /api/finance/categories` → `{ categories: Category[] }`; `POST` `{ name, kind: 'out' | 'in' }` → `201 { category }`; `PATCH /:id` `{ name? }`; `DELETE /:id` → `204` (le righe tornano senza categoria, le regole e il budget della categoria spariscono).
- `GET /api/finance/rules` → `{ rules: Rule[] }`; `POST` `{ match, category }` → `201 { rule }`; `DELETE /:id` → `204`. Dopo ogni cambio di regole il core riapplica `categorize` a tutte le righe (quelle `by: 'user'` restano).
- `GET /api/finance/budgets` → `{ budgets: Budget[] }`; `PUT /api/finance/budgets/:category` `{ monthly }` → `{ budget }`; `DELETE /api/finance/budgets/:category` → `204`.

`Category = { id, name, kind }`, `Rule = { id, match, category }`, `Budget = { category, monthly }`. Alla prima apertura il core crea un insieme di categorie comuni in italiano (Spesa, Casa, Bollette, Trasporti, Ristoranti, Salute, Abbonamenti, Svago, Stipendio, Altre entrate…), modificabili.

## Riepilogo e controlli

- `GET /api/finance/summary?account=&from=&to=` → `{ months: MonthTotal[], categories: CategoryTotal[], balance: BalancePoint[], yearOverYear: YearOverYear | null }` (dalle funzioni di `@arianna/finance`; `from` e `to` sono giorni `YYYY-MM-DD`, compresi; senza `from`/`to` gli ultimi 12 mesi; `yearOverYear` è sull'ultimo mese del periodo che ha movimenti (senza movimenti, sul mese di `to` o sul mese corrente), e `null` senza movimenti in nessuno dei due mesi confrontati; senza `account` tutti i conti, e `balance` vuoto perché il saldo è per conto)
- `GET /api/finance/alerts?month=` → `{ alerts: FinanceAlert[] }` (`runChecks` sul mese, predefinito il mese corrente, con i budget salvati)

Le forme `MonthTotal`, `CategoryTotal`, `BalancePoint`, `YearOverYear`, `FinanceAlert` sono quelle esportate da `@arianna/finance` (`packages/finance/src/analysis/`).

## Fatture e scadenze (D-310)

Fatture elettroniche FatturaPA (formato 1.2, FPR12 e FPA12; la semplificata FSM10 non si legge ancora), lette da `@arianna/invoices` (`packages/invoices`) con `fast-xml-parser`. Il file **non** viene conservato: solo i dati letti, con il nome scelto dall'utente. Un `.xml.p7m` (DER o base64) si apre con l'openssl di sistema senza verificare la firma.

- `POST /api/finance/invoices` `{ name, data }` → `201 { imported: InvoiceSummary[], duplicates }`. `data` è il file in base64 (al più 10 MiB decodificati, altrimenti 413). Tutte le fatture del file o nessuna; una fattura già presente (stessa impronta: fornitore, tipo, numero e data) è contata in `duplicates` e saltata.
- `GET /api/finance/invoices?from=&to=&q=` → `{ invoices: InvoiceSummary[] }` (dalla più recente, al più 500; `from`/`to` giorni o mesi come per i movimenti, sulla data della fattura; `q` cerca nei nomi di fornitore e cliente e nel numero, senza maiuscole)
- `GET /api/finance/invoices/:id` → `{ invoice: InvoiceDetail }`
- `DELETE /api/finance/invoices/:id` → `204`: toglie la fattura con righe e rate (`fatturapa_delete`).
- `GET /api/finance/deadlines?status=open|all` → `{ deadlines: Deadline[] }`: le rate (`DettaglioPagamento`), predefinito `open` (non pagate); per data di scadenza, quelle senza data in fondo; al più 1000.
- `PATCH /api/finance/deadlines/:id` `{ paidOn: Day | null }` → `{ deadline: Deadline }`: segna la rata pagata in quel giorno, o di nuovo aperta.

`InvoiceSummary = { id, fileName, signed, documentType, number, issuedOn, currency, totalCents: number | null, taxableCents, vatCents, supplier: Party, customer: Party, open, openCents, importedAt }` con `Party = { name, vat: string | null, taxCode: string | null }` (`vat` è paese più codice, per esempio `IT12345678901`); `open` e `openCents` sono il numero e la somma delle rate non pagate. `InvoiceDetail = InvoiceSummary & { format: 'FPR12' | 'FPA12', lines: Line[], vatSummary: VatRow[], payments: Deadline[] }`, `Line = { number, description, quantity: string | null, unitPrice: string, totalCents, vatRate: string, nature: string | null }` (quantità e prezzo come scritti nel file, fino a 8 decimali; `vatRate` come `22.00`), `VatRow = { vatRate, nature, taxableCents, vatCents }`. `Deadline = { id, invoice, method, dueOn: Day | null, amountCents, paidOn: Day | null, currency, documentType, number, issuedOn, supplier, customer }` (`method` è `ModalitaPagamento`, per esempio `MP05` bonifico; `supplier` e `customer` sono i nomi).

Codici d'errore della lettura (`InvoiceErrorCode` di `@arianna/invoices`): `too-large` (413), `not-xml`, `doctype` (DOCTYPE o dichiarazione di entità, rifiutati prima della lettura), `bad-xml`, `not-fatturapa`, `unsupported`, `bad-field` (manca o è sbagliato un campo obbligatorio), `too-many` (più di 200 fatture in un file, 5000 righe o 100 rate in una fattura), `bad-signature` (il `.p7m` non si apre). Eventi `invoice.imported`, `invoice.payment.updated`, `invoice.deleted` con soli id e conteggi.

## Privacy

- Tabelle `finance_*` nel PostgreSQL locale, etichetta Privato (L2) con fonte `finance:*`; nessuna rotta, strumento o evento le manda a un esecutore cloud, a Telegram, al telefono o in una notifica con contenuto (D-183, regola `finance` del gateway).
- Tabelle `fatturapa_invoices`, `fatturapa_lines` e `fatturapa_payments` (D-310, migrazione 0095), etichetta almeno Privato (L2): le legge solo la pagina «Finanze»; nessun modello, strumento della chat, agente o canale le legge, e gli eventi portano solo id e conteggi.
- Le conversazioni con l'agente «Finanze» e i loro task hanno il segno `finance` salvato nel database (colonna che non torna mai a false), e il core ricrea i loro contesti con `createContext(..., { finance: true })`.
