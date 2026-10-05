# I-3 — Una pagina "Modelli" sola (proposta)

Proposta per l'idea I-3 di `docs/PROPOSTE.md`, scritta il 2026-10-05 dopo la risposta dell'utente: "troppe pagine sparse, mancano le informazioni dei singoli modelli, di Opus per esempio; manca tutto ChatGPT". Nessun codice dell'app in questo ramo: solo questa pagina e l'anteprima `docs/mockups/arianna-modelli.html` (da aprire in locale, dati di esempio).

Stato: **proposta, da decidere** con le domande in fondo. Quando l'utente risponde, le scelte diventano una decisione D-NNN in `docs/DECISIONS.md`.

## Com'è oggi

Le informazioni su un modello sono divise in sei posti, e nessuno risponde a "che modello è e a cosa mi serve":

| Dove | Cosa c'è | Cosa manca |
| --- | --- | --- |
| `config/models.catalog.yaml` (in git) | Modelli locali: id, famiglia, runtime, `ram_min_gib`, ruoli possibili, stato `experimental`/`verified`, file con URL a commit fisso e sha256 | Descrizione, punti di forza, contesto, licenza in chiaro (oggi solo nei commenti) |
| Impostazioni → **Modelli locali** (`roles`, D-071) | Un menu per ruolo (orchestratore, estrattore, embedder, voce, `stt`, `tts`), con RAM minima, stato e "file presenti/mancanti" | Nessuna azione: per scaricare serve il terminale |
| `pnpm arianna:models list\|verify\|pull` | Confronto con `data/models`, sha256, scaricamento con ripresa | Solo da terminale; nessun "togli" |
| Impostazioni → **Prove dei modelli** (D-081) | Prova in background con gli eval dell'orchestratore, storico con punteggio e mediana | Il risultato non sta accanto al modello; solo il ruolo orchestratore |
| Impostazioni → **Modelli cloud** (`[cloud.models]`, D-071 parte 2) | Interruttore e nome esatto per `sonnet`, `opus`, `fable`, `codex` | Qualsiasi informazione sul modello; Codex "si salva e vale con il suo adattatore" |
| oMLX avviato dal core (D-071 punto 4) e `model-memory.ts` (D-107 tappa E) | Il core sa quali modelli ha fatto caricare, con la stima di RAM del catalogo; scarica i modelli inattivi oltre il budget | Non si vede da nessuna parte; nessun pulsante "scarica dalla memoria" |

A questo si aggiunge il router (`docs/ROUTER-SPEC.md`): gli alias `local-large`, `local-small`, `sonnet`, `opus`, `fable`, `codex` e le scale per tipo di passo. Codex compare nelle scale ma **non è candidato** finché manca l'adattatore (task 1.16): oggi "ChatGPT" in Arianna non esiste.

## La proposta in breve

Una voce **Modelli** nelle Impostazioni, che prende il posto delle tre di oggi (Modelli locali, Prove dei modelli, Modelli cloud). Una pagina con:

1. **Elenco** di tutti i modelli, locali e cloud insieme, uno per riga: nome, fornitore, dove gira (Mac / cloud), ruoli o alias assegnati, stato (in memoria, sul disco, da scaricare, spento, non collegato), ultimo esito della prova.
2. **Filtri** in alto: Tutti · Locali · Cloud; per fornitore (Qwen, Anthropic, OpenAI, Mistral…); per ruolo; "solo quelli in uso". Un campo di ricerca sul nome.
3. **Scheda del modello** a destra (sotto, sul telefono) quando se ne sceglie uno.
4. In cima, una riga di sintesi: memoria usata dai modelli locali sul budget (es. "21 di 24 GiB"), quota dell'abbonamento Claude nella finestra di 5 ore e della settimana, stato del collegamento Codex.

Le sezioni "Modelli locali per ruolo" e "Modelli cloud" non spariscono come funzione: diventano la parte "Ruoli" e "Interruttori" dentro la stessa pagina (un riquadro compatto in cima o in fondo), con le stesse regole di salvataggio di D-071 (impronta del file, 409 se cambiato).

## La scheda di un modello

Campi comuni:

| Campo | Locali | Cloud | Da dove arriva |
| --- | --- | --- | --- |
| Nome e id | `qwen3.8-27b-4bit` | `opus` → nome esatto se scelto | catalogo; `[cloud.models]` |
| Fornitore e famiglia | Qwen (Alibaba), `qwen3.8` | Anthropic, Claude Opus | catalogo |
| Contesto | 32k / 128k come servito da oMLX | es. 200k; 1M con la variante `[1m]` | catalogo (fonte scritta) |
| Punti di forza | 2-4 righe brevi | 2-4 righe brevi | catalogo (testo scritto a mano) |
| Uso tipico in Arianna | "orchestratore (`local-large`): pianifica, giudica, risponde come Arianna" | "coding difficile, architettura; secondo gradino della scala di coding" | generato dalle regole del router e dai ruoli, non scritto a mano |
| Ruoli / alias assegnati | ruoli di `[roles]` | alias, agenti che partono con questo modello (`[agents.<id>] model`) | `arianna.toml` |
| Costo | RAM, energia (nessun costo in euro) | consumo della quota dell'abbonamento | vedi sotto |
| Prove | ultimo esito, punteggio, mediana, pesi provati | esito del contratto e del canarino (`pnpm eval:live`) se fatti | `model_evals` (D-081); rapporti `data/evals/` |
| Licenza | es. Apache-2.0, CC BY-NC 4.0 per Voxtral | condizioni del fornitore (link) | catalogo |
| Privacy | "gira sul Mac: può leggere L2/L3" | "esce verso il cloud: solo L0/L1, passa dal gateway" | regola fissa |

Solo locali: peso su disco (somma di `size_bytes`), RAM minima, runtime, stato `experimental`/`verified`, file presenti e verificati (data dell'ultima verifica sha256), **stato in memoria di oMLX** (caricato da Arianna / non caricato, ultimo uso, chi lo sta usando).

Solo cloud: esecutore (`claude` o `codex`), binario installato e versione, accesso fatto (sì/no, mai il token), alias e nome esatto passati a `--model`, se richiede approvazione di budget (Fable), ultimo modello che il binario ha dichiarato di usare (evento `executor.model`, L0).

### Il costo in quota dell'abbonamento

Gli abbonamenti non hanno un prezzo per richiesta: il costo vero è quanto un lavoro consuma della finestra di 5 ore e della settimana. Due numeri, entrambi L0:

- **Misurato da Arianna:** `claude -p` riporta a ogni run la percentuale usata della finestra (`executor.rate_limit`, D-049). La differenza fra l'inizio e la fine di un run, divisa per modello, dà una mediana "un lavoro di coding con Opus consuma circa il 4% della finestra di 5 ore". Più run in parallelo sporcano la misura: la scheda lo dice e mostra anche i token (`runs.tokens_in`, `tokens_out`). Per Codex lo stesso, se il binario riporta i limiti (da verificare con 1.16).
- **Indicazione del fornitore:** un rapporto relativo scritto nel catalogo cloud con la sua fonte (es. "Opus consuma la quota circa N volte più di Sonnet, fonte: pagina dei piani del <data>"). Se la fonte non c'è, il campo resta vuoto: niente numeri inventati.

## Le azioni

| Azione | Dove | Cosa fa | Conferma |
| --- | --- | --- | --- |
| **Scarica** | locale non presente | come `pnpm arianna:models pull`, ma come job in background del core (coda `jobs`), con avanzamento, ripresa e verifica sha256; solo URL del catalogo | sì, con il peso ("scarica 16 GB") |
| **Verifica** | locale presente | ricalcola gli sha256; un file sbagliato si offre di riscaricarlo | no |
| **Togli dal disco** | locale presente, non assegnato a un ruolo | sposta i file in `data/models/eliminati/<data>-<id>/` (come gli agenti eliminati), poi si svuota a mano o dopo N giorni | sì: scrivere il nome del modello; rifiutato se un ruolo lo usa o una prova è aperta |
| **Scarica dalla memoria** | locale caricato | `unload` su oMLX (già in `model-memory.ts`); rifiutato se una richiesta lo sta usando | no |
| **Assegna a un ruolo** | locale | menu con i ruoli possibili dal catalogo; stessa scrittura di oggi | no (come oggi, "si applica subito") |
| **Accendi / spegni** | cloud | come l'interruttore di `[cloud.models]` | no; accendere un **esecutore** resta nella sezione privacy "Esecutori cloud" con la sua scheda di conferma |
| **Nome esatto** | cloud | come oggi, sempre della famiglia dell'alias | no |
| **Prova** | locale con ruolo orchestratore (oggi); poi estrattore | avvia la prova di D-081, risultato nella scheda | no |

Nessuna azione accende un esecutore cloud o allarga ciò che esce: quelle restano nelle sezioni di privacy con conferma (D-071 punto 3).

## ChatGPT e Codex accanto a Claude

"Manca tutto ChatGPT" ha una sola strada ammessa dalle regole: il binario ufficiale `codex`, con l'accesso ChatGPT fatto dall'utente a mano (mai API key, mai token). Quindi "ChatGPT in Arianna" vuol dire **i modelli che `codex` accetta con `--model`**, non la chat di chatgpt.com. Cosa serve, in ordine:

1. **Binario `codex`** installato e accesso fatto dall'utente (manca: `docs/PHASE-0-1-TASKS.md` lo segna dal task 0).
2. **Task 1.16:** adattatore `codex exec --json` in `packages/executors`, con lo stesso profilo di confinamento di Claude (D-049/D-050), test di contratto e canarino in `pnpm eval:live`. Stima già scritta: 4-7 h.
3. **Router:** `routerConfigOf` aggiunge `codex` ai candidati quando `codex` è in `[cloud] executors` e l'alias non è spento; le scale lo prevedono già (coding: `sonnet`, poi `opus` o `codex`; revisione: `codex` o `sonnet` per primi). Eval del router con casi positivi e negativi per il nuovo candidato.
4. **Alias:** uno solo, `codex`, con il nome esatto per scegliere il modello (`codex = "<nome>"`), come Claude. Se servono due livelli (uno veloce e uno forte), un secondo alias va deciso (domanda 3).
5. **Schede:** nel catalogo cloud le voci OpenAI con contesto, punti di forza e fonti; finché 1.16 non c'è, la scheda mostra "non collegato: manca l'adattatore (1.16)" invece di sparire.
6. **Quota:** gli eventi di limite di `codex` (formato da verificare sul binario) in `executor.rate_limit`, così la riga di sintesi mostra anche la quota ChatGPT.

## Da dove arrivano i dati delle schede

- **Locali:** `config/models.catalog.yaml`, in git, come oggi. Si aggiungono campi facoltativi: `provider`, `context_tokens`, `strengths` (2-4 righe), `license`, `notes`, `source` (link alla pagina del modello). La validazione di `@arianna/config` li accetta facoltativi, così il catalogo di oggi resta valido.
- **Cloud:** un file nuovo `config/cloud-models.catalog.yaml`, in git, **scritto a mano**: per ogni alias fornitore, famiglia, esecutore, contesto, punti di forza, consumo relativo, approvazione di budget, e per ogni dato la sua **fonte** (URL e data di lettura). Lo aggiorna l'utente o Claude Code su richiesta, con un commit come ogni altro file.
- **Mai scaricato a runtime da internet:** né il catalogo né le descrizioni. Il core non chiama pagine dei fornitori, Hugging Face o model card per riempire le schede. L'unica rete della pagina è lo scaricamento dei pesi, dagli URL a commit fisso del catalogo, quando l'utente lo chiede.
- **Misurati da Arianna:** presenza e verifica dei file, memoria di oMLX, prove (D-081), consumo di quota per run, modello dichiarato dal binario. Tutto già nel database o nei file locali, tutto L0.
- **Generati dal codice:** "uso tipico in Arianna" esce dalle regole del router e da `[roles]`/`[agents]`, così non va mai fuori sincrono con il comportamento vero.

## Privacy

- Tutto ciò che mostra la pagina è **L0**: id di catalogo, numeri, esiti di prove su casi finti, percentuali di quota. Nessun testo di conversazione, nessun brief.
- La pagina non cambia chi può ricevere dati: accendere un esecutore cloud, i progetti e Telegram restano nelle sezioni di privacy con scheda di conferma. Spegnere un modello cloud o assegnare un ruolo locale non fa uscire niente.
- I nomi esatti dei modelli cloud vanno solo a `--model` del binario ufficiale; nessun token o credenziale passa dalla pagina. Lo stato "accesso fatto" si legge dall'esito del binario (es. errore di accesso), mai leggendo i file delle credenziali.
- "Togli dal disco" è irreversibile per i pesi (si riscaricano, ma sono GB): conferma con il nome e cestino in `data/models/eliminati/`. Un evento `model.removed` (L0) nel registro.
- Lo scaricamento dei pesi avviene solo da URL del catalogo in git, a commit fisso, con sha256 verificato; un URL che il catalogo non conosce è rifiutato.

## Piano a tappe

| Tappa | Cosa | Stima |
| --- | --- | --- |
| M1 | Campi nuovi facoltativi di `models.catalog.yaml`; `config/cloud-models.catalog.yaml` con lettore e validazione in `@arianna/config` (test positivi e negativi), voci di Sonnet, Opus, Fable e Codex con fonti | 3-4 h |
| M2 | API `GET /api/models`: elenco unico (catalogo locale e cloud, presenza file, ruoli, agenti, ultima prova, memoria di oMLX, interruttori, uso tipico calcolato dal router) | 4-6 h |
| M3 | Pagina **Modelli** nella chat: elenco con filtri e ricerca, scheda, ruoli e interruttori dentro la pagina; via le tre voci vecchie (gli indirizzi vecchi rimandano alla nuova) | 6-9 h |
| M4 | Azioni locali: scarica (job con avanzamento), verifica, togli (cestino, conferma), scarica dalla memoria; eventi L0 | 6-8 h |
| M5 | Costo in quota misurato per modello (differenza degli eventi `executor.rate_limit` per run, mediana, token) | 3-4 h |
| M6 | ChatGPT/Codex: task 1.16 (adattatore, profilo, contratto, canarino), candidato nel router con eval, schede collegate, quota di Codex | 6-10 h (1.16 compreso) |

Totale: **28-41 h**. M1-M3 danno già la pagina unica con le schede (anche di Opus) e la scheda di Codex "non collegato"; M4-M6 si possono fare in qualsiasi ordine dopo.

## Scelte dell'utente (2026-10-05, sera)

Tutte e quattro sulle opzioni consigliate: una voce sola **Modelli** (le tre vecchie spariscono e i loro indirizzi portano alla nuova); dati delle schede cloud in `config/cloud-models.catalog.yaml` scritto a mano, con fonte e data per ogni dato, più i numeri misurati da Arianna; prima la pagina (Codex "non collegato"), poi il task 1.16 con un solo alias `codex`; "Togli dal disco" sposta nel cestino `data/models/eliminati`, con conferma scrivendo il nome e "Svuota il cestino" nella pagina.
