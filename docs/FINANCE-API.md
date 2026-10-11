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

- `GET /api/finance/summary?account=&from=&to=` → `{ months: MonthTotal[], categories: CategoryTotal[], balance: BalancePoint[], yearOverYear: YearOverYear | null }` (dalle funzioni di `@arianna/finance`; `from` e `to` sono giorni `YYYY-MM-DD`, compresi; senza `from`/`to` gli ultimi 12 mesi; `yearOverYear` è sul mese di `to`, o sul mese corrente senza `to`, e `null` senza movimenti in nessuno dei due mesi; senza `account` tutti i conti, e `balance` vuoto perché il saldo è per conto)
- `GET /api/finance/alerts?month=` → `{ alerts: FinanceAlert[] }` (`runChecks` sul mese, predefinito il mese corrente, con i budget salvati)

Le forme `MonthTotal`, `CategoryTotal`, `BalancePoint`, `YearOverYear`, `FinanceAlert` sono quelle esportate da `@arianna/finance` (`packages/finance/src/analysis/`).

## Privacy

- Tabelle `finance_*` nel PostgreSQL locale, etichetta Privato (L2) con fonte `finance:*`; nessuna rotta, strumento o evento le manda a un esecutore cloud, a Telegram, al telefono o in una notifica con contenuto (D-183, regola `finance` del gateway).
- Le conversazioni con l'agente «Finanze» e i loro task hanno il segno `finance` salvato nel database (colonna che non torna mai a false), e il core ricrea i loro contesti con `createContext(..., { finance: true })`.
